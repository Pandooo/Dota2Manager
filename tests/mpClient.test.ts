// 多人客户端：net.ts 地址/参数工具、uiActions 便捷引擎操作、store.call 的单机/多人路由
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState } from '../src/engine/types';
import { createNewGame } from '../src/engine/game';
import {
  autoArrangeLineup, dismissPopups, markNewsRead, setPlayerAsStarter,
} from '../src/engine/uiActions';
import { POSITIONS } from '../src/engine/types';
import { RPC_WHITELIST, isRoomHost, mySeat } from '../src/shared/protocol';
import * as engine from '../src/engine';
import { importSave } from '../src/engine/save';
import { net, normalizeServerAddress, onRequestError, trimArgs } from '../src/store/net';
import type { ClientMsg, RoomInfo, ServerMsg } from '../src/shared/protocol';
import { useGameStore } from '../src/store/gameStore';
import { registerNodeRosterLoader } from '../scripts/nodeData';

registerNodeRosterLoader();

describe('net · 服务器地址与参数', () => {
  it('ip:端口 / 纯 ip / http / ws 地址规范化为 ws://…/ws', () => {
    expect(normalizeServerAddress('192.168.1.5:8686')).toBe('ws://192.168.1.5:8686/ws');
    expect(normalizeServerAddress('192.168.1.5')).toBe('ws://192.168.1.5:8686/ws');
    expect(normalizeServerAddress('http://host.local:9000')).toBe('ws://host.local:9000/ws');
    expect(normalizeServerAddress('ws://10.0.0.2:1234/ws')).toBe('ws://10.0.0.2:1234/ws');
    expect(normalizeServerAddress('   ')).toBeNull();
  });

  it('去掉末尾 undefined 参数（JSON 会把数组里的 undefined 变成 null）', () => {
    expect(trimArgs([1, undefined, undefined])).toEqual([1]);
    expect(trimArgs([undefined, 2])).toEqual([undefined, 2]);
    expect(trimArgs([])).toEqual([]);
  });

  it('RPC 白名单中的函数都由引擎导出（单机 call 本地执行时可找到）', () => {
    for (const fn of RPC_WHITELIST) expect(typeof (engine as unknown as Record<string, unknown>)[fn], fn).toBe('function');
  });
});

describe('uiActions · 便捷引擎操作', () => {
  let g: GameState;
  beforeAll(async () => {
    g = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: '测试', teamId: 'og', seed: 7 });
  });

  it('markNewsRead 只标记指定新闻', () => {
    const [a, b] = g.news;
    a.read = false;
    b.read = false;
    markNewsRead(g, a.id);
    expect(a.read).toBe(true);
    expect(b.read).toBe(false);
    markNewsRead(g, 'no-such-id');
  });

  it('dismissPopups 关闭最前面的 n 个弹窗', () => {
    g.popups = [
      { kind: 'message', title: '1', body: '' },
      { kind: 'message', title: '2', body: '' },
      { kind: 'message', title: '3', body: '' },
    ];
    dismissPopups(g, 2);
    expect(g.popups.map((p) => (p.kind === 'message' ? p.title : ''))).toEqual(['3']);
    dismissPopups(g, 5);
    expect(g.popups).toEqual([]);
  });

  it('setPlayerAsStarter 把选手放到本位置首发', () => {
    const team = g.teams[g.settings.playerTeamId];
    const bench = team.playerIds.map((id) => g.players[id]).find((p) => !POSITIONS.some((pos) => team.lineup[pos] === p.id));
    const target = bench ?? g.players[team.playerIds[0]];
    const r = setPlayerAsStarter(g, target.id);
    expect(r.ok).toBe(true);
    expect(team.lineup[target.position]).toBe(target.id);
    expect(setPlayerAsStarter(g, 'ghost').ok).toBe(false);
  });

  it('autoArrangeLineup 报告排阵前后评分', () => {
    const r = autoArrangeLineup(g, null);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/已自动排阵：战队评分 [\d.]+ → [\d.]+/);
  });
});

describe('store.call · 单机 / 多人路由', () => {
  it('单机：本地同步执行引擎函数并 version++', async () => {
    const g = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: '测试', teamId: 'og', seed: 9 });
    const n = g.news[0];
    n.read = false;
    useGameStore.setState({ game: g, mode: 'single', version: 0 });
    const p = useGameStore.getState().callSilent('markNewsRead', n.id);
    // 单机在调用返回前就已执行完毕（与原先的 act 一致）
    expect(n.read).toBe(true);
    expect(useGameStore.getState().version).toBe(1);
    await p;
    const r = await useGameStore.getState().call('autoArrangeLineup', null);
    expect(r?.ok).toBe(true);
    expect(useGameStore.getState().version).toBe(2);
  });

  it('多人：未连接时不在本地修改状态，提示并返回 undefined', async () => {
    const g = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: '测试', teamId: 'og', seed: 11 });
    const n = g.news[0];
    n.read = false;
    useGameStore.setState({ game: g, mode: 'multi', version: 0, toasts: [] });
    const r = await useGameStore.getState().call('markNewsRead', n.id);
    expect(r).toBeUndefined();
    expect(n.read).toBe(false);
    expect(useGameStore.getState().toasts.some((t) => !t.ok)).toBe(true);
    // act 在多人模式下拒绝本地修改
    expect(useGameStore.getState().act((s) => markNewsRead(s, n.id))).toBeUndefined();
    expect(n.read).toBe(false);
    useGameStore.setState({ game: null, mode: 'single', toasts: [] });
  });
});

// ---------------------------------------------------------------------------
// 多人：用替身连接驱动 store（不连服务器）
// ---------------------------------------------------------------------------
describe('store · 多人客户端（替身连接）', () => {
  const sent: ClientMsg[] = [];
  const netAny = net as unknown as {
    send: (m: ClientMsg) => boolean;
    disconnect: () => void;
    msgListeners: Set<(m: ServerMsg) => void>;
  };
  const origSend = netAny.send;
  const origDisconnect = netAny.disconnect;
  const deliver = (m: ServerMsg) => netAny.msgListeners.forEach((fn) => fn(m));
  const room = (status: RoomInfo['status']): RoomInfo => ({
    id: 'ABC123', name: '测试房', hostSeatKey: 'k1', yourSeatKey: 'k1', maxPlayers: 2, status,
    settings: { startTi: 9, endTi: 9, difficulty: 'normal', mode: 'build' },
    seats: [{ seatKey: 'k1', name: 'alice', connected: true, lobbyReady: true, gameTeamId: 'og' }],
    createdAt: new Date(0).toISOString(),
  });
  let g: GameState;

  beforeAll(async () => {
    g = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: '测试', teamId: 'og', seed: 13 });
    Object.defineProperty(net, 'isOpen', { configurable: true, get: () => true });
    netAny.send = (m: ClientMsg) => {
      sent.push(m);
      return true;
    };
    netAny.disconnect = () => undefined;
  });

  const reset = (patch: Partial<ReturnType<typeof useGameStore.getState>>) => {
    sent.length = 0;
    useGameStore.setState({ mode: 'multi', screen: 'game', game: g, toasts: [], ...patch });
  };

  it('相同操作在途时不重复发送（连点不会执行两次），两次调用拿到同一结果', async () => {
    reset({});
    const p1 = useGameStore.getState().call('buyExtraTraining');
    const p2 = useGameStore.getState().call('buyExtraTraining');
    const calls = sent.filter((m): m is Extract<ClientMsg, { t: 'call' }> => m.t === 'call');
    expect(calls).toHaveLength(1);
    deliver({ t: 'callResult', reqId: calls[0].reqId, ok: false, message: '金币不足' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    // 回应之后可以再次发送
    void useGameStore.getState().call('buyExtraTraining');
    expect(sent.filter((m) => m.t === 'call')).toHaveLength(2);
    const last = sent.filter((m): m is Extract<ClientMsg, { t: 'call' }> => m.t === 'call')[1];
    deliver({ t: 'callResult', reqId: last.reqId, ok: false, message: '金币不足' });
  });

  it('不在房间内时忽略在途的旧状态快照（离开房间后不会被拉回对局）', () => {
    useGameStore.setState({ mp: { ...useGameStore.getState().mp, room: null } });
    reset({ screen: 'lobby', game: null });
    deliver({ t: 'state', version: 5, state: g });
    expect(useGameStore.getState().screen).toBe('lobby');
    expect(useGameStore.getState().game).toBeNull();
  });

  it('对局已结束时「返回主菜单」会离开房间（再次进入大厅不会回到已结束的对局）；进行中的对局保留座位', () => {
    reset({});
    useGameStore.setState({ mp: { ...useGameStore.getState().mp, room: room('finished') } });
    useGameStore.getState().quitToMenu();
    expect(sent.some((m) => m.t === 'leaveRoom')).toBe(true);
    expect(useGameStore.getState().mode).toBe('single');

    reset({});
    useGameStore.setState({ mp: { ...useGameStore.getState().mp, room: room('playing') } });
    useGameStore.getState().mpExit();
    expect(sent.some((m) => m.t === 'leaveRoom')).toBe(false);
    useGameStore.setState({ mode: 'single', screen: 'menu', game: null });
  });

  it('服务器拒绝某类请求（error 带 ref）时通知订阅者，其他错误不触发', () => {
    const got: string[] = [];
    const off = onRequestError('startGame', (m) => got.push(m));
    deliver({ t: 'error', message: '还有玩家未准备：bob', ref: 'startGame' });
    deliver({ t: 'error', message: '无关的错误' });
    deliver({ t: 'error', message: '踢人失败', ref: 'kick' });
    off();
    deliver({ t: 'error', message: '取消订阅后不再通知', ref: 'startGame' });
    expect(got).toEqual(['还有玩家未准备：bob']);
  });

  it('welcome 区分局域网 / 公网服务器（公网不保留任何内网地址）；serverStats 写入在线统计', () => {
    reset({ screen: 'lobby', game: null });
    const mp0 = useGameStore.getState().mp;
    useGameStore.setState({ mp: { ...mp0, serverMode: 'unknown', serverStats: null, lanUrls: [] } });
    deliver({ t: 'welcome', sessionId: 'sid-1', serverName: '局域网服务器', lanUrls: ['http://192.168.1.5:8686'] });
    expect(useGameStore.getState().mp).toMatchObject({ serverMode: 'lan', lanUrls: ['http://192.168.1.5:8686'] });
    deliver({ t: 'welcome', sessionId: 'sid-1', serverName: '公网服务器', lanUrls: ['http://10.0.0.2:8686'], publicServer: true });
    expect(useGameStore.getState().mp).toMatchObject({ serverMode: 'public', lanUrls: [], serverName: '公网服务器' });
    expect(useGameStore.getState().mp.serverStats).toBeNull();
    deliver({ t: 'serverStats', online: 12, inGame: 6, rooms: 5, playing: 3 });
    expect(useGameStore.getState().mp.serverStats).toEqual({ online: 12, inGame: 6, rooms: 5, playing: 3 });
    // 异常数值按 0 处理
    deliver({ t: 'serverStats', online: -1, inGame: Number.NaN, rooms: 2.7, playing: 1 } as ServerMsg);
    expect(useGameStore.getState().mp.serverStats).toEqual({ online: 0, inGame: 0, rooms: 2, playing: 1 });
    expect(sent.some((m) => m.t === 'listRooms')).toBe(true);
  });

  it('恢复替身', () => {
    netAny.send = origSend;
    netAny.disconnect = origDisconnect;
    delete (net as unknown as Record<string, unknown>).isOpen;
    expect(net.isOpen).toBe(false);
  });
});

describe('protocol · 座位键', () => {
  const base: RoomInfo = {
    id: 'ABC123', name: '测试房', hostSeatKey: 'kHost', yourSeatKey: 'kMe', maxPlayers: 3, status: 'lobby',
    settings: { startTi: 9, endTi: 9, difficulty: 'normal', mode: 'build' },
    seats: [
      { seatKey: 'kHost', name: '房主', connected: true, lobbyReady: false },
      { seatKey: 'kMe', name: '我', connected: true, lobbyReady: true },
    ],
    createdAt: new Date(0).toISOString(),
  };

  it('mySeat / isRoomHost 按 yourSeatKey 识别自己与房主', () => {
    expect(mySeat(base)?.name).toBe('我');
    expect(isRoomHost(base)).toBe(false);
    expect(isRoomHost({ ...base, yourSeatKey: 'kHost' })).toBe(true);
    expect(mySeat({ ...base, yourSeatKey: null })).toBeUndefined();
    expect(isRoomHost({ ...base, yourSeatKey: null, hostSeatKey: '' })).toBe(false);
    expect(mySeat(null)).toBeUndefined();
    expect(isRoomHost(undefined)).toBe(false);
  });
});

describe('save · 导入多人存档', () => {
  it('多人座位视图（含 multiplayer）导入单机时给出明确的中文提示，而不是让单机卡住', async () => {
    const g = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: '测试', teamId: 'og', seed: 21 });
    const mp = JSON.parse(JSON.stringify(g)) as GameState;
    mp.multiplayer = {
      mode: 'build', hostTeamId: 'og', order: ['og'], activeSeat: null,
      seats: { og: { teamId: 'og', sessionId: '', name: '甲', eliminated: false, ready: false, saved: {} } },
    } as unknown as GameState['multiplayer'];
    expect(() => importSave(JSON.stringify(mp))).toThrow(/多人/);
    // 单机存档照常导入；multiplayer 为 null 也视为单机存档
    expect(importSave(JSON.stringify(g)).settings.playerTeamId).toBe('og');
    expect(importSave(JSON.stringify({ ...JSON.parse(JSON.stringify(g)), multiplayer: null })).multiplayer).toBeUndefined();
  });
});

// 真实选手入场自由市场（v0.4.3，src/engine/realEntry.ts / marketEntry.ts / gacha.releaseRealRookieCards）
// 用户反馈：「新开的一轮 Wings 主队的游戏中，Ceb 一直到 TI9 都检索不到，怎么回事？其实 Topson TI8 的中途才能检索到，
// 是不是新秀如果没人抽到就不会上场？那稍作修改，真实新秀如果没抽到则直接上场到自由市场中」
// - 未被抽走的真实新秀第 1 回合开始前以自由身进入自由市场；
// - 当届真实阵容中有、本局还没有出现过的真实选手（非本届新秀，如 TI6 开局时 TI8 重返赛场的 Ceb）赛季初以自由身进入自由市场；
// - 入场的回合内 AI 不签，人类玩家可以立即签；旧存档 / 旧房间读档补录当届缺失的真实选手。
import { beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { getTrajectories, getTrajectory } from '../src/data/index';
import type { GameState, PendingDecision } from '../src/engine/types';
import { advance, createNewGame, currentPlayerTournament, fillLineupWithTempSubs, fireCoach, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { freeAgents, pickAffordableFreeAgent, signFreeAgent } from '../src/engine/market';
import { aiTransferWindow, aiEnsureRosters } from '../src/engine/ai';
import { aiSigningHeld, marketEntryStatus } from '../src/engine/marketEntry';
import {
  REAL_ENTRY_VERSION, migrateRealEntry, realEntryEligible, realEntryNeedsMigration, realRosterIdsAt, seasonRealReturners,
} from '../src/engine/realEntry';
import { exportSave, importSave, upgradeLoadedState } from '../src/engine/save';
import { createMultiplayerGame, migrateRoomState, seatView } from '../src/engine/multi';
import { withSeat } from '../src/engine/seat';
import { removePlayerFromTeam } from '../src/engine/team';
import { isHumanTeam } from '../src/engine/seat';
import { makeCoach } from './helpers';
import { withConfig } from './e4-fakes/mocks';

beforeAll(() => {
  registerNodeRosterLoader();
});

/** 懒人推进到 untilTi 的第 untilRound 回合（决策取第一项、资金保底，不签人、不抽卡） */
async function advanceTo(
  opts: { startTi: number; teamId?: string; seed: number; seasons?: number }, untilTi: number, untilRound = 0,
): Promise<GameState> {
  const g = await createNewGame({
    startTi: opts.startTi, seasons: opts.seasons ?? Math.max(1, untilTi - opts.startTi + 2), difficulty: 'normal', managerName: 'T', seed: opts.seed,
    ...(opts.teamId ? { teamId: opts.teamId } : { newClub: { name: 'Probe', tag: 'PRB', region: 'CN' as const, color: '#888888' } }),
  });
  drive(g, (x) => x.season.ti >= untilTi && x.roundIndex >= untilRound);
  return g;
}

/** 懒人推进已有的局面直到 stop 为真（同 advanceTo） */
function drive(g: GameState, stop: (g: GameState) => boolean): GameState {
  for (let step = 0; step < 4000 && !g.gameOver && !stop(g); step++) {
    g.popups.length = 0;
    for (let k = 0; k < 20 && g.pendingDecisions.length; k++) {
      const d = g.pendingDecisions[0];
      resolveDecision(g, d.id, d.choices[0]?.id ?? '');
      if (g.pendingDecisions[0] === d) g.pendingDecisions.shift();
    }
    const me = g.teams[g.settings.playerTeamId];
    if (me && me.gold < 2_000_000) me.gold = 2_000_000;
    if (currentPlayerTournament(g) || g.activeMatch) {
      if (!quickSimTournament(g).ok) fillLineupWithTempSubs(g);
    }
    advance(g);
  }
  expect(g.gameOver).toBeNull();
  return g;
}

/** withConfig 的异步版本（配置在整个异步过程中保持修改，结束后恢复） */
async function withConfigAsync<T>(section: 'realEntry', patch: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = CONFIG[section] as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = target[k];
    target[k] = patch[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) target[k] = saved[k];
  }
}

/** 谈判骰子按回合固定：换回合重试，成功后回到原回合 */
function humanSign(g: GameState, id: string): void {
  const r0 = g.roundIndex;
  let r = signFreeAgent(g, id);
  for (let i = 1; !r.ok && i < 30; i++) {
    g.roundIndex = r0 + i;
    r = signFreeAgent(g, id);
  }
  g.roundIndex = r0;
  expect(r.ok, r.message).toBe(true);
}

/** 本局状态的一致性：每名选手最多属于一支战队，名单与 teamId 一致；不存在与在役选手同 id 的教练 */
function expectConsistent(g: GameState): void {
  const owner = new Map<string, string>();
  for (const t of Object.values(g.teams)) {
    for (const pid of t.playerIds) {
      expect(owner.has(pid), `${pid} 同时在 ${owner.get(pid)} 与 ${t.id}`).toBe(false);
      owner.set(pid, t.id);
      expect(g.players[pid]?.teamId, pid).toBe(t.id);
    }
  }
  for (const p of Object.values(g.players)) {
    if (p.teamId) expect(owner.get(p.id), p.id).toBe(p.teamId);
  }
}

describe('静态数据：当届真实阵容（trajectories.json）', () => {
  it('Ceb：TI2–TI5 选手、TI6–TI7 缺席（阵容数据里是 OG 教练）、TI8 起重返赛场；TI8 为三号位', () => {
    expect(realRosterIdsAt(5)).toContain('ceb');
    expect(realRosterIdsAt(6)).not.toContain('ceb');
    expect(realRosterIdsAt(7)).not.toContain('ceb');
    expect(realRosterIdsAt(8)).toContain('ceb');
    expect(getTrajectory('ceb')![8]).toMatchObject({ mmr: 11500, power: 88, pos: 'O' });
    // 每届的 id 列表与 trajectories.json 一致（排序、无重复）
    const all = getTrajectories();
    for (const ti of [1, 8, 15]) {
      const ids = realRosterIdsAt(ti);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(Object.keys(all).filter((id) => !!all[id][ti]).sort());
    }
  });
});

describe('用户场景：TI6 开局接管 Wings，Ceb 在 TI8 赛季初以自由身进入自由市场', () => {
  it('TI8 赛季初：Ceb 是自由选手（TI8 真实水平、三号位），卸任 OG 主教练；本回合 AI 不签、人类玩家可以签；没有重复选手', async () => {
    const g = await advanceTo({ startTi: 6, teamId: 'wings-gaming', seed: 1 }, 8, 0);
    expect(g.season.ti).toBe(8);
    expect(g.phase).toBe('preseason');
    const ceb = g.players.ceb;
    expect(ceb).toBeDefined();
    expect(ceb.status).toBe('active');
    expect(ceb.teamId).toBeNull();
    expect(ceb.position).toBe('O');
    expect(ceb.mmr).toBe(11500);
    expect(ceb.power).toBe(88);
    expect(ceb.isReal).toBe(true);
    expect(ceb.marketEntry).toEqual({ ti: 8, round: 0 });
    expect(freeAgents(g).map((p) => p.id)).toContain('ceb');
    // 与他同 id 的真实教练（TI6–TI7 执教 OG）卸任并删除
    expect(g.coaches.ceb).toBeUndefined();
    expect(Object.values(g.teams).some((t) => t.coachId === 'ceb')).toBe(false);
    // TI8 的其余新面孔（开局届之后才重返赛场、不是本届新秀）同样在场
    for (const id of ['stinger', 'kotaro', 'net', 'kyxy']) {
      expect(g.players[id], id).toBeDefined();
      expect(g.players[id].status).not.toBe('retired');
    }
    // 一条公开新闻
    const news = g.news.find((n) => n.season === 8 && n.title.startsWith('【复出 / 新面孔】'));
    expect(news?.body).toContain('Ceb（SS 级 · 3号位 劣势路）');
    expect(news?.body).toContain('Ceb 卸任 OG 主教练');
    expect(news?.important).toBe(true);
    // 当届阵容数据中的每名真实选手都在本局中（本届新秀在卡池中，第 1 回合开始前才进入本局）
    for (const id of realRosterIdsAt(8)) {
      if (g.futureRookies[id] !== undefined) continue;
      expect(g.players[id], id).toBeDefined();
    }
    expectConsistent(g);
    // 公平窗口：赛季初（入场的回合）AI 不签——即使是追逐巅峰阵容的 OG，资金充裕时也拿不到
    const og = g.teams.og;
    og.gold = 100_000_000;
    expect(aiSigningHeld(g, ceb)).toBe(true);
    expect(pickAffordableFreeAgent(g, og, [ceb])).toBeNull();
    aiTransferWindow(g, 'preseason');
    aiEnsureRosters(g);
    expect(ceb.teamId).toBeNull();
    // 人类玩家：本回合即可签下
    const wings = g.teams['wings-gaming'];
    wings.gold = 100_000_000;
    wings.honor = 3000;
    humanSign(g, 'ceb');
    expect(ceb.teamId).toBe('wings-gaming');
    expect(ceb.marketEntry).toBeUndefined();
    expectConsistent(g);
  }, 120000);

  it('Topson（TI8 新秀）：没有被抽走时第 1 回合开始前进入自由市场，不再直接加盟 OG；入场回合 AI 不签；确定性（同种子两局逐字节相同）', async () => {
    const a = await advanceTo({ startTi: 7, seed: 3 }, 8, 1);
    const b = await advanceTo({ startTi: 7, seed: 3 }, 8, 1);
    expect(a.season.ti).toBe(8);
    expect(a.roundIndex).toBe(1);
    const t = a.players.topson;
    expect(t).toBeDefined();
    expect(t.gacha).toMatchObject({ kind: 'real', placed: true, teamId: '', ti: 8 });
    // 第 1 回合开始时进入自由市场；本回合 AI 不签（不在 OG），人类可以签
    expect(t.teamId).toBeNull();
    expect(t.marketEntry).toEqual({ ti: 8, round: 1 });
    expect(aiSigningHeld(a, t)).toBe(true);
    expect(a.pendingDecisions.some((d) => d.kind === 'rookie_home')).toBe(false);
    const news = a.news.find((n) => n.title.startsWith('【新秀】TI8 未被抽走的真实新秀进入自由市场'));
    expect(news?.body).toContain('Topson');
    expectConsistent(a);
    expect(JSON.stringify(a.players)).toBe(JSON.stringify(b.players));
    expect(JSON.stringify(a.teams)).toBe(JSON.stringify(b.teams));
    expect(a.rngState).toBe(b.rngState);
  }, 120000);

  it('与他同 id 的真实教练在人类玩家战队执教（TI6 开局接管 OG）：继续执教、暂不入场（新闻注明）；解雇后随即以自由身进入自由市场', async () => {
    const g = await advanceTo({ startTi: 6, teamId: 'og', seed: 2 }, 8, 0);
    expect(g.season.ti).toBe(8);
    expect(g.teams.og.coachId).toBe('ceb');
    expect(g.players.ceb).toBeUndefined();
    const news = g.news.find((n) => n.season === 8 && n.title.startsWith('【复出 / 新面孔】'));
    expect(news?.body).toContain('Ceb 现任 OG 主教练，继续执教，暂不回到赛场');
    const r = fireCoach(g);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toContain('Ceb 以选手身份进入自由市场');
    expect(g.coaches.ceb).toBeUndefined();
    expect(g.players.ceb?.teamId).toBeNull();
    expect(g.players.ceb?.status).toBe('active');
    expect(g.players.ceb?.marketEntry).toEqual({ ti: 8, round: 0 });
    expect(g.news.some((n) => n.title === '【复出 / 新面孔】Ceb 进入自由市场')).toBe(true);
    expectConsistent(g);
  }, 120000);
});

// ---------------------------------------------------------------------------
// 旧存档 / 旧房间迁移
// ---------------------------------------------------------------------------

/** 旧版本的「真实新秀希望加盟」待决事件 */
function legacyHome(id: string, teamId: string, ti: number): PendingDecision {
  return {
    id: `d-home-${id}`, kind: 'rookie_home', title: `【真实新秀】${id} 希望加盟`, body: '',
    choices: [{ id: 'sign', label: '签下' }, { id: 'decline', label: '放弃' }],
    ctx: { teamId, rookieId: id, tier: 'S', ti }, createdRound: 1, blocking: true,
  };
}

describe('旧存档：读档补录当届缺失的真实选手（realEntry.migrateRealEntry）', () => {
  it('TI6 开局、旧规则下推进到 TI9 的存档（没有 Ceb）：读档后 Ceb 以自由身进入自由市场（OG 主教练卸任），待决的 rookie_home 改为直接进入自由市场；幂等', async () => {
    // 旧规则：赛季初不入场（只关掉复出 / 新面孔这一步来模拟 v0.4.2 的存档）
    const g = await withConfigAsync('realEntry', { returners: false }, () => advanceTo({ startTi: 6, teamId: 'wings-gaming', seed: 4 }, 9, 2));
    expect(g.season.ti).toBe(9);
    expect(g.players.ceb).toBeUndefined();
    expect(g.coaches.ceb?.teamId).toBe('og');
    const missing = realRosterIdsAt(9).filter((id) => realEntryEligible(g, id, 9));
    expect(missing).toContain('ceb');
    // 旧版本的待决事件：出道战队为人类玩家时离池的真实新秀尚未生成（futureRookies 保留，等玩家决定）——
    // 取一名本届进入自由市场的真实新秀，还原成旧版本的样子
    const rookie = Object.values(g.players).filter((p) => p.gacha?.kind === 'real' && p.gacha.placed && p.gacha.ti === 9 && !p.teamId)
      .map((p) => p.id).sort()[0];
    expect(rookie).toBeTruthy();
    delete g.players[rookie];
    g.futureRookies[rookie] = 9;
    g.pendingDecisions.push(legacyHome(rookie, 'wings-gaming', 9));
    delete g.realEntryVersion;
    expect(realEntryNeedsMigration(g)).toBe(true);
    const json = exportSave(g);
    const s = importSave(json);
    expect(s.realEntryVersion).toBe(REAL_ENTRY_VERSION);
    const ceb = s.players.ceb;
    expect(ceb?.status).toBe('active');
    expect(ceb?.teamId).toBeNull();
    expect(ceb?.position).toBe('O');
    expect(ceb?.mmr).toBe(getTrajectory('ceb')![9].mmr);
    expect(ceb?.marketEntry).toEqual({ ti: 9, round: 2 });
    expect(s.coaches.ceb).toBeUndefined();
    expect(s.teams.og.coachId).not.toBe('ceb');
    for (const id of missing) expect(s.players[id], id).toBeDefined();
    // rookie_home → 自由市场
    expect(s.pendingDecisions.some((d) => d.kind === 'rookie_home')).toBe(false);
    expect(s.players[rookie]?.teamId).toBeNull();
    expect(s.players[rookie]?.gacha).toMatchObject({ kind: 'real', placed: true, teamId: '' });
    // 新闻 + 总览通知
    const title = `【复出 / 新面孔】${missing.length + 1} 名真实选手进入自由市场`;
    expect(s.news.some((n) => n.title === title)).toBe(true);
    expect(s.popups.filter((p) => p.kind === 'message' && p.title === title)).toHaveLength(1);
    expectConsistent(s);
    // 幂等：再读一次不变；「继续游戏」路径（upgradeLoadedState）同样只执行一次
    const again = exportSave(s);
    expect(exportSave(importSave(again))).toBe(again);
    const cont = JSON.parse(json) as GameState;
    upgradeLoadedState(cont);
    expect(cont.players.ceb?.teamId).toBeNull();
    const n = Object.keys(cont.players).length;
    expect(migrateRealEntry(cont)).toBeNull();
    upgradeLoadedState(cont);
    expect(Object.keys(cont.players).length).toBe(n);
    // 两条路径结果相同（确定性）
    expect(JSON.stringify(cont.players)).toBe(JSON.stringify(s.players));
    // 本回合（入场回合）AI 不签；人类可以签
    expect(aiSigningHeld(s, s.players.ceb)).toBe(true);
    s.teams['wings-gaming'].gold = 100_000_000;
    s.teams['wings-gaming'].honor = 3000;
    humanSign(s, 'ceb');
    expect(s.players.ceb.teamId).toBe('wings-gaming');
  }, 180000);

  it('转会窗口已关闭（TI 阶段）：只补录当届之后仍有真实数据的选手；游戏已结束只写版本；开关关闭时只处理 rookie_home', async () => {
    const g = await withConfigAsync('realEntry', { returners: false }, () => advanceTo({ startTi: 6, teamId: 'wings-gaming', seed: 5 }, 8, 0));
    expect(g.players.ceb).toBeUndefined();
    const base = exportSave(g);
    // TI 阶段：Ceb（最后一届 TI15）仍补录；最后一届就是 TI8 的不补录
    const ti = JSON.parse(base) as GameState;
    ti.phase = 'ti';
    delete ti.realEntryVersion;
    const endsHere = realRosterIdsAt(8).filter((id) => {
      const tis = Object.keys(getTrajectory(id) ?? {}).map(Number);
      return !ti.players[id] && Math.max(...tis) === 8 && Math.min(...tis) < 8;
    });
    migrateRealEntry(ti);
    expect(ti.players.ceb?.teamId).toBeNull();
    for (const id of endsHere) expect(ti.players[id], id).toBeUndefined();
    // 游戏已结束：只写版本
    const over = JSON.parse(base) as GameState;
    over.gameOver = { reason: 'completed', summary: '' } as GameState['gameOver'];
    delete over.realEntryVersion;
    expect(migrateRealEntry(over)?.entered).toHaveLength(0);
    expect(over.realEntryVersion).toBe(REAL_ENTRY_VERSION);
    expect(over.players.ceb).toBeUndefined();
    // 开关关闭：不补录（rookie_home 照常改为自由市场）
    const off = JSON.parse(base) as GameState;
    delete off.realEntryVersion;
    withConfig('realEntry', { returners: false }, () => migrateRealEntry(off));
    expect(off.players.ceb).toBeUndefined();
    expect(off.realEntryVersion).toBe(REAL_ENTRY_VERSION);
    // 新游戏：已是最新版本，不迁移
    expect(realEntryNeedsMigration(g)).toBe(false);
  }, 120000);

  it('多人旧房间：migrateRoomState 迁移一次（中性上下文）；各座位的 rookie_home 改为自由市场；公开新闻、各座位各一条通知', async () => {
    const g = await createMultiplayerGame({
      startTi: 9, endTi: 11, difficulty: 'normal', mode: 'build', seed: 7,
      players: [
        { sessionId: 's1', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's2', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#2a6cc2' } },
      ],
    });
    expect(migrateRoomState(g)).toBe(false); // 新房间已是最新版本
    // 模拟 TI6 开局的旧房间：Ceb 没有进入本局、在 OG 执教
    const og = Object.values(g.teams).find((t) => t.name === 'OG')!;
    expect(og).toBeDefined();
    removePlayerFromTeam(g, 'ceb');
    delete g.players.ceb;
    g.coaches.ceb = makeCoach({ id: 'ceb', name: 'Ceb', teamId: og.id });
    og.coachId = 'ceb';
    const ids = Object.keys(g.multiplayer!.seats);
    const rookie = 'no-such-rookie-for-test';
    // 第二个座位（非当前座位）有一个旧版本的 rookie_home（数据缺失的新秀：只移除事件）
    withSeat(g, ids[1], () => { g.pendingDecisions.push(legacyHome(rookie, ids[1], 9)); });
    delete g.realEntryVersion;
    expect(seatView(g, ids[1]).pendingDecisions.some((d) => d.kind === 'rookie_home')).toBe(true);
    expect(migrateRoomState(g)).toBe(true);
    expect(g.multiplayer!.activeSeat).toBeNull();
    expect(seatView(g, ids[1]).pendingDecisions.some((d) => d.kind === 'rookie_home')).toBe(false);
    expect(g.players.ceb?.teamId).toBeNull();
    expect(g.players.ceb?.status).toBe('active');
    expect(g.coaches.ceb).toBeUndefined();
    // 读档迁移在 AI 季前窗口之外：OG 随即从教练市场补签一名主教练（不消耗随机数）
    expect(og.coachId).not.toBeNull();
    expect(og.coachId).not.toBe('ceb');
    expect(g.coaches[og.coachId!]?.teamId).toBe(og.id);
    const title = '【复出 / 新面孔】Ceb 进入自由市场';
    expect(seatView(g, ids[0]).news.find((x) => x.title === title)?.body).toContain(`OG 随即聘请 ${g.coaches[og.coachId!].name} 担任主教练`);
    for (const id of ids) {
      const v = seatView(g, id);
      expect(v.news.some((x) => x.title === title)).toBe(true);
      expect(v.popups.filter((x) => x.kind === 'message' && x.title === title)).toHaveLength(1);
    }
    expect(g.popups ?? []).toHaveLength(0); // 中性状态没有通知
    expect(migrateRoomState(g)).toBe(false);
    expectConsistent(g);
  }, 60000);
});

describe('赛季初入场（seasonRealReturners）', () => {
  it('新游戏第一个赛季不执行；只处理本局中不存在的 id（已退役 / 禁赛的真实选手不动）；不是本届新秀；开关关闭时不执行', async () => {
    const g = await createNewGame({
      startTi: 9, seasons: 2, difficulty: 'normal', managerName: 'T', seed: 9,
      newClub: { name: 'Probe', tag: 'PRB', region: 'CN', color: '#888888' },
    });
    expect(seasonRealReturners(g)).toBeNull(); // 第一个赛季
    for (const id of realRosterIdsAt(9)) {
      const first = Math.min(...Object.keys(getTrajectory(id)!).map(Number));
      if (first < 9) expect(g.players[id], id).toBeDefined();
    }
    // 第二个赛季（TI10）的视角：已退役的真实选手与本届新秀不入场
    g.settings.startTi = 8;
    const ceb = g.players.ceb;
    ceb.status = 'retired';
    removePlayerFromTeam(g, 'ceb');
    const rep = seasonRealReturners(g)!;
    expect(rep.entered).toHaveLength(0);
    expect(g.players.ceb.status).toBe('retired');
    // 删掉一名非新秀的当届真实选手：赛季初补回
    const id = 'n0tail';
    removePlayerFromTeam(g, id);
    delete g.players[id];
    expect(realEntryEligible(g, id, 9)).toBe(true);
    withConfig('realEntry', { returners: false }, () => expect(seasonRealReturners(g)).toBeNull());
    expect(g.players[id]).toBeUndefined();
    const rep2 = seasonRealReturners(g)!;
    expect(rep2.entered.map((r) => r.playerId)).toEqual([id]);
    expect(g.players[id].teamId).toBeNull();
    expect(g.players[id].loyalty).toBe(CONFIG.loyalty.freeAgentTarget);
    // 待登场的新秀（futureRookies）不入场
    removePlayerFromTeam(g, 'topson');
    delete g.players.topson;
    g.futureRookies.topson = 9;
    expect(realEntryEligible(g, 'topson', 9)).toBe(false);
  }, 60000);
});

// ---------------------------------------------------------------------------
// v0.4.3 审查修复
// ---------------------------------------------------------------------------

describe('审查：转会窗口锁定时入场 / 与真实新秀同 id 的教练', () => {
  it('TI 预选赛期间读档补录（窗口锁定）：入场时刻记为下个赛季初，休赛期转会潮与 AI 季前窗口不签，人类玩家那时可以先签', async () => {
    // 旧规则（不入场）推进到 TI8 的 TI 预选赛回合
    const g = await withConfigAsync('realEntry', { returners: false }, async () => {
      const x = await advanceTo({ startTi: 6, teamId: 'wings-gaming', seed: 1 }, 8, 0);
      return drive(x, (y) => y.phase === 'ti_qualifier');
    });
    expect(g.season.ti).toBe(8);
    expect(g.phase).toBe('ti_qualifier');
    expect(g.players.ceb).toBeUndefined();
    delete g.realEntryVersion;
    const s = importSave(exportSave(g));
    // 读档补录的选手（本局此前没有的 id）：入场时刻都是下个赛季初
    const entrants = Object.keys(s.players).filter((id) => !g.players[id]).sort();
    expect(entrants).toContain('ceb');
    for (const id of entrants) expect(s.players[id].marketEntry, id).toEqual({ ti: 9, round: 0 });
    const ceb = s.players.ceb;
    expect(ceb.marketEntry).toEqual({ ti: 9, round: 0 });
    expect(marketEntryStatus(s, ceb)).toBe('next');
    const news = s.news.find((n) => n.title.startsWith('【复出 / 新面孔】'));
    expect(news?.body).toContain('转会窗口锁定中，下个赛季初窗口开放的那个回合 AI 战队不会签下');
    expect(news?.body).not.toContain('下一回合起照常');
    // 推进到 TI9 赛季初（人类玩家第一次能签约的回合）：AI（含 OG 的使命引进）都没有签下他们
    drive(s, (y) => y.season.ti >= 9);
    expect(s.season.ti).toBe(9);
    expect(s.roundIndex).toBe(0);
    for (const id of entrants) {
      const p = s.players[id];
      const tid = p?.teamId;
      // 新成立的真实俱乐部签回自家当届选手保持原规则
      if (tid) expect(isHumanTeam(s, tid) || s.teams[tid]?.founded?.ti === 9, `${id} → ${tid}`).toBe(true);
    }
    expect(s.players.ceb.teamId).toBeNull();
    expect(s.players.ceb.marketEntry).toEqual({ ti: 9, round: 0 });
    expect(marketEntryStatus(s, s.players.ceb)).toBe('now');
    expect(aiSigningHeld(s, s.players.ceb)).toBe(true);
    const wings = s.teams['wings-gaming'];
    wings.gold = 100_000_000;
    wings.honor = 3000;
    humanSign(s, 'ceb');
    expect(s.players.ceb.teamId).toBe('wings-gaming');
    expectConsistent(s);
  }, 180000);

  it('真实新秀与本局中的教练同 id（TI7 开局接管 Cloud9）：人类玩家战队的主教练继续执教、暂不出道，解雇后以新秀身份入场；AI 战队的卸任并补签；不存在与在役选手同 id 的教练', async () => {
    const g = await advanceTo({ startTi: 7, teamId: 'cloud9', seed: 1 }, 8, 1);
    expect(g.season.ti).toBe(8);
    expect(g.roundIndex).toBe(1);
    // 不存在「同一个人既是在役选手又是教练」
    for (const id of Object.keys(g.coaches)) {
      expect(g.players[id]?.status === 'active', id).toBe(false);
    }
    expect(g.coaches.stanking?.teamId).toBe('cloud9');
    expect(g.teams.cloud9.coachId).toBe('stanking');
    expect(g.players.stanking).toBeUndefined();
    const rel = g.news.find((n) => n.title.startsWith('【新秀】TI8 未被抽走的真实新秀'));
    expect(rel?.body).toContain('Stan King 现任 Cloud9 主教练，继续执教、暂不出道');
    // 其余同 id 的教练（自由 / AI 战队）已删除，选手以新秀身份进入本局；AI 战队补签了主教练
    for (const id of ['papita', 'svg']) {
      if (!g.players[id]) continue;
      expect(g.coaches[id], id).toBeUndefined();
      expect(Object.values(g.teams).some((t) => t.coachId === id), id).toBe(false);
    }
    for (const n of g.news.filter((x) => x.title.startsWith('【教练】') && x.body.includes('以选手身份出道'))) {
      for (const tid of n.teamIds ?? []) expect(g.teams[tid].coachId, tid).toBeTruthy();
    }
    // 解雇 → 以未被抽走的真实新秀身份进入自由市场
    const r = fireCoach(g);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toContain('Stan King 以选手身份进入自由市场');
    const p = g.players.stanking;
    expect(p?.status).toBe('active');
    expect(p?.teamId).toBeNull();
    expect(p?.isRookie).toBe(true);
    expect(p?.gacha).toMatchObject({ kind: 'real', placed: true, teamId: '', ti: 8 });
    expect(p?.marketEntry).toEqual({ ti: 8, round: 1 });
    expect(g.coaches.stanking).toBeUndefined();
    expect(g.news.find((n) => n.title === '【复出 / 新面孔】Stan King 进入自由市场')?.body).toContain('卸任主教练，以选手身份出道');
    expectConsistent(g);
  }, 120000);
});

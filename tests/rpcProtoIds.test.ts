// 原型链上的键（'__proto__'、'constructor'、'toString' 等）作为 RPC 参数：玩家操作按 id 查找选手 / 战队 / 赛事 / 教练时只认自有属性
// （util.ownEntry），结果与「不存在的 id」完全相同，不再出现「Object 已有东家」「尚未报名 undefined」「undefined 当前无法签约」之类的文案。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult } from '../src/engine/types';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { RPC_WHITELIST } from '../src/shared/protocol';
import * as M from '../src/engine/multi';
import { createNewGame, hireCoach } from '../src/engine/game';
import { signFreeAgent, releasePlayers, hireTempSub } from '../src/engine/market';
import { registerForTournament, unregisterFromTournament } from '../src/engine/schedule';
import { listPlayersForTransfer, unlistPlayer } from '../src/engine/squadOps';
import { tradeQuote } from '../src/engine/trade';

beforeAll(() => {
  registerNodeRosterLoader();
});

const PROTO_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
const UNKNOWN = 'no-such-id';
/** 参数形状：id 出现在各个位置 / 数组里 */
const shapes = (k: string): unknown[][] => [[k], [k, k], [k, 1], [k, k, k], [k, 100000], [[k]], [k, [k]], [k, 0, [k]], ['x', k], ['x', 'x', k]];
const ODD = /undefined|Object|function|native code|\[object/;

describe('RPC 参数为原型链上的键', () => {
  it('全部白名单操作：结果与不存在的 id 相同，文案不含 undefined / Object', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 5,
      players: [
        { sessionId: 's0', name: '甲', newClub: { name: 'A Club', tag: 'AAA', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's1', name: '乙', newClub: { name: 'B Club', tag: 'BBB', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const A = g.multiplayer!.order[0];
    const call = (state: GameState, fn: string, args: unknown[]): string => {
      try {
        const r = M.callAsSeat(state, A, fn, args) as OpResult | undefined;
        // 只比较 OpResult；其余返回值（如临时替补候选列表、void）不含文案
        return r && typeof r === 'object' && 'ok' in r ? `${r.ok}|${String(r.message ?? '')}` : 'value';
      } catch (e) {
        return `THROW ${(e as Error).message}`;
      }
    };
    const diffs: string[] = [];
    for (const fn of RPC_WHITELIST) {
      const n = shapes(UNKNOWN).length;
      for (let i = 0; i < n; i++) {
        const ref = call(structuredClone(g), fn, shapes(UNKNOWN)[i]);
        for (const k of PROTO_KEYS) {
          const got = call(structuredClone(g), fn, shapes(k)[i]);
          if (got.split(k).join(UNKNOWN) !== ref) diffs.push(`${fn}(${JSON.stringify(shapes(k)[i])})：${got} ≠ ${ref}`);
          if (!got.startsWith('true') && ODD.test(got.replace(k, ''))) diffs.push(`${fn}(${JSON.stringify(shapes(k)[i])})：${got}`);
        }
      }
    }
    expect(diffs).toEqual([]);
    // 原型没有被写入
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('teamId');
  }, 60_000);

  it('单机：签约 / 教练 / 报名 / 批量操作 / 临时替补 / 交易的查找只认自有属性', async () => {
    const s = await createNewGame({
      startTi: 9, seasons: 1, difficulty: 'normal', managerName: '测试', seed: 7,
      newClub: { name: 'Proto Club', tag: 'PRO', region: 'CN', color: '#c23c2a' },
    });
    for (const k of ['__proto__', 'constructor']) {
      expect(signFreeAgent(s, k)).toEqual({ ok: false, message: '选手不存在' });
      expect(hireCoach(s, k)).toEqual({ ok: false, message: '教练不存在' });
      expect(unregisterFromTournament(s, k)).toEqual({ ok: false, message: '赛事不存在' });
      expect(registerForTournament(s, k).message).toBe('赛事不存在或不属于本赛季');
      expect(releasePlayers(s, [k])).toEqual({ ok: false, message: '未选择选手' });
      expect(listPlayersForTransfer(s, [k])).toEqual({ ok: false, message: '未选择选手' });
      expect(unlistPlayer(s, k).message).toBe('该选手不在你的战队');
      expect(hireTempSub(s, k, k).message).toBe('该替补已不在候选名单中');
      const target = Object.values(s.players).find((p) => p.teamId && p.teamId !== s.settings.playerTeamId && p.status === 'active')!;
      const q = tradeQuote(s, target.id, 0, [k]);
      expect(q.items[0]?.refused).toBe('选手不存在');
    }
  });
});

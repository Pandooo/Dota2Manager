// ============================================================================
// 服务器使用的引擎适配层：把 src/engine/multi.ts 的多人 API 收拢为一个接口，
// 便于测试时注入假的引擎（tests/server.test.ts），也把「读取 state.multiplayer」集中在一处。
// ============================================================================
import type { GameState, MultiplayerInfo, OpResult, SeatState } from '../src/engine/types';
import type { MpNewGameOptions } from '../src/engine/multi';
import * as multi from '../src/engine/multi';
import { availableStartTis, loadRoster } from '../src/data/index';

/** 真实战队摘要（existing 玩法的选队校验用） */
export interface RealTeamInfo {
  id: string;
  name: string;
  tag: string;
  region: string;
}

/** 服务器所需的引擎能力 */
export interface MpEngine {
  createGame(opts: MpNewGameOptions): Promise<GameState>;
  /** 在座位上下文中执行白名单 RPC，返回引擎函数的返回值 */
  callAsSeat(state: GameState, teamId: string, fn: string, args: unknown[]): unknown;
  /** 某座位的视图（深拷贝，已剥离其他座位私有数据） */
  seatView(state: GameState, teamId: string): GameState;
  /** 回合准备；opts.auto：先在该座位上下文中自动处理本回合事务（multi.setSeatReady） */
  setSeatReady(state: GameState, teamId: string, ready: boolean, opts?: { auto?: boolean }): OpResult;
  allSeatsReady(state: GameState): boolean;
  advance(state: GameState): OpResult;
  /** 托管一个离线座位本回合的事务（处理待决事件、快速模拟比赛、无阻塞时准备），不推进回合 */
  autopilot(state: GameState, teamId: string): OpResult;
  /** 多人信息（座位顺序、昵称、准备、出局） */
  info(state: GameState): MultiplayerInfo | null;
  /** 有真实战队数据的 TI */
  startTis(): number[];
  /** 某届 TI 的真实战队（无数据时返回 []） */
  realTeams(ti: number): Promise<RealTeamInfo[]>;
  /** 载入旧房间时的存档迁移（幂等；返回是否有改动）。可选：测试替身可不实现 */
  migrate?(state: GameState): boolean;
}

/** 读取 state.multiplayer（单机/损坏时为 null） */
export function mpInfoOf(state: GameState | null | undefined): MultiplayerInfo | null {
  const mp = state?.multiplayer;
  return mp && typeof mp === 'object' && mp.seats && typeof mp.seats === 'object' ? mp : null;
}

/** 座位（按 order 顺序；order 缺失时按 seats 键顺序） */
export function seatsOf(mp: MultiplayerInfo | null): SeatState[] {
  if (!mp) return [];
  const order = Array.isArray(mp.order) && mp.order.length ? mp.order : Object.keys(mp.seats);
  return order.map((id) => mp.seats[id]).filter((s): s is SeatState => !!s);
}

const teamCache = new Map<number, RealTeamInfo[]>();

/** 默认实现：直接调用 src/engine/multi.ts */
export const defaultEngine: MpEngine = {
  createGame: (opts) => multi.createMultiplayerGame(opts),
  callAsSeat: (state, teamId, fn, args) => multi.callAsSeat(state, teamId, fn, args),
  seatView: (state, teamId) => multi.seatView(state, teamId),
  setSeatReady: (state, teamId, ready, opts) => multi.setSeatReady(state, teamId, ready, opts),
  allSeatsReady: (state) => multi.allSeatsReady(state),
  advance: (state) => multi.advanceMultiplayer(state),
  autopilot: (state, teamId) => multi.autopilotSeat(state, teamId),
  info: (state) => mpInfoOf(state),
  migrate: (state) => multi.migrateRoomState(state),
  startTis: () => availableStartTis(),
  realTeams: async (ti) => {
    const hit = teamCache.get(ti);
    if (hit) return hit;
    let list: RealTeamInfo[] = [];
    try {
      const roster = await loadRoster(ti);
      list = (roster.teams ?? [])
        .filter((t) => t && typeof t.id === 'string')
        .map((t) => ({ id: t.id, name: t.name, tag: t.tag, region: t.region }));
    } catch {
      list = [];
    }
    teamCache.set(ti, list);
    return list;
  },
};

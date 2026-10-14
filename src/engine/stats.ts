// ============================================================================
// DotaPedia 统计记录（GameState.pedia；查询见 pedia.ts）
//
// 记录点（引擎小钩子，全部人机共用、多人模式全局一次）：
//   match.simulateGame        → recordGameStats      每一局（含 AI 快速模拟）：K/D/A、英雄、胜负、时长、MVP、单局纪录
//   tournament.recordSeriesResult → recordSeriesStats 每一场系列赛：战队 / 首发的系列赛胜平负、系列赛连胜
//   tournament.finishTournament   → recordPrizeSplit / recordTournamentStats  奖金（俱乐部 / 队员分成）、冠亚军首发、TI 全部正赛首发
//   season.settleSeason           → recordPediaSeasonEnd  赛季末快照：荣誉、排名、阵容、教练、选手巅峰；压缩英雄表
//
// 确定性与性能：
//   - 不使用 rngOf(state)：每局的分配使用按（存档 id, 对局序号）派生的独立子随机流（pediaGameRng，与 seededRng(hashSeed(...)) 同序列），
//     记录开关（CONFIG.pedia.enabled）不影响任何比赛结果与主随机序列；同一种子的两局游戏统计完全相同。
//   - 每局 O(1)：10 名选手的分配 + 少量 Map 更新；不存逐局个人数据（只累加到聚合与单局纪录；旧存档的 GameRecord.box 在升级统计格式时清除）。
//   - K/D/A 与本局比分一致：A 方击杀之和 = killsA，A 方阵亡之和 = killsB；助攻 ≤ 本队击杀 − 自己的击杀。
//     有文字直播的对局直接采用直播中的个人击杀 / 阵亡（与直播文本一致），只分配助攻。
//   - 英雄：有 BP 的对局取 BP；AI 快速模拟没有 BP，按招牌英雄 / 位置适配 / 当前版本强度确定性挑选（同局不重复）。
//   - 每个记录钩子都有异常保护（safely）：损坏的统计数据只会跳过这条统计，不影响比赛 / 赛事流程。
// ============================================================================
import type {
  GameRecord, GameState, PediaHeroLine, PediaPlayer, PediaPlayerSeason, PediaRecord, PediaRecordKind,
  PediaState, PediaTeam, PediaTeamSeason, PediaTournament, Player, Position, Series, SeriesResult, Tournament,
  TournamentTier,
} from './types';
import { POSITIONS } from './types';
import { CONFIG } from './config';
import { hashSeed, makeRng } from './rng';
import type { Rng } from './rng';
import { availableHeroes, heroMetaValue } from './heroes';
import { draftHeroDate } from './draft';
import { patchByVersion } from './patches';
import { overallRating, playerTier, tierIndex } from './player';
import { rankTeamsByRating } from './team';
import { ownEntry } from './util';

/** 统计格式版本（PediaState.v）。2：不再存逐局个人数据（GameRecord.box），升级时清除旧存档残留 */
export const PEDIA_VERSION = 2;

/**
 * 每局复用的子随机流（与 seededRng(seed) 同序列；只在 recordGameStats 内同步使用，不分配新对象）。
 * 种子 = hashSeed(存档 id | 对局序号)：不读写 state.rngState。
 */
const subState = { s: 0 };
const subRng: Rng = makeRng(() => subState.s, (v) => { subState.s = v; });

/** 第 seq 局的子随机流（测试用：与 recordGameStats 内部使用的序列相同） */
export function pediaGameRng(stateId: string, seq: number): Rng {
  subState.s = hashSeed(`${stateId}|pedia|${seq}`) | 0;
  return subRng;
}

const P = () => CONFIG.pedia;

/** 是否记录统计（CONFIG.pedia.enabled） */
export function pediaEnabled(): boolean {
  const on: boolean = P().enabled;
  return on;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 只读：存档中的统计状态（不存在 / 格式无效时为 null，不创建） */
export function pediaOf(state: GameState): PediaState | null {
  const ps = state?.pedia;
  return isObj(ps) && isObj(ps.players) && isObj(ps.teams) ? ps : null;
}

/**
 * 统计写入修订号（进程内、不入存档）：每次记录（含不产生对局的弃权系列赛、奖金、赛季末快照）都会递增，
 * pedia.ts 的查询缓存以此判断数据是否变化。
 */
let revision = 0;
export function pediaRevision(): number {
  return revision;
}

/**
 * 统计记录失败不得影响比赛 / 赛事流程（手工编辑 / 截断的存档）：吞掉异常，每个进程只报告一次。
 * 不消耗随机数、不改动统计以外的状态，因此失败时比赛结果不受影响（只是这一条统计缺失）。
 */
let reported = false;
function safely(what: string, fn: () => void): void {
  revision++;
  try {
    fn();
  } catch (e) {
    if (!reported) {
      reported = true;
      console.error(`[pedia] ${what} 记录失败（已跳过）`, e);
    }
  }
}

/**
 * 读取（必要时创建 / 补齐）统计状态。justPlayed = 触发创建的这一局已计入 Player.stats.matches 的出场人数：
 * 创建时全联盟没有其他已赛对局（新游戏）→ 统计覆盖整个执教生涯（full）；旧存档从当前赛季 / 回合开始记录。
 */
export function pediaState(state: GameState, justPlayed = 0): PediaState {
  let ps = state.pedia as PediaState | undefined;
  if (!isObj(ps)) {
    let played = 0;
    for (const id in state.players) played += state.players[id]?.stats?.matches ?? 0;
    const fresh = played <= justPlayed;
    ps = {
      v: PEDIA_VERSION,
      seq: 0,
      since: [state.season?.ti ?? state.settings?.startTi ?? 0, fresh ? 0 : state.roundIndex ?? 0],
      ...(fresh ? { full: 1 as const } : {}),
      players: {},
      teams: {},
      tours: {},
      heroes: {},
      seasons: {},
      records: {},
    };
    state.pedia = ps;
    return ps;
  }
  if (ps.v === PEDIA_VERSION && isObj(ps.players) && isObj(ps.teams) && isObj(ps.tours) && isObj(ps.heroes)
    && isObj(ps.seasons) && isObj(ps.records)) return ps;
  // 旧格式（v1 存了逐局个人数据）：清除残留的 GameRecord.box
  if (ps.v !== PEDIA_VERSION) stripLegacyGameBoxes(state);
  // 手工编辑 / 截断的存档：补齐缺失的集合
  if (!Number.isFinite(ps.seq)) ps.seq = 0;
  if (!Array.isArray(ps.since)) ps.since = [state.season?.ti ?? 0, state.roundIndex ?? 0];
  if (!isObj(ps.players)) ps.players = {};
  if (!isObj(ps.teams)) ps.teams = {};
  if (!isObj(ps.tours)) ps.tours = {};
  if (!isObj(ps.heroes)) ps.heroes = {};
  if (!isObj(ps.seasons)) ps.seasons = {};
  if (!isObj(ps.records)) ps.records = {};
  ps.v = PEDIA_VERSION;
  return ps;
}

/**
 * 清除旧存档中的逐局个人数据（统计格式 v1 的 GameRecord.box：每局 10 行 [选手, 英雄, K, D, A]）。
 * 现在只保留聚合（生涯 / 分赛季 / 英雄 / 单局纪录），逐局明细不再存储；读档后第一次写入统计时（格式升级）执行一次，
 * 也可在读档时直接调用。覆盖赛事系列赛、进行中的比赛、多人模式的玩家对决与座位私有数据中的对局。不消耗随机数。
 * 返回清除的对局数。
 */
export function stripLegacyGameBoxes(state: GameState): number {
  let n = 0;
  const strip = (games: unknown): void => {
    if (!Array.isArray(games)) return;
    for (const g of games) {
      if (isObj(g) && 'box' in g) {
        delete g.box;
        n++;
      }
    }
  };
  const stripMatch = (m: unknown): void => {
    if (!isObj(m)) return;
    strip(m.games);
    strip([m.pendingGame]);
  };
  try {
    for (const t of Object.values(state?.tournaments ?? {})) {
      if (!isObj(t) || !isObj(t.series)) continue;
      for (const s of Object.values(t.series)) if (isObj(s) && isObj(s.result)) strip(s.result.games);
    }
    stripMatch(state?.activeMatch);
    const mp: unknown = state?.multiplayer;
    if (isObj(mp)) {
      if (isObj(mp.h2h)) for (const h of Object.values(mp.h2h)) stripMatch(h);
      if (isObj(mp.seats)) {
        for (const seat of Object.values(mp.seats)) {
          const top = isObj(seat) && isObj(seat.saved) ? seat.saved.top : undefined;
          if (isObj(top)) stripMatch(top.activeMatch);
        }
      }
    }
  } catch {
    // 截断 / 手工编辑的存档：清不干净也不影响任何流程（残留字段不再被读取）
  }
  return n;
}

// ---------------------------------------------------------------------------
// 档案条目
// ---------------------------------------------------------------------------

/** 选手档案（缺失时创建；同步显示名 / 位置快照） */
export function pediaPlayerEntry(ps: PediaState, p: Player): PediaPlayer {
  let e = ps.players[p.id];
  if (!isObj(e) || !Array.isArray(e.s)) {
    // 巅峰等级 / 评分在赛季末快照时更新（逐局路径只读选手的 id / 名字 / 位置 / 招牌英雄，不依赖其他模块）
    e = { n: p.handle, p: p.position, s: [], h: {}, cs: 0, bs: 0, pt: -1, pr: 0 };
    ps.players[p.id] = e;
    return e;
  }
  if (e.n !== p.handle && p.handle) e.n = p.handle;
  if (e.p !== p.position && p.position) e.p = p.position;
  if (!isObj(e.h)) e.h = {};
  return e;
}

/** 选手某赛季在某战队的数据行（缺失时创建） */
function seasonRow(e: PediaPlayer, ti: number, teamId: string): PediaPlayerSeason {
  // 从最新的行往前找（通常第一行即命中）；不按赛季提前截断：赛事的赛季可能早于已追加的行（如跨赛季结算），否则会重复建行
  for (let i = e.s.length - 1; i >= 0; i--) {
    const r = e.s[i];
    if (r[0] === ti && r[1] === teamId) return r;
  }
  const row: PediaPlayerSeason = [ti, teamId, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  // 保持按赛季排序（同赛季按出现先后）
  let at = e.s.length;
  while (at > 0 && e.s[at - 1][0] > ti) at--;
  e.s.splice(at, 0, row);
  return row;
}

/** 战队档案（缺失时创建；同步名称快照） */
function teamEntry(state: GameState, ps: PediaState, teamId: string): PediaTeam {
  const team = ownEntry(state.teams, teamId);
  let e = ps.teams[teamId];
  if (!isObj(e) || !Array.isArray(e.s)) {
    e = { n: team?.name ?? teamId, tag: team?.tag ?? '', s: [], scs: 0, sbs: 0, gcs: 0, gbs: 0 };
    ps.teams[teamId] = e;
  } else if (team) {
    if (team.name && e.n !== team.name) e.n = team.name;
    if (team.tag && e.tag !== team.tag) e.tag = team.tag;
  }
  return e;
}

function teamSeason(e: PediaTeam, ti: number): PediaTeamSeason {
  for (let i = e.s.length - 1; i >= 0; i--) {
    if (e.s[i]?.ti === ti) return e.s[i];
  }
  const row: PediaTeamSeason = { ti, sw: 0, sd: 0, sl: 0, gw: 0, gl: 0, k: 0, d: 0, pc: 0, pp: 0 };
  e.s.push(row);
  e.s.sort((a, b) => a.ti - b.ti);
  return row;
}

function heroLine(ps: PediaState, ti: number, heroId: string): PediaHeroLine {
  const key = String(ti);
  const map = (ps.heroes[key] ??= {});
  let line = map[heroId];
  if (!Array.isArray(line)) {
    line = [0, 0, 0, 0, 0, 0];
    map[heroId] = line;
  }
  return line;
}

function round1(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

// ---------------------------------------------------------------------------
// 分配工具（纯函数，测试可直接调用）
// ---------------------------------------------------------------------------

/**
 * 把整数 total 按权重分给各项（最大余数法），每项不超过 caps[i]（caps 缺省 = 无上限）。
 * 结果之和 = min(total, Σcaps)。确定性（同权重下按下标先后）。
 */
export function apportion(total: number, weights: readonly number[], caps?: readonly number[] | null): number[] {
  const n = weights.length;
  const out: number[] = new Array(n).fill(0);
  let left = Math.max(0, Math.round(Number.isFinite(total) ? total : 0));
  if (!n || !left) return out;
  if (!caps) {
    // 无上限：一次最大余数法
    let sw = 0;
    for (let i = 0; i < n; i++) sw += posW(weights[i]);
    const frac: number[] = new Array(n);
    let given = 0;
    for (let i = 0; i < n; i++) {
      const x = sw > 0 ? (left * posW(weights[i])) / sw : left / n;
      const f = Math.floor(x);
      out[i] = f;
      frac[i] = x - f;
      given += f;
    }
    for (let rem = left - given; rem > 0; rem--) {
      let best = 0;
      for (let i = 1; i < n; i++) if (frac[i] > frac[best]) best = i;
      out[best] += 1;
      frac[best] = -1;
    }
    return out;
  }
  // 有上限：反复「按比例会超出上限的项先填满」，其余按最大余数法
  const cap: number[] = new Array(n);
  const active: boolean[] = new Array(n);
  const frac: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = caps[i];
    cap[i] = c !== undefined && Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
    active[i] = cap[i] > 0;
  }
  for (let guard = 0; left > 0 && guard <= 2 * n + 2; guard++) {
    let sw = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      sw += posW(weights[i]);
      cnt++;
    }
    if (!cnt) break;
    let over = false;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const share = sw > 0 ? posW(weights[i]) / sw : 1 / cnt;
      frac[i] = left * share;
      if (frac[i] >= cap[i] - out[i]) over = true;
    }
    if (over) {
      // 先把会超出上限的项填满（按下标顺序），再进入下一轮
      let moved = 0;
      for (let i = 0; i < n && left > 0; i++) {
        if (!active[i] || frac[i] < cap[i] - out[i]) continue;
        const add = Math.min(left, cap[i] - out[i]);
        out[i] += add;
        left -= add;
        moved += add;
        active[i] = false;
      }
      if (moved > 0 || left <= 0) continue;
    }
    let given = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const f = Math.floor(frac[i]);
      out[i] += f;
      given += f;
      frac[i] -= f;
    }
    let rem = left - given;
    while (rem > 0) {
      let best = -1;
      for (let i = 0; i < n; i++) if (active[i] && out[i] < cap[i] && (best < 0 || frac[i] > frac[best])) best = i;
      if (best < 0) break;
      out[best] += 1;
      frac[best] = -1;
      rem--;
    }
    left = rem;
    for (let i = 0; i < n; i++) if (active[i] && out[i] >= cap[i]) active[i] = false;
  }
  return out;
}

function posW(w: number | undefined): number {
  return w !== undefined && Number.isFinite(w) && w > 0 ? w : 0;
}

/** 一名出场选手（match.simulateGame 的首发：位置 = 本局所打的位置） */
export interface StatSlot {
  pos: Position;
  player: Player;
}

/** 一方的 K/D/A 分配结果（与 slots 同序） */
export interface SideKda {
  kills: number[];
  deaths: number[];
  assists: number[];
}

/**
 * 一方 5 人的 K/D/A：kills 之和 = teamKills，deaths 之和 = teamDeaths；
 * 有直播数据（kd：选手 id → [击杀, 阵亡]，且总和与比分一致）时直接采用，否则按位置权重 × 发挥噪声 × MVP 倍数分配。
 * 助攻 = teamKills × U(assistsPerKill) 按助攻权重分配，每人 ≤ teamKills − 自己的击杀。
 */
export function allocateSideKda(
  rng: Rng, slots: readonly StatSlot[], teamKills: number, teamDeaths: number, mvpId: string | undefined,
  kd?: Record<string, [number, number]> | null,
): SideKda {
  const C = P();
  const n = slots.length;
  // 发挥噪声：对数尺度上均匀分布、标准差 σ（√3 × σ 为半宽；比正态便宜，分布形状不影响统计口径）；
  // 阵亡 / 助攻的 σ 比击杀小（真实比赛个人之间更平均，见 CONFIG.pedia.deathNoiseSigma / assistNoiseSigma）
  const hwK = SQRT3 * C.noiseSigma;
  const hwD = SQRT3 * C.deathNoiseSigma;
  const hwA = SQRT3 * C.assistNoiseSigma;
  const kw: number[] = new Array(n);
  const dw: number[] = new Array(n);
  const aw: number[] = new Array(n);
  // 噪声按固定顺序取数（每人 击杀 → 阵亡 → 助攻），保证可复现
  for (let i = 0; i < n; i++) {
    const s = slots[i];
    const mvp = !!mvpId && s.player.id === mvpId;
    kw[i] = (C.killWeight[s.pos] ?? 1) * Math.exp(hwK * (2 * rng.next() - 1)) * (mvp ? C.mvpKillMult : 1);
    dw[i] = (C.deathWeight[s.pos] ?? 1) * Math.exp(hwD * (2 * rng.next() - 1)) * (mvp ? C.mvpDeathMult : 1);
    aw[i] = (C.assistWeight[s.pos] ?? 1) * Math.exp(hwA * (2 * rng.next() - 1)) * (mvp ? C.mvpAssistMult : 1);
  }
  const apk = rng.range(C.assistsPerKill[0], C.assistsPerKill[1]);

  let kills: number[] | null = null;
  let deaths: number[] | null = null;
  if (kd && n > 0) {
    const k: number[] = new Array(n);
    const d: number[] = new Array(n);
    let ok = true;
    let sk = 0;
    let sd = 0;
    for (let i = 0; i < n && ok; i++) {
      const v = kd[slots[i].player.id];
      if (!v || !Number.isInteger(v[0]) || !Number.isInteger(v[1]) || v[0] < 0 || v[1] < 0) ok = false;
      else {
        k[i] = v[0];
        d[i] = v[1];
        sk += v[0];
        sd += v[1];
      }
    }
    if (ok && sk === teamKills && sd === teamDeaths) {
      kills = k;
      deaths = d;
    }
  }
  kills ??= apportion(teamKills, kw);
  deaths ??= apportion(teamDeaths, dw);
  const caps: number[] = new Array(n);
  for (let i = 0; i < n; i++) caps[i] = Math.max(0, teamKills - kills[i]);
  const target = Math.min(sumOf(caps), Math.round(teamKills * apk));
  const assists = apportion(target, aw, caps);
  return { kills, deaths, assists };
}

const SQRT3 = Math.sqrt(3);

function sumOf(arr: readonly number[]): number {
  let s = 0;
  for (const x of arr) s += x;
  return s;
}

// ---------------------------------------------------------------------------
// 英雄归属（无 BP 的 AI 快速模拟）
// ---------------------------------------------------------------------------

interface PoolEntry {
  id: string;
  w: number;
}

const poolCache = new Map<string, PoolEntry[]>();
const POOL_CACHE_MAX = 40;

/**
 * 版本强度表是否非空（按表对象缓存：换版本时整表替换；BP 的 fillHeroMeta 只补齐非空表，空表不会变为非空）。
 * 英雄 id 含连字符，强度表是字典模式对象，逐局 for-in 判空的开销与整表大小成正比，因此缓存。
 */
const metaEmptyCache = new WeakMap<object, boolean>();
function metaNonEmpty(meta: Record<string, number>): boolean {
  let v = metaEmptyCache.get(meta);
  if (v === undefined) {
    v = false;
    for (const _ in meta) {
      v = true;
      break;
    }
    if (v) metaEmptyCache.set(meta, v); // 只缓存非空（空表理论上不会被填充，但不缓存更稳妥）
  }
  return v;
}

/**
 * 某位置的版本候选（按 位置适配 × e^(版本强度 × metaWeight) 取前 metaPoolSize 个；按日期 + 版本缓存）。
 * 版本强度取 state.heroMeta，表中缺失的英雄按同一公式 heroes.heroMetaValue(版本, 英雄) 补算（不依赖该表是否已由 BP 补齐），
 * 因此候选只取决于（日期, 版本, 是否有强度表）：进程内多个存档（多人服务器的多个房间）共用缓存也不会互相影响。
 */
function metaPool(state: GameState, date: string, pos: Position): PoolEntry[] {
  const meta = state.heroMeta ?? {};
  const hasMeta = metaNonEmpty(meta);
  const key = `${date}|${state.currentPatch ?? ''}|${hasMeta ? 1 : 0}|${pos}`;
  const hit = poolCache.get(key);
  if (hit) return hit;
  const C = P();
  let patch: ReturnType<typeof patchByVersion> | null = null;
  const list: PoolEntry[] = [];
  for (const h of availableHeroes(date)) {
    const fit = h.positions?.[pos] ?? 0;
    if (!(fit >= C.minPositionFit)) continue;
    // 空表 = 无版本强度数据（全部按 0，与 BP 同口径）；表中缺失（版本生效后才上线、BP 尚未补齐）的英雄按同一公式补算
    let m = 0;
    if (hasMeta) {
      if (Number.isFinite(meta[h.id])) m = meta[h.id];
      else {
        if (patch === null) patch = (state.currentPatch ? patchByVersion(state.currentPatch) : undefined) ?? undefined;
        m = patch ? heroMetaValue(patch, h.id) : 0;
      }
    }
    list.push({ id: h.id, w: fit * Math.exp(m * C.metaWeight) });
  }
  list.sort((a, b) => b.w - a.w || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pool = list.slice(0, Math.max(1, C.metaPoolSize));
  if (poolCache.size >= POOL_CACHE_MAX) poolCache.clear();
  poolCache.set(key, pool);
  return pool;
}

const availCache = new Map<string, Set<string>>();

/** 某日期已上线的英雄 id 集合（缓存；与 BP 英雄池同口径） */
function availableSet(date: string): Set<string> {
  let set = availCache.get(date);
  if (!set) {
    set = new Set(availableHeroes(date).map((h) => h.id));
    if (availCache.size >= POOL_CACHE_MAX) availCache.clear();
    availCache.set(date, set);
  }
  return set;
}

/** 为一名选手挑选本局英雄（确定性；避开本局已用英雄） */
function pickHero(
  state: GameState, rng: Rng, date: string, slot: StatSlot, taken: Set<string>, avail: Set<string>,
  pools: Partial<Record<Position, PoolEntry[]>>,
): string {
  const C = P();
  const sig: string[] = [];
  for (const h of slot.player.signatureHeroes ?? []) if (avail.has(h) && !taken.has(h)) sig.push(h);
  if (sig.length > 0 && rng.chance(C.signatureShare)) return sig.length === 1 ? sig[0] : sig[Math.floor(rng.next() * sig.length)];
  const pool = (pools[slot.pos] ??= metaPool(state, date, slot.pos));
  let total = 0;
  for (const e of pool) if (!taken.has(e.id)) total += e.w;
  if (total > 0) {
    let r = rng.next() * total;
    let last = '';
    for (const e of pool) {
      if (taken.has(e.id)) continue;
      last = e.id;
      r -= e.w;
      if (r < 0) return e.id;
    }
    return last;
  }
  if (sig.length) return sig[0];
  for (const id of avail) if (!taken.has(id)) return id;
  return '';
}

// ---------------------------------------------------------------------------
// 记录：单局
// ---------------------------------------------------------------------------

/** recordGameStats 的输入：双方首发（与 simulateGame 记录 Player.stats 的首发一致）、直播中的个人击杀 / 阵亡 */
export interface GameStatsInput {
  A: readonly StatSlot[];
  B: readonly StatSlot[];
  tier: TournamentTier;
  kd?: Record<string, [number, number]> | null;
}

/** 刷新单局纪录（先创造者保持，追平不替换）：lower = 数值越小越好（最短对局） */
function bumpRecord(
  ps: PediaState, kind: PediaRecordKind, v: number, lower: boolean,
  base: { ti: number; d: string; tier: TournamentTier }, t: string, o: string, p?: string, h?: string,
): void {
  if (!(v > 0)) return;
  const cur = ps.records[kind];
  if (cur && Number.isFinite(cur.v) && (lower ? v >= cur.v : v <= cur.v)) return;
  const rec: PediaRecord = { v, ti: base.ti, d: base.d, t, o, tier: base.tier };
  if (p) rec.p = p;
  if (h) rec.h = h;
  ps.records[kind] = rec;
}

/**
 * 记录一局（match.simulateGame 调用）：把本局 K/D/A、英雄、胜负、时长累加到各项聚合并刷新单局纪录（不存逐局个人数据）。
 * 只使用独立子随机流，不影响主随机序列；CONFIG.pedia.enabled = false 时不做任何事。
 */
export function recordGameStats(state: GameState, g: GameRecord, input: GameStatsInput): void {
  if (!pediaEnabled() || !g) return;
  safely('单局', () => recordGame(state, g, input));
}

function recordGame(state: GameState, g: GameRecord, input: GameStatsInput): void {
  const ps = pediaState(state, (input.A?.length ?? 0) + (input.B?.length ?? 0));
  ps.seq += 1;
  const rng = pediaGameRng(state.id, ps.seq);
  const ti = state.season?.ti ?? 0;
  const winA = g.winner === 'A';
  const killsA = g.killsA || 0;
  const killsB = g.killsB || 0;
  const slotsOf = [input.A ?? [], input.B ?? []];
  const teamOf = [g.teamA, g.teamB];
  const killsOf = [killsA, killsB];
  const winOf = [winA, !winA];

  // 1. 英雄：BP 优先（按选手 id，其次按位置），其余确定性挑选（同局不重复）
  const heroOf = new Map<string, string>();
  const taken = new Set<string>();
  const draft = g.draft ?? [];
  if (draft.length) {
    for (let si = 0; si < 2; si++) {
      const side = si === 0 ? 'A' : 'B';
      const slots = slotsOf[si];
      const loose: typeof draft = [];
      for (const a of draft) {
        if (a.type !== 'pick' || a.side !== side || !a.heroId) continue;
        if (a.playerId && !heroOf.has(a.playerId) && slots.some((x) => x.player.id === a.playerId)) {
          heroOf.set(a.playerId, a.heroId);
          taken.add(a.heroId);
        } else loose.push(a);
      }
      for (const a of loose) {
        if (taken.has(a.heroId)) continue;
        const slot = slots.find((x) => x.pos === a.position && !heroOf.has(x.player.id))
          ?? slots.find((x) => !heroOf.has(x.player.id));
        if (!slot) continue;
        heroOf.set(slot.player.id, a.heroId);
        taken.add(a.heroId);
      }
    }
  }
  let avail: Set<string> | null = null;
  let heroDate = '';
  const pools: Partial<Record<Position, PoolEntry[]>> = {};
  for (let si = 0; si < 2; si++) {
    for (const slot of slotsOf[si]) {
      if (heroOf.has(slot.player.id)) continue;
      if (!avail) {
        heroDate = draftHeroDate(state);
        avail = availableSet(heroDate);
      }
      const h = pickHero(state, rng, heroDate, slot, taken, avail, pools);
      heroOf.set(slot.player.id, h);
      if (h) taken.add(h);
    }
  }

  // 2. K/D/A（A 方击杀之和 = killsA，A 方阵亡之和 = killsB）
  const kdaA = allocateSideKda(rng, slotsOf[0], killsA, killsB, g.mvpPlayerId, input.kd);
  const kdaB = allocateSideKda(rng, slotsOf[1], killsB, killsA, g.mvpPlayerId, input.kd);

  // 3. 聚合
  const st = (ps.seasons[String(ti)] ??= [0, 0, 0]);
  st[0] += 1;
  st[1] += killsA + killsB;
  st[2] += g.durationMin || 0;
  // 单局纪录候选（本局个人击杀 / 助攻 / 阵亡最多者：[选手 id, 英雄 id]）
  let bk = -1;
  let ba = -1;
  let bd = -1;
  let bkAt: LineRef | null = null;
  let baAt: LineRef | null = null;
  let bdAt: LineRef | null = null;
  let bkSide = 0;
  let baSide = 0;
  let bdSide = 0;
  for (let si = 0; si < 2; si++) {
    const kda = si === 0 ? kdaA : kdaB;
    const teamId = teamOf[si];
    const win = winOf[si];
    const te = teamEntry(state, ps, teamId);
    const tr = teamSeason(te, ti);
    if (win) {
      tr.gw += 1;
      te.gcs += 1;
      if (te.gcs > te.gbs) te.gbs = te.gcs;
    } else {
      tr.gl += 1;
      te.gcs = 0;
    }
    tr.k += killsOf[si];
    tr.d += killsOf[1 - si];
    tr.m = (tr.m ?? 0) + (g.durationMin || 0);
    const slots = slotsOf[si];
    for (let i = 0; i < slots.length; i++) {
      const p = slots[i].player;
      const k = kda.kills[i] ?? 0;
      const d = kda.deaths[i] ?? 0;
      const a = kda.assists[i] ?? 0;
      const hero = heroOf.get(p.id) ?? '';
      const line: LineRef = [p.id, hero];
      const e = pediaPlayerEntry(ps, p);
      const row = seasonRow(e, ti, teamId);
      row[2] += 1;
      row[4] += k;
      row[5] += d;
      row[6] += a;
      if (g.mvpPlayerId === p.id) row[7] += 1;
      if (win) {
        row[3] += 1;
        e.cs += 1;
        if (e.cs > e.bs) e.bs = e.cs;
      } else e.cs = 0;
      if (hero) {
        const hh = e.h[hero];
        if (hh) {
          hh[0] += 1;
          if (win) hh[1] += 1;
        } else e.h[hero] = [1, win ? 1 : 0];
        const hl = heroLine(ps, ti, hero);
        hl[0] += 1;
        if (win) hl[1] += 1;
        hl[2] += k;
        hl[3] += d;
        hl[4] += a;
      }
      if (k > bk) { bk = k; bkAt = line; bkSide = si; }
      if (a > ba) { ba = a; baAt = line; baSide = si; }
      if (d > bd) { bd = d; bdAt = line; bdSide = si; }
    }
  }
  for (const a of draft) if (a.type === 'ban' && a.heroId) heroLine(ps, ti, a.heroId)[5] += 1;

  // 4. 单局纪录（先创造者保持，追平不替换）
  const base = { ti, d: state.currentDate ?? '', tier: input.tier };
  const rec = (kind: PediaRecordKind, line: LineRef | null, v: number, si: number) => {
    if (line) bumpRecord(ps, kind, v, false, base, teamOf[si], teamOf[1 - si], line[0], line[1] || undefined);
  };
  rec('kills', bkAt, bk, bkSide);
  rec('assists', baAt, ba, baSide);
  rec('deaths', bdAt, bd, bdSide);
  const top = killsA >= killsB ? 0 : 1;
  bumpRecord(ps, 'teamKills', killsOf[top], false, base, teamOf[top], teamOf[1 - top]);
  const w = winA ? 0 : 1;
  bumpRecord(ps, 'totalKills', killsA + killsB, false, base, teamOf[w], teamOf[1 - w]);
  const dur = g.durationMin || 0;
  bumpRecord(ps, 'longest', dur, false, base, teamOf[w], teamOf[1 - w]);
  bumpRecord(ps, 'shortest', dur, true, base, teamOf[w], teamOf[1 - w]);
}

/** 单局纪录候选的选手与英雄 */
type LineRef = [playerId: string, heroId: string];

// ---------------------------------------------------------------------------
// 记录：系列赛 / 赛事
// ---------------------------------------------------------------------------

/** 当前首发（与 match.lineupOf 同口径：禁赛 / 退役视为空缺） */
function lineupIds(state: GameState, teamId: string): string[] {
  const team = ownEntry(state.teams, teamId);
  if (!team) return [];
  const out: string[] = [];
  for (const pos of POSITIONS) {
    const id = team.lineup?.[pos];
    const p = id ? state.players[id] : undefined;
    if (p && (!p.status || p.status === 'active')) out.push(p.id);
  }
  return out;
}

/**
 * 记录一场系列赛结果（tournament.recordSeriesResult 调用）：战队系列赛胜 / 平 / 负（含弃权）与系列赛连胜；
 * 非弃权的系列赛另计入双方当前首发的系列赛战绩。
 */
export function recordSeriesStats(state: GameState, t: Tournament, s: Series, res: SeriesResult, isDraw: boolean): void {
  if (!pediaEnabled() || !t || !s?.teamA || !s.teamB || !res) return;
  const teams = [s.teamA, s.teamB];
  safely('系列赛', () => recordSeries(state, t, teams, res, isDraw));
}

function recordSeries(state: GameState, t: Tournament, teams: readonly string[], res: SeriesResult, isDraw: boolean): void {
  const ps = pediaState(state);
  const ti = t.season ?? state.season?.ti ?? 0;
  const outcome = (teamId: string): 'w' | 'd' | 'l' => (isDraw ? 'd' : res.winnerId === teamId ? 'w' : 'l');
  const forfeit = res.forfeit === 'A' || res.forfeit === 'B';
  for (const teamId of teams) {
    const o = outcome(teamId);
    const te = teamEntry(state, ps, teamId);
    const tr = teamSeason(te, ti);
    if (o === 'w') {
      tr.sw += 1;
      te.scs += 1;
      if (te.scs > te.sbs) te.sbs = te.scs;
    } else {
      if (o === 'd') tr.sd += 1;
      else tr.sl += 1;
      te.scs = 0;
    }
    if (forfeit) continue;
    for (const id of lineupIds(state, teamId)) {
      const p = state.players[id];
      if (!p) continue;
      const row = seasonRow(pediaPlayerEntry(ps, p), ti, teamId);
      row[o === 'w' ? 9 : o === 'd' ? 10 : 11] += 1;
    }
  }
}

function tourEntry(ps: PediaState, t: Tournament): PediaTournament {
  let e = ps.tours[t.id];
  if (!isObj(e)) {
    e = { s: t.season, d: t.startDate ?? '', pool: Math.round(t.prizePool || 0), top: [], pz: {} };
    ps.tours[t.id] = e;
  }
  return e;
}

/**
 * 记录一支战队在某赛事的名次奖金拆分（tournament.finishTournament 在发奖后调用）：
 * 战队赛季奖金（俱乐部 / 队员分成）、每名队员分到的奖金；前四名另记入赛事档案。
 */
export function recordPrizeSplit(
  state: GameState, t: Tournament, teamId: string, rankFrom: number,
  split: { club: number; players: number; cuts?: { playerId: string; amount: number }[] } | null,
): void {
  if (!pediaEnabled() || !t || !split || !teamId) return;
  const club = Math.max(0, Math.round(split.club || 0));
  const players = Math.max(0, Math.round(split.players || 0));
  if (club + players <= 0) return;
  safely('奖金', () => recordPrize(state, t, teamId, rankFrom, split, club, players));
}

function recordPrize(
  state: GameState, t: Tournament, teamId: string, rankFrom: number,
  split: { cuts?: { playerId: string; amount: number }[] }, club: number, players: number,
): void {
  const ps = pediaState(state);
  const ti = t.season ?? state.season?.ti ?? 0;
  const tr = teamSeason(teamEntry(state, ps, teamId), ti);
  tr.pc += club;
  tr.pp += players;
  if (rankFrom <= 4) tourEntry(ps, t).pz[teamId] = [club, players];
  for (const c of split.cuts ?? []) {
    const p = state.players[c.playerId];
    if (!p || p.isWildSub || !(c.amount > 0)) continue;
    seasonRow(pediaPlayerEntry(ps, p), ti, teamId)[8] += Math.round(c.amount);
  }
}

/**
 * 赛事结束时的名次首发（tournament.finishTournament 在冠军头衔之后、临时替补离队之前调用）：
 * 冠亚军（TI 为全部正赛队伍）的当时首发——与 Player.stats.titles 同口径（首发，空缺时取前 5 名队员）。
 */
export function recordTournamentStats(state: GameState, t: Tournament): void {
  if (!pediaEnabled() || !t) return;
  safely('赛事名次', () => recordTournament(state, t));
}

function recordTournament(state: GameState, t: Tournament): void {
  const isTi = t.tier === 'ti';
  const mainSize = Math.max(1, t.size ?? t.teamIds.length);
  const rows = t.placements.filter((p) => (isTi ? p.rankFrom <= mainSize : p.rankFrom <= 2));
  if (!rows.length && !(state.pedia?.tours?.[t.id])) return;
  const ps = pediaState(state);
  const e = tourEntry(ps, t);
  e.top = [];
  for (const pl of rows.sort((a, b) => a.rankFrom - b.rankFrom || a.rankTo - b.rankTo)) {
    const team = state.teams[pl.teamId];
    if (!team) continue;
    const lineup = Object.values(team.lineup ?? {}).filter((x): x is string => !!x);
    const ids = (lineup.length > 0 ? lineup : team.playerIds.slice(0, 5)).filter((id) => {
      const p = state.players[id];
      return !!p && p.teamId === team.id && !p.isWildSub;
    });
    for (const id of ids) pediaPlayerEntry(ps, state.players[id]);
    teamEntry(state, ps, team.id);
    e.top.push([pl.teamId, pl.rankFrom, pl.rankTo, ids]);
  }
}

// ---------------------------------------------------------------------------
// 记录：赛季末快照
// ---------------------------------------------------------------------------

/** 选手英雄表压缩：只保留局数最多的 heroesPerPlayer 个，其余并入 ho */
export function compactHeroes(e: PediaPlayer, keep: number = P().heroesPerPlayer): void {
  const ids = Object.keys(e.h ?? {});
  if (ids.length <= keep) return;
  ids.sort((a, b) => e.h[b][0] - e.h[a][0] || e.h[b][1] - e.h[a][1] || (a < b ? -1 : 1));
  const other = e.ho ?? [0, 0];
  for (const id of ids.slice(Math.max(0, keep))) {
    other[0] += e.h[id][0];
    other[1] += e.h[id][1];
    delete e.h[id];
  }
  e.ho = other;
}

/**
 * 赛季末快照（season.settleSeason 在 TI 结束、退役之前调用）：各战队的荣誉、赛季综合排名、实力排名、阵容、主教练；
 * 在籍选手的巅峰等级 / 评分；压缩选手英雄表。同一赛季重复调用会覆盖（幂等）。
 */
export function recordPediaSeasonEnd(state: GameState): void {
  if (!pediaEnabled()) return;
  safely('赛季末快照', () => recordSeasonEnd(state));
}

function recordSeasonEnd(state: GameState): void {
  const ps = pediaState(state);
  const ti = state.season?.ti ?? 0;
  const ids = Object.values(state.teams).filter((t) => !t.disbanded && (t.playerIds?.length ?? 0) > 0).map((t) => t.id);
  let order: string[] = [];
  try {
    order = rankTeamsByRating(state, ids);
  } catch {
    order = ids.slice();
  }
  order.forEach((teamId, i) => {
    const team = ownEntry(state.teams, teamId);
    if (!team) return;
    const row = teamSeason(teamEntry(state, ps, teamId), ti);
    row.h = Math.round(team.honor ?? 0);
    row.fr = team.lastSeasonRank ?? 0;
    row.sr = i + 1;
    row.st = order.length;
    const members = (team.playerIds ?? [])
      .map((id) => state.players[id])
      .filter((p): p is Player => !!p && p.status === 'active' && p.teamId === teamId && !p.tempSubUntilTournament && !p.isWildSub);
    members.sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : 1));
    row.r = members.map((p) => p.id);
    for (const p of members) pediaPlayerEntry(ps, p);
    const coach = team.coachId ? state.coaches[team.coachId] : undefined;
    row.c = coach ? [coach.id, coach.name] : null;
  });
  for (const id in state.players) {
    const p = state.players[id];
    if (!p || p.isWildSub || p.status !== 'active') continue;
    const e = ps.players[id];
    if (!e) continue;
    const t = tierIndex(playerTier(p));
    if (!(e.pt >= t)) e.pt = t;
    const r = round1(overallRating(p));
    if (!(e.pr >= r)) e.pr = r;
  }
  for (const id in ps.players) compactHeroes(ps.players[id]);
}

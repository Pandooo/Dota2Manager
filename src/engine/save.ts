// 存档（localStorage，多存档位）【E5 负责实现】
// 无 localStorage 的环境（Node/测试/隐私模式）下所有操作安全降级。
import type { GameState } from './types';
import { POSITIONS } from './types';
import { SAVE_VERSION } from './config';
import { stripLegacyGameBoxes } from './stats';
import { migrateTransferListings } from './squadOps';

export interface SaveMeta {
  slot: string;               // 'auto' | '1' | '2' | '3' ...
  savedAt: string;            // ISO 时间
  teamName: string;
  ti: number;
  round: number;
  honor: number;
  gold: number;
}

const SAVE_PREFIX = 'd2m:save:';
const META_PREFIX = 'd2m:meta:';

/** 存档必须包含的顶层键 */
const REQUIRED_KEYS: (keyof GameState)[] = [
  'version', 'settings', 'rngState', 'season', 'roundIndex', 'phase', 'teams', 'players', 'tournaments',
];

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function getStorage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike };
    if (typeof g.localStorage === 'undefined' || g.localStorage === null) return null;
    return g.localStorage;
  } catch {
    // 某些浏览器隐私模式访问 localStorage 会抛错
    return null;
  }
}

function buildMeta(state: GameState, slot: string): SaveMeta {
  const team = state.teams?.[state.settings?.playerTeamId];
  return {
    slot,
    // 存档时间为真实时间，仅用于存档列表展示，不参与模拟
    savedAt: new Date().toISOString(),
    teamName: team?.name ?? '未知战队',
    ti: state.season?.ti ?? 0,
    round: state.roundIndex ?? 0,
    honor: Math.round(team?.honor ?? 0),
    gold: Math.round(team?.gold ?? 0),
  };
}

/** 存档位列表（读取 localStorage 'd2m:meta:*'）；无 localStorage 环境返回 [] */
export function listSaves(): SaveMeta[] {
  const ls = getStorage();
  if (!ls) return [];
  const out: SaveMeta[] = [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(META_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const raw = ls.getItem(k);
      if (!raw) continue;
      try {
        const meta = JSON.parse(raw) as SaveMeta;
        if (meta && typeof meta.slot === 'string') out.push(meta);
      } catch {
        // 损坏的元数据：跳过
      }
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
}

/** 保存（JSON 序列化，写 'd2m:save:{slot}' 与 'd2m:meta:{slot}'），失败返回 false（如超出配额） */
export function saveGame(state: GameState, slot: string): boolean {
  const ls = getStorage();
  if (!ls || !slot) return false;
  let json: string;
  try {
    json = JSON.stringify(state);
  } catch {
    return false;
  }
  try {
    ls.setItem(SAVE_PREFIX + slot, json);
  } catch {
    // 超出配额等：写入失败时旧存档保持不变
    return false;
  }
  try {
    ls.setItem(META_PREFIX + slot, JSON.stringify(buildMeta(state, slot)));
  } catch {
    return false;
  }
  return true;
}

export function loadGame(slot: string): GameState | null {
  const ls = getStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(SAVE_PREFIX + slot);
    if (!raw) return null;
    return importSave(raw);
  } catch {
    return null;
  }
}

export function deleteSave(slot: string): void {
  const ls = getStorage();
  if (!ls) return;
  try {
    ls.removeItem(SAVE_PREFIX + slot);
    ls.removeItem(META_PREFIX + slot);
  } catch {
    // 忽略
  }
}

/** 导出为 JSON 字符串 */
export function exportSave(state: GameState): string {
  return JSON.stringify(state);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 旧存档/缺字段时补齐可选集合，保证引擎可继续运行 */
function normalizeState(s: GameState): GameState {
  s.coaches ??= {};
  s.seasonTournamentIds ??= [];
  s.futureRookies ??= {};
  // 第八波取消玩家抽卡：旧存档残留的卡池选手（本就无东家）直接回到自由市场
  s.gachaPool = [];
  s.gachaPity ??= 0;
  s.transferOffers ??= [];
  s.tempSubCandidates ??= [];
  s.activeMatch ??= null;
  s.freeTrainingUsed ??= false;
  s.extraTrainingAvailable ??= 0;
  s.extraTrainingBoughtThisRound ??= 0;
  s.trainingFocus ??= 'balanced';
  s.beefs ??= [];
  s.pendingDecisions ??= [];
  s.news ??= [];
  s.finance ??= [];
  s.popups ??= [];
  s.appliedPatches ??= [];
  s.heroMeta ??= {};
  s.gameOver ??= null;
  s.idCounter ??= 0;
  s.currentDate ??= s.season?.startDate ?? '';
  s.currentPatch ??= s.appliedPatches[s.appliedPatches.length - 1] ?? '';
  const h = (s.history ??= {} as GameState['history']);
  h.tournaments ??= [];
  h.seasons ??= [];
  h.honor ??= [];
  h.gold ??= [];
  h.playerSettlements ??= [];
  if (s.season) {
    s.season.rounds ??= [];
    s.season.registeredTournamentIds ??= [];
    s.season.extraTrainingsBought ??= 0;
    for (const r of s.season.rounds) {
      if (!r) continue;
      r.tournamentIds ??= [];
      r.patchVersions ??= [];
    }
  }
  // 实体内的集合字段（手工编辑/截断的存档）
  for (const id in s.players) {
    const p = s.players[id];
    if (!isObj(p)) {
      delete s.players[id];
      continue;
    }
    p.modifiers ??= [];
    p.signatureHeroes ??= [];
    p.stats ??= { matches: 0, wins: 0, titles: 0, tiTitles: 0, mvp: 0 };
    p.status ??= 'active';
    p.teamId ??= null;
  }
  for (const id in s.teams) {
    const t = s.teams[id];
    if (!isObj(t)) {
      delete s.teams[id];
      continue;
    }
    t.playerIds = (t.playerIds ?? []).filter((pid) => !!s.players[pid]);
    t.lineup ??= { C: null, M: null, O: null, SS: null, HS: null };
    for (const pos of POSITIONS) {
      const pid = t.lineup[pos];
      if (pid === undefined || (pid !== null && !s.players[pid])) t.lineup[pos] = null;
    }
    t.coachId ??= null;
    t.points ??= 0;
  }
  for (const id in s.tournaments) {
    const t = s.tournaments[id];
    if (!isObj(t)) {
      delete s.tournaments[id];
      continue;
    }
    t.teamIds ??= [];
    t.invitedTeamIds ??= [];
    t.qualifierTeamIds ??= [];
    t.stages ??= [];
    t.series ??= {};
    t.placements ??= [];
  }
  return s;
}

const PHASES: readonly string[] = ['preseason', 'regular', 'ti_qualifier', 'ti', 'season_end'];

/** 导入并校验（version 字段、必要键），失败抛中文错误 */
export function importSave(json: string): GameState {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('存档文件不是有效的 JSON');
  }
  if (!isObj(data)) throw new Error('存档格式错误：内容不是对象');
  // 多人对战的座位视图（客户端导出 / 缓存的快照）：其他玩家的私有数据已被剥离、多支战队标记为玩家战队，
  // 单机引擎无法继续推进（会卡住），因此拒绝导入；多人进度保存在房主的服务器上
  if (data.multiplayer !== undefined && data.multiplayer !== null) {
    throw new Error('这是多人对战（局域网）的对局存档，不能在单机模式中导入。多人对局的进度保存在房主的服务器上，重新进入房间即可继续');
  }
  delete data.multiplayer;
  const missing = REQUIRED_KEYS.filter((k) => !(k in data));
  if (missing.length) throw new Error(`存档缺少必要字段：${missing.join('、')}`);
  const version = data.version;
  if (typeof version !== 'number' || !Number.isFinite(version)) throw new Error('存档版本号无效');
  if (version > SAVE_VERSION) throw new Error(`存档版本（v${version}）高于当前游戏版本（v${SAVE_VERSION}），请更新游戏`);
  if (!isObj(data.settings) || typeof data.settings.playerTeamId !== 'string') {
    throw new Error('存档损坏：缺少玩家设置');
  }
  if (!isObj(data.teams) || !isObj(data.players) || !isObj(data.tournaments)) {
    throw new Error('存档损坏：战队/选手/赛事数据格式错误');
  }
  if (!isObj(data.teams[data.settings.playerTeamId])) throw new Error('存档损坏：找不到玩家战队');
  if (!isObj(data.season) || typeof data.season.ti !== 'number' || !Number.isFinite(data.season.ti)) {
    throw new Error('存档损坏：缺少赛季数据');
  }
  if (typeof data.rngState !== 'number' || !Number.isFinite(data.rngState)) throw new Error('存档损坏：随机数种子无效');
  if (typeof data.phase !== 'string' || !PHASES.includes(data.phase)) throw new Error('存档损坏：赛季阶段无效');
  if (typeof data.roundIndex !== 'number' || !Number.isInteger(data.roundIndex) || data.roundIndex < 0) {
    throw new Error('存档损坏：回合序号无效');
  }
  const state = normalizeState(data as unknown as GameState);
  // 旧存档（DotaPedia 统计格式 v1）的逐局个人 K/D/A（GameRecord.box）不再存储：读档即清除
  stripLegacyGameBoxes(state);
  // 旧存档的「3 个转会回合」挂牌：按已经过的回合迁移到整赛季挂牌期（squadOps.migrateListing，幂等）
  migrateTransferListings(state);
  // 未来的存档迁移在这里按 version 逐级处理
  state.version = SAVE_VERSION;
  return state;
}

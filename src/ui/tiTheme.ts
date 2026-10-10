// ============================================================================
// TI 主题与转场触发（第八波 item 8）：纯函数，不依赖 React（tests/tiTheme.test.ts 直接导入）。
// - 主题：src/data/tis.json 每届的 theme（官方主视觉配色）；缺失 / 非法时逐字段回退到默认主题。
// - 触发：进入 TI 正赛回合 → 全屏转场（'main'）；TI 预选回合 → 顶部横幅（'qualifier'）。
//   每个存档（id + 创建时间）× 座位（玩家战队）× 届次 × 类型只触发一次；「已看过」记在 localStorage
//   （不可用时只记在内存，本次页面会话内仍只触发一次）。单机与多人的座位视图走同一套逻辑。
// ============================================================================
import type { GameState, TiInfo, TiTheme } from '../engine/types';
import { getAllTiInfo } from '../data/index';

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v);
}

/** 默认主题（Dota 暗红 + 金色；数据缺失 / 损坏时使用） */
export const DEFAULT_TI_THEME: Readonly<TiTheme> = Object.freeze({
  name: '不朽之盾',
  primary: '#C23C2A',
  secondary: '#0E1118',
  accent: '#E5B24D',
});

/** 主题数据问题列表（空数组 = 合法）：名称非空，primary / secondary / accent 为 #RRGGBB，text 可选但须合法 */
export function tiThemeProblems(theme: unknown): string[] {
  if (!theme || typeof theme !== 'object') return ['缺少 theme'];
  const t = theme as Record<string, unknown>;
  const out: string[] = [];
  if (typeof t.name !== 'string' || !t.name.trim()) out.push('name 为空');
  for (const k of ['primary', 'secondary', 'accent'] as const) if (!isHexColor(t[k])) out.push(`${k} 不是 #RRGGBB`);
  if (t.text !== undefined && !isHexColor(t.text)) out.push('text 不是 #RRGGBB');
  return out;
}

/** 逐字段回退：非法字段用默认主题补齐 */
export function resolveTiTheme(theme: Partial<TiTheme> | null | undefined): TiTheme {
  const t = theme && typeof theme === 'object' ? theme : {};
  return {
    name: typeof t.name === 'string' && t.name.trim() ? t.name : DEFAULT_TI_THEME.name,
    primary: isHexColor(t.primary) ? t.primary : DEFAULT_TI_THEME.primary,
    secondary: isHexColor(t.secondary) ? t.secondary : DEFAULT_TI_THEME.secondary,
    accent: isHexColor(t.accent) ? t.accent : DEFAULT_TI_THEME.accent,
    text: isHexColor(t.text) ? t.text : undefined,
  };
}

/** 某届 TI 的静态数据（缺失返回 null，不抛错） */
export function tiInfoOf(ti: number): TiInfo | null {
  try {
    return getAllTiInfo().find((t) => t.ti === ti) ?? null;
  } catch {
    return null;
  }
}

/** 某届 TI 的主题（总是返回合法主题） */
export function tiThemeOf(ti: number): TiTheme {
  return resolveTiTheme(tiInfoOf(ti)?.theme);
}

/** #RRGGBB → [r, g, b]（非法值按默认主色） */
export function hexToRgb(hex: string): [number, number, number] {
  const h = isHexColor(hex) ? hex : DEFAULT_TI_THEME.primary;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** #RRGGBB + 透明度 → rgba() */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ---------------------------------------------------------------------------
// 转场触发
// ---------------------------------------------------------------------------
/** main = 进入 TI 正赛回合（全屏转场）；qualifier = TI 预选回合（顶部横幅） */
export type TiIntroKind = 'main' | 'qualifier';

export interface TiIntroCue {
  kind: TiIntroKind;
  ti: number;
  /** 「已看过」记录键：存档 × 座位 × 届次 × 类型 */
  key: string;
}

/** 触发判断用到的状态字段（单机状态或多人座位视图） */
export type TiIntroView = Pick<GameState, 'id' | 'createdAt' | 'phase' | 'season' | 'settings' | 'gameOver'>;

/** 「已看过」记录键：存档 id + 创建时间（同一种子重开的新档不会共用）+ 座位战队 + 届次 + 类型 */
export function tiIntroKey(game: Pick<GameState, 'id' | 'createdAt' | 'settings'>, ti: number, kind: TiIntroKind): string {
  const gid = `${game.id ?? ''}@${game.createdAt ?? ''}`;
  const seat = game.settings?.playerTeamId ?? '';
  return `${gid}|${seat}|ti${ti}|${kind}`;
}

/** 当前阶段对应的转场类型（非 TI 回合为 null） */
export function tiIntroKindOf(phase: unknown): TiIntroKind | null {
  return phase === 'ti' ? 'main' : phase === 'ti_qualifier' ? 'qualifier' : null;
}

/**
 * 纯函数：当前视图是否应触发 TI 转场 / 预选横幅。
 * 处于 TI 正赛（或预选）回合、游戏未结束、且该存档 × 座位 × 届次 × 类型尚未看过 → 返回提示；否则 null。
 * 调用方在展示时把 cue.key 记为已看过，之后同一届不会再次触发。
 */
export function tiIntroCue(game: TiIntroView | null | undefined, seen: (key: string) => boolean): TiIntroCue | null {
  if (!game || typeof game !== 'object' || game.gameOver) return null;
  const kind = tiIntroKindOf(game.phase);
  if (!kind) return null;
  const ti = Number(game.season?.ti);
  if (!Number.isInteger(ti) || ti <= 0) return null;
  const key = tiIntroKey(game, ti, kind);
  let already = false;
  try {
    already = seen(key);
  } catch {
    already = false;
  }
  return already ? null : { kind, ti, key };
}

/** 展示条件的输入：页面是否可见、当前座位待显示的弹窗数（game.popups） */
export interface TiIntroShowCtx {
  visible: boolean;
  popupsPending: number;
}

/**
 * 纯函数：已触发的提示现在能否开始播放（不满足时提示保留在 store，条件满足后再播放）。
 * - 页面不可见（切到其他标签页；多人模式下回合常由其他玩家准备后推进）时等待，回到页面再播放，避免在后台悄悄播完；
 * - 预选横幅（层级在弹窗之下）还要等回合开始的弹窗（版本更新、赛事结算等）关闭，否则倒计时会在遮罩下走完。
 *   正赛转场是最上层的全屏遮罩，不受弹窗影响。
 */
export function tiIntroCanShow(kind: TiIntroKind, ctx: TiIntroShowCtx): boolean {
  if (!ctx.visible) return false;
  if (kind === 'qualifier') return !(Number(ctx.popupsPending) > 0);
  return true;
}

/** 「已看过」记录 */
export interface TiSeenStore {
  has(key: string): boolean;
  add(key: string): void;
}

/** localStorage 键与容量（只保留最近的若干条，避免无限增长） */
export const TI_SEEN_STORAGE_KEY = 'd2m:tiIntroSeen';
export const TI_SEEN_MAX = 256;

type KV = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * 「已看过」记录：内存 Set + 可选的持久化存储（localStorage）。
 * 存储不可用 / 读写抛错（隐私模式、容量满）时退化为内存记录；多个标签页共用同一存储时，写入前先合并已有记录。
 */
export function createTiSeenStore(storage?: KV | null, max: number = TI_SEEN_MAX): TiSeenStore {
  // 本页面会话记下的键（插入顺序）。同一浏览器多个标签页（多人测试身份）会在同一时刻收到推进推送、
  // 同时「读 → 改 → 写」同一个存储项，后写的会覆盖先写的；每次写入都带上本会话的全部键，丢失的记录在下次写入时补回。
  const mem = new Set<string>();
  const cap = Math.max(1, Math.floor(max) || TI_SEEN_MAX);
  let cacheRaw: string | null | undefined;
  let cacheList: string[] = [];
  const read = (): string[] => {
    if (!storage) return [];
    let raw: string | null = null;
    try {
      raw = storage.getItem(TI_SEEN_STORAGE_KEY);
    } catch {
      return cacheList;
    }
    if (raw === cacheRaw) return cacheList;
    cacheRaw = raw;
    let list: string[] = [];
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      list = [];
    }
    cacheList = list;
    return list;
  };
  return {
    has(key) {
      return mem.has(key) || read().includes(key);
    },
    add(key) {
      mem.delete(key);
      mem.add(key);
      if (!storage) return;
      const list = read().filter((k) => !mem.has(k));
      list.push(...mem);
      const next = list.slice(-cap);
      try {
        const raw = JSON.stringify(next);
        storage.setItem(TI_SEEN_STORAGE_KEY, raw);
        cacheRaw = raw;
        cacheList = next;
      } catch {
        /* 写入失败：内存记录仍保证本次页面会话内只触发一次 */
      }
    },
  };
}

/** 浏览器 localStorage（Node / 被禁用 / 不完整的实现时为 null） */
export function browserStorage(): KV | null {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return typeof localStorage.getItem === 'function' && typeof localStorage.setItem === 'function' ? localStorage : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 玩家战队与本届 TI 的关系（转场 / 横幅的说明文字）
// ---------------------------------------------------------------------------
/** invited = 已获直邀；qualifier = 参加赛区预选；main = 入围正赛；out = 本届无缘 */
export type TiEntryStatus = 'invited' | 'qualifier' | 'main' | 'out';

export interface TiEntryInfo {
  status: TiEntryStatus;
  /** 参加的预选赛名称与晋级名额（status = 'qualifier'） */
  qualifierName?: string;
  qualifierSlots?: number;
}

/** 读取当前座位战队在本届 TI 的参赛情况（只读；数据缺失时返回 null） */
export function tiEntryInfo(
  game: Pick<GameState, 'tournaments' | 'settings'>,
  ti: number,
  kind: TiIntroKind,
): TiEntryInfo | null {
  const me = game.settings?.playerTeamId;
  const tours = game.tournaments;
  if (!me || !tours || typeof tours !== 'object') return null;
  const tiId = `ti-${ti}`;
  const tiT = tours[tiId];
  if (kind === 'main') {
    if (!tiT) return null;
    return { status: (tiT.teamIds ?? []).includes(me) ? 'main' : 'out' };
  }
  if (tiT && (tiT.invitedTeamIds ?? []).includes(me)) return { status: 'invited' };
  for (const t of Object.values(tours)) {
    if (!t || t.advanceToTi?.tiId !== tiId) continue;
    if ((t.teamIds ?? []).includes(me) || (t.qualifierTeamIds ?? []).includes(me)) {
      return { status: 'qualifier', qualifierName: t.name, qualifierSlots: t.advanceToTi.slots };
    }
  }
  return tiT ? { status: 'out' } : null;
}

/** 展示用城市：tis.json 城市，缺失 / 待定时用 TI 赛事实例的城市；仍未知返回 '' */
export function tiCityOf(game: Pick<GameState, 'tournaments'> | null, ti: number): string {
  const known = (c: unknown): c is string => typeof c === 'string' && !!c.trim() && c.trim() !== '待定';
  const city = tiInfoOf(ti)?.city;
  if (known(city)) return city;
  const c = game?.tournaments?.[`ti-${ti}`]?.city;
  return known(c) ? c : '';
}

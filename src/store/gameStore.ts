// ============================================================================
// 全局 Store：持有 GameState（引擎原地修改），version 计数器驱动重渲染。
// UI 只通过 call('引擎函数名', ...参数) 修改游戏状态，不直接改 game 对象：
//   单机（mode='single'）在本地执行引擎函数并自动保存到会话；
//   多人（mode='multi'，局域网）把操作作为白名单 RPC 发给权威服务器，状态由服务器推送（不做本地会话存档）。
// act() 只保留给单机专用的本地操作。
// ============================================================================
import { create } from 'zustand';
import type { GameState, NewGameOptions, OpResult } from '../engine/types';
import * as engine from '../engine';
import { clearProgress, flushSave, getProgressMeta, loadProgress, saveProgressNow, scheduleSave, type ProgressMeta } from './session';
import {
  RPC_WHITELIST, type ClientMsg, type FeedItem, type RoomInfo, type RoomSummary, type RoundStatus, type RpcName, type ServerMsg,
  type ServerStatsSummary,
} from '../shared/protocol';
import {
  getMpResume, getNetIdentity, getPlayerName, net, resolveServerUrl, savePlayerName, setManualServer, setMpResume, trimArgs,
  type NetState,
} from './net';
import { browserStorage, createTiSeenStore, tiIntroCue, tiIntroKindOf, type TiIntroCue } from '../ui/tiTheme';
import { tourCardAutoExpand, tourModalFocus, tourRoundKeyOf, type TourModalFocus } from '../ui/components/TourModalLogic';

// ---------------------------------------------------------------------------
// 导航（信息架构）：侧栏 6 个中心页 + 独立的比赛页；中心页内用标签页切换。
//   总览 dashboard · 战队 team（阵容 | 训练 | 教练）· 转会 transfer（转会市场 | 新秀抽卡 | 新秀选秀：只在选秀开启或旧存档有选秀记录时显示）·
//   赛事 events（赛事中心 | 赛程报名 | 排名 | 版本）· 俱乐部 club（财务 | 荣誉史）· 消息 inbox；比赛 match
//   DotaPedia pedia（总览 | 战队 | 选手 | 名人堂 | 赛事 | 英雄 | 羁绊图鉴；只读百科，词条页的选中状态见 ui/components/PediaKit usePediaNav）
// 旧页面键（'training'、'draft'、'schedule'…）仍可直接传给 setView：映射到「中心页 + 标签」，既有调用无需修改。
// 导航是纯 UI 状态（不进存档）；多人模式下每个席位各自的客户端持有自己的导航状态。
// ---------------------------------------------------------------------------

/** 中心页（store.view 的取值） */
export type HubKey = 'dashboard' | 'team' | 'transfer' | 'events' | 'club' | 'inbox' | 'match' | 'pedia';
export type TeamTab = 'squad' | 'training' | 'coach';
export type TransferTab = 'market' | 'gacha' | 'draft';
export type EventsTab = 'tournament' | 'schedule' | 'rankings' | 'patches';
export type ClubTab = 'finance' | 'honors';
/** DotaPedia 百科：总览 | 战队 | 选手 | 名人堂 | 赛事 | 英雄 | 羁绊图鉴（键名带 pedia 前缀，避免与其他中心页的标签重名） */
export type PediaTab = 'pediaHome' | 'pediaTeams' | 'pediaPlayers' | 'pediaHall' | 'pediaTours' | 'pediaHeroes' | 'pediaSynergies';
/** 中心页内的标签（store.tab 的取值；旧页面键即标签键，荣誉史为 'honors'） */
export type HubTab = TeamTab | TransferTab | EventsTab | ClubTab | PediaTab;
/**
 * setView 接受的键：中心页、标签或旧页面键。
 * 注意 'club' 保持旧语义 = 俱乐部 / 荣誉史（侧栏「俱乐部」用 openHub('club') 回到上次的标签，默认财务）。
 */
export type ViewKey = HubKey | HubTab;

/** 各中心页的标签（第一项为默认标签） */
export const HUB_TABS: Readonly<Partial<Record<HubKey, readonly HubTab[]>>> = {
  team: ['squad', 'training', 'coach'],
  transfer: ['market', 'gacha', 'draft'],
  events: ['tournament', 'schedule', 'rankings', 'patches'],
  club: ['finance', 'honors'],
  pedia: ['pediaHome', 'pediaTeams', 'pediaPlayers', 'pediaHall', 'pediaTours', 'pediaHeroes', 'pediaSynergies'],
};

const TAB_HUB: Readonly<Record<HubTab, HubKey>> = {
  squad: 'team', training: 'team', coach: 'team',
  market: 'transfer', gacha: 'transfer', draft: 'transfer',
  tournament: 'events', schedule: 'events', rankings: 'events', patches: 'events',
  finance: 'club', honors: 'club',
  pediaHome: 'pedia', pediaTeams: 'pedia', pediaPlayers: 'pedia', pediaHall: 'pedia', pediaTours: 'pedia', pediaHeroes: 'pedia', pediaSynergies: 'pedia',
};

const HUB_KEYS: readonly HubKey[] = ['dashboard', 'team', 'transfer', 'events', 'club', 'inbox', 'match', 'pedia'];

export function isHubTab(k: unknown): k is HubTab {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(TAB_HUB, k);
}

/** 标签是否属于该中心页 */
export function tabBelongsTo(hub: HubKey, tab: unknown): tab is HubTab {
  return isHubTab(tab) && TAB_HUB[tab] === hub;
}

/**
 * 解析导航键 → { 中心页, 标签 }（纯函数，便于测试）：
 * - 标签/旧页面键（'training' 等）→ 所属中心页 + 该标签；'club' → 俱乐部 / 荣誉史（旧语义）
 * - 中心页键 → 显式 tab（属于该页时）> 上次停留的标签 > 默认标签
 * - 未知键 → 总览
 */
export function resolveView(
  key: ViewKey | string,
  tab?: HubTab | null,
  remembered?: Partial<Record<HubKey, HubTab>>,
): { view: HubKey; tab: HubTab | null } {
  if (isHubTab(key)) return { view: TAB_HUB[key], tab: key };
  if (!(HUB_KEYS as readonly string[]).includes(key)) return { view: 'dashboard', tab: null };
  const hub = key as HubKey;
  const tabs = HUB_TABS[hub];
  if (!tabs || !tabs.length) return { view: hub, tab: null };
  if (tabBelongsTo(hub, tab)) return { view: hub, tab };
  if (hub === 'club') return { view: 'club', tab: 'honors' };
  const last = remembered?.[hub];
  return { view: hub, tab: tabBelongsTo(hub, last) ? last : tabs[0] };
}

/** 侧栏入口的「需处理」上下文（由当前席位的游戏状态算出） */
export interface HubEntryContext {
  /** 首发阵容有问题 */
  lineupProblem?: boolean;
  /** 收到的待处理转会报价数 */
  offers?: number;
  /** 本回合有进行中的玩家赛事或比赛 */
  live?: boolean;
  /** 赛季初（报名期） */
  preseason?: boolean;
  /** 资金为负 */
  goldNegative?: boolean;
}

/**
 * 侧栏点击中心页时应打开的标签（纯函数）：入口挂着「需处理」徽标时直接打开徽标所指的标签
 * （阵容问题 → 阵容、报价 → 转会市场、进行中的赛事 → 赛事中心、资金为负 → 财务）；
 * 赛季初的「赛事」默认打开赛程报名（赛事中心此时还没有对阵），除非上次停留的是其他标签。
 * 返回 null = 按 openHub 恢复上次停留的标签。只看提醒类徽标，常驻信息（教练空缺、新秀抽卡、窗口锁定）不改变去向。
 */
export function hubEntryTab(hub: HubKey, ctx: HubEntryContext, remembered?: Partial<Record<HubKey, HubTab>>): HubTab | null {
  switch (hub) {
    case 'team':
      return ctx.lineupProblem ? 'squad' : null;
    case 'transfer':
      return (ctx.offers ?? 0) > 0 ? 'market' : null;
    case 'events': {
      if (ctx.live) return 'tournament';
      const last = remembered?.events;
      return ctx.preseason && (!last || last === 'tournament') ? 'schedule' : null;
    }
    case 'club':
      return ctx.goldNegative ? 'finance' : null;
    default:
      return null;
  }
}

export type ScreenKey = 'menu' | 'newgame' | 'game' | 'lobby' | 'room';

/** 游戏模式：single = 本地单机（引擎在浏览器里跑）；multi = 局域网多人（服务器权威，本地只读服务器推送的座位视图） */
export type GameMode = 'single' | 'multi';

export interface Toast {
  id: number;
  text: string;
  ok: boolean;
  /** 玩家点开了全文（手机上长提示先收起）：不再按原时限消失，改为 holdToast 的较长时限 */
  held?: boolean;
}

// ---------------------------------------------------------------------------
// call()：UI 修改游戏状态的唯一入口（引擎函数名 + 参数）
// ---------------------------------------------------------------------------
type Engine = typeof engine;
/** 可通过 call 调用的引擎函数（= 多人 RPC 白名单） */
export type CallName = RpcName;
/** 引擎函数除 state 外的参数 */
export type CallArgs<K extends CallName> = K extends keyof Engine
  ? Engine[K] extends (g: GameState, ...a: infer A) => unknown
    ? A
    : never
  : never;
/** 引擎函数的返回值 */
export type CallRet<K extends CallName> = K extends keyof Engine ? (Engine[K] extends (...a: never[]) => infer R ? R : never) : never;
export interface CallOpts {
  /** 成功时不弹提示（失败仍提示） */
  silent?: boolean;
  /** 单机：立即保存（否则防抖保存） */
  autosave?: boolean;
}

// ---------------------------------------------------------------------------
// 多人（局域网）状态
// ---------------------------------------------------------------------------
export interface ChatLine {
  id: number;
  from: string;
  text: string;
  at: string;
}

export type MpServerMode = 'unknown' | 'lan' | 'public';

export interface MpState {
  /** 连接状态（net.ts） */
  net: NetState;
  /** 服务器信息（welcome） */
  serverName: string;
  /** 服务器的局域网地址（只有局域网内的连接会收到；公网模式为空） */
  lanUrls: string[];
  /**
   * 服务器类型：unknown = 尚未收到 welcome（或刚切换服务器）；lan = 局域网服务器（房主运行）；
   * public = 公网服务器（welcome.publicServer，界面不显示局域网相关说明）
   */
  serverMode: MpServerMode;
  /** 服务器在线统计（serverStats 推送；旧服务器不发送时为 null） */
  serverStats: ServerStatsSummary | null;
  /** 本机身份（会话 ID）与昵称 */
  sessionId: string;
  playerName: string;
  /** 大厅房间列表 */
  rooms: RoomSummary[];
  roomsLoadedAt: number | null;
  /** 当前所在房间 */
  room: RoomInfo | null;
  /** 回合准备状态（游戏中） */
  roundStatus: RoundStatus | null;
  /** 实时快讯（新 → 旧，最多 FEED_MAX 条） */
  feed: FeedItem[];
  /** 正在显示的快讯提示 */
  feedToasts: FeedItem[];
  /** 房间聊天 */
  chat: ChatLine[];
  chatUnread: number;
  /** 收到的状态快照数（version 来自服务器） */
  stateVersion: number;
}

const FEED_MAX = 40;
const FEED_TOAST_MAX = 3;
const FEED_TOAST_MS = 6500;
const CHAT_MAX = 120;
/** RPC 无响应超时 */
const CALL_TIMEOUT_MS = 20000;
/** callResult 先于 state 到达时，最多等待状态快照的时间（保证 .then 里读到操作后的状态） */
const STATE_WAIT_MS = 600;

function initialMp(): MpState {
  return {
    net: { ...net.state },
    serverName: '',
    lanUrls: [],
    serverMode: 'unknown',
    serverStats: null,
    sessionId: '',
    playerName: '',
    rooms: [],
    roomsLoadedAt: null,
    room: null,
    roundStatus: null,
    feed: [],
    feedToasts: [],
    chat: [],
    chatUnread: 0,
    stateVersion: 0,
  };
}

interface GameStore {
  screen: ScreenKey;
  /** single = 单机；multi = 多人（进入大厅起，直到退出多人） */
  mode: GameMode;
  game: GameState | null;
  version: number;
  /** 当前中心页 */
  view: HubKey;
  /** 当前中心页的标签（无标签的页面为 null） */
  tab: HubTab | null;
  /** 每个中心页上次停留的标签（侧栏切回时恢复） */
  hubTabs: Partial<Record<HubKey, HubTab>>;
  /** 选手详情弹窗 */
  selectedPlayerId: string | null;
  /** 战队详情弹窗 */
  selectedTeamId: string | null;
  /**
   * 总览「本回合」中内嵌的训练卡片（TrainingCard）是否展开。
   * setTrainingOpen(true) 在任何页面调用都会回到总览、展开并滚动到该卡片（见 cardFocus）。纯 UI 状态，不进存档。
   */
  trainingOpen: boolean;
  setTrainingOpen(open: boolean): void;
  /**
   * 总览「本回合」中内嵌的赛事卡片（TournamentCard）是否展开：赛事回合开始时自动展开（本方仍有比赛要打），
   * 其他回合自动收起（见 syncTournamentCard）；回合内由玩家自行收起 / 展开。
   * setTournamentOpen(true)（如底栏「赛事面板」）同样回到总览、展开并滚动到卡片。纯 UI 状态，不进存档。
   */
  tournamentOpen: boolean;
  setTournamentOpen(open: boolean): void;
  /**
   * 最近一次「打开总览卡片」的请求：总览据此滚动到对应卡片（seq 递增，已展开时再次请求也会滚动）；
   * roundKey = 请求时的回合（tourRoundKeyOf），总览据此只在本回合请求过时才显示不可训练回合的训练卡片。
   */
  cardFocus: { card: DashboardCard; seq: number; roundKey: string } | null;
  /** TI 转场 / 预选横幅（第八波；由 syncTiIntro 在进入 TI 回合时设置，TiTransition 播放完毕后清空） */
  tiIntro: TiIntroCue | null;
  dismissTiIntro(): void;
  toasts: Toast[];
  busy: boolean;

  setScreen(screen: ScreenKey): void;
  /**
   * 导航：接受中心页、标签或旧页面键（见 resolveView）。
   * 例：setView('training') → 战队 / 训练；setView('events', 'rankings') → 赛事 / 排名。
   */
  setView(view: ViewKey, tab?: HubTab): void;
  /** 侧栏：打开中心页并回到上次停留的标签（无记录时为默认标签） */
  openHub(hub: HubKey): void;
  openPlayer(id: string | null): void;
  openTeam(id: string | null): void;
  toast(text: string, ok?: boolean): void;
  dismissToast(id: number): void;
  /** 留住一条提示（展开全文后）：取消原来的自动消失，TOAST_HOLD_MS 后再消失 */
  holdToast(id: number): void;

  /** 当前会话的进度摘要（入口页「继续游戏」用；null = 无进度） */
  progress: ProgressMeta | null;

  /**
   * 【仅单机】在本地执行一段修改游戏状态的逻辑：自动 version++、显示 OpResult 提示、捕获异常，并自动保存到当前会话。
   * silent=true 时成功不弹提示（失败仍提示）。多人模式下拒绝执行（状态由服务器权威维护）——UI 一律用 call()。
   */
  act<T>(fn: (g: GameState) => T, opts?: { silent?: boolean; autosave?: boolean }): T | undefined;

  /**
   * 调用一个引擎操作（函数名 + 除 state 外的参数）：
   * - 单机：本地同步执行，等同 act(g => engine[fn](g, ...args))（提示 OpResult、version++、会话自动保存），返回已完成的 Promise；
   * - 多人：作为白名单 RPC 发给服务器，在本座位上下文中执行；结果提示来自 callResult，新状态随后由服务器推送。
   * 返回引擎函数的返回值（多人模式下为服务器回传的结果；失败 / 断线 / 超时为 undefined 或 {ok:false}）。
   */
  call<K extends CallName>(fn: K, ...args: CallArgs<K>): Promise<CallRet<K> | undefined>;
  /** 同 call，但成功时不弹提示 */
  callSilent<K extends CallName>(fn: K, ...args: CallArgs<K>): Promise<CallRet<K> | undefined>;

  newGame(opts: NewGameOptions): Promise<boolean>;
  /** 继续当前会话的进度 */
  continueGame(): Promise<boolean>;
  /** 单机：推进回合；多人：准备进入下一回合（全员准备后服务器推进）。lazyAdvance 开启时自动处理本回合的阻塞 */
  advance(): void;
  /**
   * 「下一回合自动处理」（懒人推进，默认开启）：推进时自动处理待决事件（默认选项）、快速模拟本回合剩余比赛、
   * 首发不足时补齐临时替补（引擎 advance(g, { auto: true })；多人为自动准备）。按浏览器记住（localStorage），不进存档。
   */
  lazyAdvance: boolean;
  setLazyAdvance(on: boolean): void;
  importJson(json: string): boolean;
  exportJson(): string | null;
  quitToMenu(): void;
  refreshProgress(): void;

  // ------------------------------------------------------------------ 多人
  mp: MpState;
  /** 进入多人大厅：切换到多人模式并连接服务器 */
  mpOpenLobby(): void;
  /** 连接服务器：address = 手动地址（ip:端口）；null = 恢复默认（同源）；省略 = 使用当前设置 */
  mpConnect(address?: string | null): void;
  /** 立即重连 */
  mpReconnect(): void;
  /** 发送一条协议消息（未连接时提示并返回 false） */
  mpSend(msg: ClientMsg): boolean;
  /** 修改昵称（本地记住；已连接时同步给服务器） */
  mpSetName(name: string): void;
  /** 回合准备 / 取消准备 */
  mpSetRoundReady(ready: boolean): void;
  /** 离开当前房间（回到大厅，保持连接） */
  mpLeaveRoom(): void;
  /** 退出多人：断开连接，回到主菜单（单机模式） */
  mpExit(): void;
  mpDismissFeed(id: string): void;
  mpMarkChatRead(): void;
  /** 页面打开时：上次停留在多人房间（刷新 / 重新打开标签页）→ 自动回到多人模式并重连；返回是否已恢复 */
  mpResumeIfNeeded(): boolean;
}

/** 总览中可展开、可被「打开」请求定位的卡片 */
export type DashboardCard = 'training' | 'tournament';

/** 换局（新建 / 继续 / 导入）时的导航初始状态：回到总览，清空各中心页记住的标签，收起训练 / 赛事卡片 */
const FRESH_NAV = { view: 'dashboard' as HubKey, tab: null, hubTabs: {}, trainingOpen: false, tournamentOpen: false, cardFocus: null };

/** 「下一回合自动处理」偏好（每个浏览器一份；读写失败时按默认开启） */
const LAZY_ADVANCE_KEY = 'd2m:lazyAdvance';
function readLazyAdvance(): boolean {
  try {
    return browserStorage()?.getItem(LAZY_ADVANCE_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeLazyAdvance(on: boolean): void {
  try {
    browserStorage()?.setItem(LAZY_ADVANCE_KEY, on ? '1' : '0');
  } catch {
    /* 存储不可用：只在本次会话生效 */
  }
}

let toastSeq = 0;
/** 展开全文后的提示再保留多久（毫秒） */
const TOAST_HOLD_MS = 12000;
let cardFocusSeq = 0;
let reqSeq = 0;
let chatSeq = 0;

function isOpResult(v: unknown): v is OpResult {
  return !!v && typeof v === 'object' && 'ok' in (v as object) && 'message' in (v as object);
}

/** 多人：等待服务器回应的 RPC */
interface PendingCall {
  fn: string;
  silent: boolean;
  resolve: (v: unknown) => void;
  /** 发送时已收到的状态快照数 */
  stateSeqAtSend: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingCalls = new Map<number, PendingCall>();
/**
 * 多人：正在等待回应的相同操作（函数名 + 参数）。服务器的新状态到达前按钮仍可点击，
 * 连点会把同一操作执行两次（如连点「单抽」扣两次钱）；相同操作在途时复用同一个请求。
 */
const inflightCalls = new Map<string, Promise<unknown>>();
/** callResult 已到、等待状态快照的回调 */
let stateWaiters: (() => void)[] = [];
let stateSeq = 0;
/** 主动离开房间（区分被房主移出 / 房间解散） */
let leavingRoom = false;
/** 最近一次服务器错误提示的时间（被移出时服务器已发出说明，避免重复提示） */
let lastServerErrorAt = 0;

function flushStateWaiters(): void {
  const ws = stateWaiters;
  stateWaiters = [];
  ws.forEach((fn) => fn());
}

function failPendingCalls(): void {
  for (const [id, p] of pendingCalls) {
    clearTimeout(p.timer);
    pendingCalls.delete(id);
    p.resolve(undefined);
  }
  flushStateWaiters();
}

export const useGameStore = create<GameStore>((set, get) => {
  /** 本地执行引擎函数（单机） */
  const runLocal = (fn: string, args: unknown[], opts: CallOpts): Promise<unknown> => {
    const f = (engine as unknown as Record<string, unknown>)[fn];
    if (typeof f !== 'function') {
      get().toast(`操作失败：未知操作 ${fn}`, false);
      return Promise.resolve(undefined);
    }
    const res = get().act((g) => (f as (g: GameState, ...a: unknown[]) => unknown)(g, ...args), opts);
    return Promise.resolve(res);
  };

  /** 发送 RPC（多人） */
  const runRemote = (fn: string, args: unknown[], opts: CallOpts): Promise<unknown> => {
    if (!(RPC_WHITELIST as readonly string[]).includes(fn)) {
      get().toast(`多人模式不支持该操作（${fn}）`, false);
      return Promise.resolve(undefined);
    }
    if (!net.isOpen) {
      get().toast('与服务器的连接已断开，操作未发送', false);
      return Promise.resolve(undefined);
    }
    const sendArgs = trimArgs(args);
    let key: string | null = null;
    try {
      key = `${fn}:${JSON.stringify(sendArgs)}`;
    } catch {
      key = null;
    }
    const dup = key !== null ? inflightCalls.get(key) : undefined;
    if (dup) return dup;
    const reqId = ++reqSeq;
    const p = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        if (!pendingCalls.delete(reqId)) return;
        get().toast('服务器无响应，操作可能未生效', false);
        resolve(undefined);
      }, CALL_TIMEOUT_MS);
      pendingCalls.set(reqId, { fn, silent: !!opts.silent, resolve, stateSeqAtSend: stateSeq, timer });
      if (!net.send({ t: 'call', reqId, fn, args: sendArgs })) {
        clearTimeout(timer);
        pendingCalls.delete(reqId);
        get().toast('与服务器的连接已断开，操作未发送', false);
        resolve(undefined);
      }
    });
    if (key !== null) {
      const k = key;
      inflightCalls.set(k, p);
      void p.finally(() => {
        if (inflightCalls.get(k) === p) inflightCalls.delete(k);
      });
    }
    return p;
  };

  const invoke = (fn: string, args: unknown[], opts: CallOpts): Promise<unknown> =>
    get().mode === 'multi' ? runRemote(fn, args, opts) : runLocal(fn, args, opts);

  const setMp = (patch: Partial<MpState> | ((mp: MpState) => Partial<MpState>)) =>
    set((s) => ({ mp: { ...s.mp, ...(typeof patch === 'function' ? patch(s.mp) : patch) } }));

  /** 展开 / 收起总览卡片；展开时回到总览并请求滚动到该卡片 */
  const openCard = (card: DashboardCard, open: boolean) => {
    const flag = card === 'training' ? { trainingOpen: open } : { tournamentOpen: open };
    if (!open) {
      set(flag);
      return;
    }
    const g = get().game;
    set({ ...flag, cardFocus: { card, seq: ++cardFocusSeq, roundKey: g ? tourRoundKeyOf(g) : '' } });
    if (get().view !== 'dashboard') get().setView('dashboard');
  };

  return {
    screen: 'menu',
    mode: 'single',
    game: null,
    version: 0,
    view: 'dashboard',
    tab: null,
    hubTabs: {},
    selectedPlayerId: null,
    selectedTeamId: null,
    trainingOpen: false,
    setTrainingOpen: (open) => openCard('training', open),
    tournamentOpen: false,
    setTournamentOpen: (open) => openCard('tournament', open),
    cardFocus: null,
    tiIntro: null,
    dismissTiIntro: () => set({ tiIntro: null }),
    toasts: [],
    busy: false,
    progress: getProgressMeta(),
    mp: initialMp(),

    setScreen: (screen) => set({ screen }),
    setView: (key, tab) => {
      const r = resolveView(key, tab, get().hubTabs);
      set((s) => ({ view: r.view, tab: r.tab, hubTabs: r.tab ? { ...s.hubTabs, [r.view]: r.tab } : s.hubTabs }));
    },
    openHub: (hub) => {
      const tabs = HUB_TABS[hub];
      const last = get().hubTabs[hub];
      get().setView(hub, tabBelongsTo(hub, last) ? last : tabs?.[0]);
    },
    openPlayer: (id) => set({ selectedPlayerId: id }),
    openTeam: (id) => set({ selectedTeamId: id }),

    toast: (text, ok = true) => {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, ok }] }));
      setTimeout(() => {
        if (!get().toasts.find((t) => t.id === id)?.held) get().dismissToast(id);
      }, ok ? 3500 : 6000);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    holdToast: (id) => {
      if (!get().toasts.some((t) => t.id === id && !t.held)) return;
      set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, held: true } : t)) }));
      setTimeout(() => get().dismissToast(id), TOAST_HOLD_MS);
    },

    act: (fn, opts) => {
      const g = get().game;
      if (!g) return undefined;
      if (get().mode === 'multi') {
        // 多人模式下状态由服务器权威维护：本地修改会被下一次推送覆盖，且会与其他玩家不同步
        get().toast('多人模式下不能在本地修改游戏状态', false);
        return undefined;
      }
      try {
        const res = fn(g);
        if (isOpResult(res) && res.message && (!opts?.silent || !res.ok)) get().toast(res.message, res.ok);
        set((s) => ({ version: s.version + 1 }));
        // 会话自动存档：推进回合等关键操作立即保存，其余操作防抖合并
        if (opts?.autosave) void saveProgressNow(g).then(() => get().refreshProgress());
        else scheduleSave(g);
        return res;
      } catch (err) {
        console.error(err);
        get().toast(`操作失败：${(err as Error).message}`, false);
        set((s) => ({ version: s.version + 1 }));
        return undefined;
      }
    },

    call: ((fn: string, ...args: unknown[]) => invoke(fn, args, {})) as GameStore['call'],
    callSilent: ((fn: string, ...args: unknown[]) => invoke(fn, args, { silent: true })) as GameStore['callSilent'],

    newGame: async (opts) => {
      set({ busy: true });
      try {
        const game = await engine.createNewGame(opts);
        await clearProgress();
        set({ game, mode: 'single', screen: 'game', ...FRESH_NAV, version: get().version + 1, busy: false, selectedPlayerId: null, selectedTeamId: null });
        await saveProgressNow(game);
        get().refreshProgress();
        return true;
      } catch (err) {
        console.error(err);
        get().toast(`创建游戏失败：${(err as Error).message}`, false);
        set({ busy: false });
        return false;
      }
    },

    advance: () => {
      if (get().mode === 'multi') {
        // 自动准备：服务器先自动处理本座位的阻塞，能准备时再准备（协议 setRoundReady.auto）
        if (get().lazyAdvance) get().mpSend({ t: 'setRoundReady', ready: true, auto: true });
        else get().mpSetRoundReady(true);
        return;
      }
      // 懒人推进：先自动处理本回合的阻塞（待决事件 / 首发 / 剩余比赛）再推进；关闭时与以前完全相同
      const auto = get().lazyAdvance;
      const res = get().act((g) => engine.advance(g, auto ? { auto: true } : undefined), { silent: true, autosave: true });
      // 自动处理的摘要（完整记录见消息中心「本回合自动处理」）
      const done = res?.autoActions?.length ? `已自动处理：${res.autoActions.slice(0, 2).join('；')}${res.autoActions.length > 2 ? ' 等' : ''}` : '';
      if (done) get().toast(done, true);
      // 失败原因已由 act 提示（silent 只屏蔽成功提示），这里不再重复
      // 推进后停留在当前页面；底部操作栏会自动变为「进入比赛」等下一步。
      // 例外：比赛页只服务于本回合的比赛（推进后会残留上一场的结算），回到总览查看回合要闻
      if (res?.ok && get().view === 'match' && !get().game?.activeMatch) get().setView('dashboard');
    },
    lazyAdvance: readLazyAdvance(),
    setLazyAdvance: (on) => {
      writeLazyAdvance(on);
      set({ lazyAdvance: on });
    },

    continueGame: async () => {
      set({ busy: true });
      const g = await loadProgress();
      if (!g) {
        set({ busy: false, progress: null });
        get().toast('没有找到可继续的进度，请新建游戏', false);
        return false;
      }
      set({ game: g, mode: 'single', screen: 'game', ...FRESH_NAV, version: get().version + 1, selectedPlayerId: null, selectedTeamId: null, busy: false });
      return true;
    },

    refreshProgress: () => set({ progress: getProgressMeta() }),

    importJson: (json) => {
      try {
        const g = engine.importSave(json);
        set({ game: g, mode: 'single', screen: 'game', ...FRESH_NAV, version: get().version + 1, selectedPlayerId: null, selectedTeamId: null });
        void saveProgressNow(g).then(() => get().refreshProgress());
        get().toast('存档导入成功，已设为当前会话进度');
        return true;
      } catch (err) {
        get().toast(`导入失败：${(err as Error).message}`, false);
        return false;
      }
    },

    exportJson: () => {
      const g = get().game;
      return g ? engine.exportSave(g) : null;
    },

    quitToMenu: () => {
      if (get().mode === 'multi') {
        get().mpExit();
        return;
      }
      void flushSave().then(() => get().refreshProgress());
      set({ game: null, screen: 'menu', selectedPlayerId: null, selectedTeamId: null, progress: getProgressMeta() });
    },

    // ------------------------------------------------------------------ 多人
    mpOpenLobby: () => {
      const id = getNetIdentity();
      setMp({ sessionId: id.sessionId, playerName: getPlayerName() });
      set({ mode: 'multi', screen: 'lobby', game: null, selectedPlayerId: null, selectedTeamId: null });
      get().mpConnect();
    },

    mpConnect: (address) => {
      if (address !== undefined) setManualServer(address);
      const name = get().mp.playerName || getPlayerName();
      const url = resolveServerUrl();
      // 换了服务器：上一台服务器的信息作废，等新服务器的 welcome
      if (url !== net.state.url) setMp({ serverName: '', lanUrls: [], serverMode: 'unknown', serverStats: null });
      net.connect(url, name);
    },

    mpReconnect: () => {
      if (!net.state.url) get().mpConnect();
      else net.reconnectNow();
    },

    mpSend: (msg) => {
      if (net.send(msg)) return true;
      get().toast('未连接到服务器', false);
      return false;
    },

    mpSetName: (name) => {
      const n = savePlayerName(name);
      setMp({ playerName: n });
      net.setName(n);
      if (get().mp.room && get().mp.room?.status === 'lobby') net.send({ t: 'updateSeat', name: n });
    },

    mpSetRoundReady: (ready) => {
      get().mpSend({ t: 'setRoundReady', ready });
    },

    mpLeaveRoom: () => {
      leavingRoom = true;
      setMpResume(null);
      net.send({ t: 'leaveRoom' });
      failPendingCalls();
      setMp({ room: null, roundStatus: null, feed: [], feedToasts: [], chat: [], chatUnread: 0 });
      set({ screen: 'lobby', game: null, selectedPlayerId: null, selectedTeamId: null });
      net.send({ t: 'listRooms' });
    },

    mpExit: () => {
      const room = get().mp.room;
      // 主动退出多人：刷新页面后不再自动回到房间（之后在多人大厅连接时服务器仍会把进行中的对局座位还给你）
      setMpResume(null);
      // 大厅阶段释放座位；对局已结束时同样离开（否则再次进入多人大厅时服务器会把玩家放回已结束的对局，大厅无法使用）
      if (room && (room.status !== 'playing' || !!get().game?.gameOver)) {
        leavingRoom = true;
        net.send({ t: 'leaveRoom' });
      }
      net.disconnect();
      failPendingCalls();
      set({
        mode: 'single',
        screen: 'menu',
        game: null,
        selectedPlayerId: null,
        selectedTeamId: null,
        mp: { ...initialMp(), net: { ...net.state } },
        progress: getProgressMeta(),
      });
    },

    mpDismissFeed: (id) => setMp((mp) => ({ feedToasts: mp.feedToasts.filter((f) => f.id !== id) })),
    mpResumeIfNeeded: () => {
      if (get().mode === 'multi' || get().screen !== 'menu' || !getMpResume()) return false;
      get().mpOpenLobby();
      return true;
    },
    mpMarkChatRead: () => setMp({ chatUnread: 0 }),
  };
});

// ---------------------------------------------------------------------------
// 服务器消息 → store
// ---------------------------------------------------------------------------
/**
 * 多人：每次推送都是全新的状态对象。比赛直播的播放进度按「对局记录对象」记忆（MatchLive.useLivePlayback），
 * 其他玩家的操作触发推送时，若本座位进行中的对局记录未变，沿用旧对象，避免直播从头重放。
 */
function keepStableRefs(prev: GameState | null, next: GameState): void {
  const a = prev?.activeMatch;
  const b = next.activeMatch;
  if (!a || !b || a.tournamentId !== b.tournamentId || a.seriesId !== b.seriesId) return;
  try {
    if (a.pendingGame && b.pendingGame && JSON.stringify(a.pendingGame) === JSON.stringify(b.pendingGame)) b.pendingGame = a.pendingGame;
    if (a.games && b.games && a.games.length === b.games.length && JSON.stringify(a.games) === JSON.stringify(b.games)) b.games = a.games;
  } catch {
    /* ignore */
  }
}

function handleServerMsg(msg: ServerMsg): void {
  const store = useGameStore;
  const st = store.getState();
  if (st.mode !== 'multi') return;
  const setMp = (patch: Partial<MpState> | ((mp: MpState) => Partial<MpState>)) =>
    store.setState((s) => ({ mp: { ...s.mp, ...(typeof patch === 'function' ? patch(s.mp) : patch) } }));

  switch (msg.t) {
    case 'welcome': {
      const pub = msg.publicServer === true;
      setMp({
        serverName: msg.serverName,
        // 公网服务器不会发送内网地址；即使发了也不显示
        lanUrls: pub ? [] : (Array.isArray(msg.lanUrls) ? msg.lanUrls.filter((u) => typeof u === 'string') : []),
        serverMode: pub ? 'public' : 'lan',
        sessionId: msg.sessionId || st.mp.sessionId,
      });
      net.send({ t: 'listRooms' });
      return;
    }
    case 'serverStats': {
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
      setMp({ serverStats: { online: n(msg.online), inGame: n(msg.inGame), rooms: n(msg.rooms), playing: n(msg.playing) } });
      return;
    }
    case 'roomList':
      setMp({ rooms: msg.rooms ?? [], roomsLoadedAt: Date.now() });
      return;
    case 'room': {
      const room = msg.room;
      const prev = st.mp.room;
      if (!room) {
        const wasIn = !!prev;
        setMpResume(null);
        setMp({ room: null, roundStatus: null, feed: [], feedToasts: [], chat: [], chatUnread: 0 });
        if (st.screen === 'room' || st.screen === 'game') {
          failPendingCalls();
          store.setState({ screen: 'lobby', game: null, selectedPlayerId: null, selectedTeamId: null });
          if (wasIn && !leavingRoom && Date.now() - lastServerErrorAt > 2000) st.toast('你已离开房间（房间可能已解散）', false);
          net.send({ t: 'listRooms' });
        }
        leavingRoom = false;
        return;
      }
      leavingRoom = false;
      setMpResume(room.id);
      // 换房间时清空聊天与快讯
      const changed = !prev || prev.id !== room.id;
      setMp(changed ? { room, feed: [], feedToasts: [], chat: [], chatUnread: 0, roundStatus: null } : { room });
      if (room.status === 'lobby') {
        if (st.screen === 'lobby' || st.screen === 'game' || st.screen === 'room') {
          store.setState({ screen: 'room', game: null, selectedPlayerId: null, selectedTeamId: null });
        }
      } else if (st.screen === 'lobby' || st.screen === 'room') {
        // 游戏进行中 / 已结束：有状态快照时进入游戏，否则在房间页等待
        store.setState(st.game ? { screen: 'game' } : { screen: 'room' });
      }
      return;
    }
    case 'state': {
      stateSeq++;
      const next = msg.state;
      const prev = st.game;
      if (!next || typeof next !== 'object') return;
      // 服务器总是先发房间再发状态；不在房间内时收到的是离开前在途的旧快照（否则会把刚离开的玩家拉回对局）
      if (!st.mp.room) {
        flushStateWaiters();
        return;
      }
      keepStableRefs(prev, next);
      const enter = st.screen !== 'game';
      // 回合推进（服务器在全员准备后推进）：与单机「下一回合」相同——比赛页残留上一场结算时回到总览
      const advanced = !!prev && (prev.season?.ti !== next.season?.ti || prev.roundIndex !== next.roundIndex);
      store.setState((s) => ({
        game: next,
        version: s.version + 1,
        mp: { ...s.mp, stateVersion: msg.version },
        ...(enter ? { screen: 'game' as ScreenKey, ...FRESH_NAV, selectedPlayerId: null, selectedTeamId: null } : {}),
      }));
      if (!enter && advanced && useGameStore.getState().view === 'match' && !next.activeMatch) useGameStore.getState().setView('dashboard');
      flushStateWaiters();
      return;
    }
    case 'callResult': {
      const p = pendingCalls.get(msg.reqId);
      if (!p) return;
      clearTimeout(p.timer);
      pendingCalls.delete(msg.reqId);
      if (msg.message && (!p.silent || !msg.ok)) st.toast(msg.message, msg.ok);
      const value = msg.result !== undefined && msg.result !== null ? msg.result : { ok: msg.ok, message: msg.message };
      const done = () => p.resolve(value);
      // 操作成功且尚未收到新的状态快照：稍等快照再回调，保证调用方读到操作后的状态
      if (msg.ok && stateSeq === p.stateSeqAtSend) {
        let fired = false;
        const fire = () => {
          if (fired) return;
          fired = true;
          done();
        };
        stateWaiters.push(fire);
        setTimeout(fire, STATE_WAIT_MS);
      } else done();
      return;
    }
    case 'feed': {
      const me = st.game?.settings.playerTeamId;
      const known = new Set(st.mp.feed.map((f) => f.id));
      // 新 → 旧（服务器按时间顺序发送）；自己触发的操作不再提示
      const add = (msg.items ?? [])
        .filter((f) => f && f.title && !known.has(f.id) && (!me || f.actorTeamId !== me))
        .reverse();
      if (!add.length) return;
      const show = add.slice(0, FEED_TOAST_MAX);
      setMp((mp) => ({
        feed: [...add, ...mp.feed].slice(0, FEED_MAX),
        feedToasts: [...show, ...mp.feedToasts].slice(0, FEED_TOAST_MAX),
      }));
      for (const f of show) setTimeout(() => useGameStore.getState().mpDismissFeed(f.id), FEED_TOAST_MS);
      return;
    }
    case 'roundStatus':
      setMp({ roundStatus: msg.status });
      return;
    case 'chat': {
      const line: ChatLine = { id: ++chatSeq, from: msg.from, text: msg.text, at: msg.at };
      setMp((mp) => ({ chat: [...mp.chat, line].slice(-CHAT_MAX), chatUnread: mp.chatUnread + 1 }));
      return;
    }
    case 'error':
      lastServerErrorAt = Date.now();
      st.toast(msg.message || '服务器错误', false);
      return;
  }
}

net.onMessage(handleServerMsg);

// ---------------------------------------------------------------------------
// TI 转场触发（第八波）：任何状态变化后（单机推进 / 多人推送 / 继续 / 导入）检查当前座位视图
// 是否处于尚未看过的 TI 正赛（全屏转场）或 TI 预选（顶部横幅）回合；每个存档 × 座位 × 届次只触发一次。
// ---------------------------------------------------------------------------
const tiSeen = createTiSeenStore(browserStorage());

export function syncTiIntro(): void {
  const s = useGameStore.getState();
  const g = s.screen === 'game' ? s.game : null;
  if (!g) {
    if (s.tiIntro) useGameStore.setState({ tiIntro: null });
    return;
  }
  // 已离开对应回合（换季 / 换局）：撤下残留的横幅
  if (s.tiIntro && (tiIntroKindOf(g.phase) !== s.tiIntro.kind || g.season?.ti !== s.tiIntro.ti)) useGameStore.setState({ tiIntro: null });
  const cue = tiIntroCue(g, (k) => tiSeen.has(k));
  if (!cue) return;
  tiSeen.add(cue.key);
  useGameStore.setState({ tiIntro: cue });
}

// ---------------------------------------------------------------------------
// 赛事卡片自动展开：每进入一个新回合（存档 × 座位 × 赛季 × 回合变化）判定一次——本方在本回合的赛事仍有比赛要打时
// 展开总览「本回合」里的赛事卡片，否则收起（判定见 TourModalLogic.tourCardAutoExpand）。只改变内嵌卡片的展开状态，
// 不弹窗、不切换页面，也不等待通知 / TI 转场；回合内由玩家自行收起 / 展开。多人模式下每个座位的客户端各自判定。
// ---------------------------------------------------------------------------
/** 上次判定时的回合（tourRoundKeyOf）；离开游戏界面时清空，回来后按新回合重新判定 */
let tourRoundKey = '';

export function syncTournamentCard(): void {
  const s = useGameStore.getState();
  const g = s.screen === 'game' ? s.game : null;
  if (!g || g.gameOver) {
    tourRoundKey = '';
    if (s.tournamentOpen) useGameStore.setState({ tournamentOpen: false });
    return;
  }
  const roundKey = tourRoundKeyOf(g);
  if (roundKey === tourRoundKey) return;
  tourRoundKey = roundKey;
  let focus: TourModalFocus | null = null;
  try {
    focus = tourModalFocus(g);
  } catch {
    focus = null;
  }
  const expand = tourCardAutoExpand(focus);
  if (s.tournamentOpen !== expand) useGameStore.setState({ tournamentOpen: expand });
}

useGameStore.subscribe((s, prev) => {
  const gameChanged = s.game !== prev.game || s.version !== prev.version || s.screen !== prev.screen;
  if (!gameChanged) return;
  syncTiIntro();
  syncTournamentCard();
});
net.onStatus((ns) => {
  const st = useGameStore.getState();
  if (st.mode !== 'multi' && ns.status !== 'closed') return;
  if (ns.status !== 'open') failPendingCalls();
  useGameStore.setState((s) => ({ mp: { ...s.mp, net: { ...ns } } }));
});

/** 订阅游戏状态（任何 act / call 之后都会重渲染）。仅在 screen==='game' 内使用 */
export function useGame(): GameState {
  const game = useGameStore((s) => s.game);
  useGameStore((s) => s.version);
  if (!game) throw new Error('当前没有进行中的游戏');
  return game;
}

/** 【仅单机本地操作】取 act；修改游戏状态请用 useCall() */
export function useAct() {
  return useGameStore((s) => s.act);
}

/** 取 call：call('engineFn', ...args)（单机本地执行 / 多人发给服务器） */
export function useCall() {
  return useGameStore((s) => s.call);
}

/** 取 callSilent：成功时不弹提示 */
export function useCallSilent() {
  return useGameStore((s) => s.callSilent);
}

/** 是否为多人模式 */
export function useIsMulti(): boolean {
  return useGameStore((s) => s.mode === 'multi');
}

/** 多人：全部玩家战队 id（回合状态 > 房间座位 > 状态快照中的 multiplayer.order） */
export function mpHumanTeamIds(mp: Pick<MpState, 'roundStatus' | 'room'>, game: GameState | null): string[] {
  const ids: string[] = [];
  const add = (id: string | undefined | null) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  const order = game?.multiplayer?.order;
  if (Array.isArray(order)) order.forEach(add);
  if (mp.roundStatus) Object.keys(mp.roundStatus.names ?? {}).forEach(add);
  for (const seat of mp.room?.seats ?? []) add(seat.gameTeamId);
  return ids;
}

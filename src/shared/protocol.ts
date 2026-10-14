// ============================================================================
// 多人对战（局域网 / 公网服务器）WebSocket 协议 —— 服务器与客户端共享的契约
// 详见 docs/MULTIPLAYER.md。所有消息为 JSON：{ t: <type>, ...payload }
// ============================================================================
import type { GameState, NewGameOptions, Region } from '../engine/types';

/** v2：房间信息用座位键（seatKey）代替会话 ID；kick 按座位键；error 可带 ref */
export const PROTOCOL_VERSION = 2;
export const DEFAULT_SERVER_PORT = 8686;
export const WS_PATH = '/ws';

/** 玩法：各自组建战队 / 选择已有战队（选手属性重置，仅保留姓名、ID、天赋） */
export type MpMode = 'build' | 'existing';

export interface RoomSettings {
  startTi: number;
  endTi: number;
  difficulty: NewGameOptions['difficulty'];
  mode: MpMode;
}

export interface NewClubSpec {
  name: string;
  tag: string;
  region: Region;
  color: string;
}

/**
 * 房间内的一个座位（玩家）。不含会话 ID：会话 ID 是断线重连回座位的凭证，只保存在服务器上，
 * 客户端之间用座位键（seatKey）识别座位。
 */
export interface RoomSeat {
  /** 座位键：服务器为每个座位随机生成的不透明标识（每个房间独立，与会话 ID 无关），用于移出玩家、识别房主与自己 */
  seatKey: string;
  name: string;               // 玩家昵称
  connected: boolean;
  lobbyReady: boolean;        // 大厅准备
  /** existing 模式：选择的真实战队 id */
  teamId?: string;
  /** build 模式：新俱乐部信息 */
  newClub?: NewClubSpec;
  /** 游戏开始后：该玩家控制的战队 id */
  gameTeamId?: string;
}

export interface RoomInfo {
  id: string;                 // 房间码（6 位大写字母数字）
  name: string;
  /** 房主的座位键 */
  hostSeatKey: string;
  /** 接收者自己的座位键（room 消息按接收者生成；不在座位上时为 null） */
  yourSeatKey: string | null;
  maxPlayers: number;         // 2..6
  status: 'lobby' | 'playing' | 'finished';
  settings: RoomSettings;
  seats: RoomSeat[];
  createdAt: string;
}

/** 房间列表条目 */
export interface RoomSummary {
  id: string;
  name: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  status: RoomInfo['status'];
  settings: RoomSettings;
  /** 接收者在该房间有座位（可重新加入进行中 / 已结束的对局）；已结束的对局只列给原座位玩家 */
  mine?: boolean;
}

/** 接收者自己的座位（按 room.yourSeatKey 查找） */
export function mySeat(room: RoomInfo | null | undefined): RoomSeat | undefined {
  const key = room?.yourSeatKey;
  return key ? room.seats.find((s) => s.seatKey === key) : undefined;
}

/** 接收者是否为房主 */
export function isRoomHost(room: RoomInfo | null | undefined): boolean {
  return !!room?.yourSeatKey && room.hostSeatKey === room.yourSeatKey;
}

/** 实时快讯：其他玩家的公开操作/世界新闻 */
export interface FeedItem {
  id: string;
  at: string;                 // ISO 时间
  actorTeamId?: string;
  actorName?: string;         // 玩家昵称
  title: string;
  body?: string;
  important?: boolean;
}

/** 回合准备状态 */
export interface RoundStatus {
  season: number;
  round: number;
  ready: Record<string, boolean>;       // teamId -> 是否准备
  names: Record<string, string>;        // teamId -> 玩家昵称
  connected: Record<string, boolean>;   // teamId -> 是否在线
  eliminated: Record<string, boolean>;  // teamId -> 是否已出局（观战）
  /** teamId -> 是否由服务器托管（玩家离线时房主开启；玩家重连后自动解除） */
  autopilot?: Record<string, boolean>;
  /** teamId -> 已按「下一回合」请求自动处理，正在等待对手 / 其他玩家（可以时自动准备） */
  autoPending?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// 客户端 → 服务器
// ---------------------------------------------------------------------------
export type ClientMsg =
  | { t: 'hello'; sessionId: string; name: string; protocol: number }
  | { t: 'listRooms' }
  | { t: 'createRoom'; name: string; maxPlayers: number }
  | { t: 'joinRoom'; roomId: string }
  | { t: 'leaveRoom' }
  | { t: 'updateSettings'; settings: Partial<RoomSettings> }               // 仅房主，大厅阶段
  | { t: 'updateSeat'; name?: string; teamId?: string | null; newClub?: NewClubSpec | null }
  | { t: 'setLobbyReady'; ready: boolean }
  | { t: 'kick'; seatKey: string }                                           // 仅房主（座位键见 RoomSeat.seatKey）
  | { t: 'startGame' }                                                       // 仅房主，全员准备后
  | { t: 'call'; reqId: number; fn: string; args: unknown[] }                // 引擎操作 RPC（白名单）
  /**
   * 回合准备。auto：先自动处理本回合事务再准备（默认处理待决事件、补齐首发、快速模拟本方剩余比赛；玩家对决登记快速模拟），
   * 仍需等待对手 / 其他玩家时保留意图、可以时自动准备（src/engine/autoRound.ts）。客户端主按钮「下一回合」发送 auto: true；
   * 缺省为 false（只在没有阻塞时准备，与旧客户端相同）。
   */
  | { t: 'setRoundReady'; ready: boolean; auto?: boolean }
  /** 仅房主，游戏中：托管 / 取消托管一名离线玩家（服务器代为处理待决事件、快速模拟比赛并准备，避免整个房间卡住） */
  | { t: 'setAutopilot'; teamId: string; on: boolean }
  | { t: 'chat'; text: string };

/**
 * 服务器在线统计摘要（只有人数，不含昵称、会话或地址）。服务器在人数 / 房间变化时推送（至多每 2 秒一次），
 * hello 后也会立即发一次；旧服务器不发送，客户端此时不显示统计。
 */
export interface ServerStatsSummary {
  /** 在线玩家（不同会话） */
  online: number;
  /** 其中在进行中对局里的玩家 */
  inGame: number;
  /** 未结束的房间（等待中 + 进行中，含暂时无人在线的对局） */
  rooms: number;
  /** 进行中且有玩家在线的对局 */
  playing: number;
}

// ---------------------------------------------------------------------------
// 服务器 → 客户端
// ---------------------------------------------------------------------------
export type ServerMsg =
  /**
   * lanUrls：服务器的局域网访问地址，只发给来自回环 / 私有网段的连接；公网来的连接与公网模式下为空数组。
   * publicServer：服务器以公网模式运行（--public），界面不显示局域网相关说明（旧服务器不发送 = 局域网模式）。
   */
  | { t: 'welcome'; sessionId: string; serverName: string; lanUrls: string[]; publicServer?: boolean }
  /** 在线统计（可选消息：旧客户端忽略） */
  | ({ t: 'serverStats' } & ServerStatsSummary)
  | { t: 'roomList'; rooms: RoomSummary[] }
  | { t: 'room'; room: RoomInfo | null }
  /** 座位视图快照：以接收者为主视角（settings.playerTeamId = 接收者战队，座位私有字段已换入） */
  | { t: 'state'; version: number; state: GameState }
  | { t: 'callResult'; reqId: number; ok: boolean; message: string; result?: unknown }
  | { t: 'feed'; items: FeedItem[] }
  | { t: 'roundStatus'; status: RoundStatus }
  | { t: 'chat'; from: string; text: string; at: string }
  /** ref：触发该错误的请求类型（如 startGame 被拒绝），客户端据此复位对应的按钮 */
  | { t: 'error'; message: string; ref?: ClientMsg['t'] };

/**
 * 允许客户端通过 RPC 调用的引擎函数（均为 (state, ...args) 签名，服务器在调用者座位上下文中执行）。
 * 推进回合不在此列：多人模式由 setRoundReady + 全员准备后服务器推进。
 * 带 teamId 参数的函数（setLineupSlot / autoLineup）服务器会强制 teamId = 调用者战队。
 */
export const RPC_WHITELIST = [
  // 训练
  'setTrainingFocus', 'doTraining', 'buyExtraTraining', 'doScrim',
  // 教练
  'hireCoach', 'fireCoach',
  // 比赛
  'prepareNextMatch', 'startDraft', 'playerDraftAction', 'playGame', 'commitGame', 'quickSimSeries', 'quickSimTournament',
  // 阵容
  'setLineupSlot', 'autoLineup', 'fillLineupWithTempSubs',
  // 赛程
  'registerForTournament', 'unregisterFromTournament',
  // 市场
  'signFreeAgent', 'bidForPlayer', 'respondToOffer', 'releasePlayer', 'releasePlayers', 'renewContract',
  'generateTempSubCandidates', 'hireTempSub',
  'listPlayerForTransfer', 'unlistPlayer',
  // 选手交易（src/engine/trade.ts）：现金 + 本队选手抵价求购 AI 战队选手（抵价选手只能是调用者座位战队的队员）
  'tradeForPlayer',
  // 归属感
  'raiseSalary', 'talkToPlayer', 'teamBuilding',
  // 选手奖金分成（第九波，src/engine/prizeShare.ts；每回合最多调整一次）
  'setPrizeShare',
  // 新秀选秀（赛季初免费放弃本届选中的新秀；2026-10-14 起选秀默认关闭，保留一个版本供旧房间使用）
  'releaseDraftedRookie',
  // 新秀抽卡（src/engine/gacha.ts，2026-10-14 取代选秀）：单抽 / 十连（共享卡池，先到先得）、同一回合内退回
  'gachaPull', 'gachaDiscard',
  // 事件 / 消息 / 弹窗
  'resolveDecision', 'dismissPopup', 'markAllNewsRead', 'markNewsRead',
  // UI 便捷操作（src/engine/uiActions.ts）与批量挂牌
  'dismissPopups', 'setPlayerAsStarter', 'talkWithPlayer', 'autoDraftAndPlay', 'autoArrangeLineup',
  'listPlayersForTransfer',
] as const;

export type RpcName = (typeof RPC_WHITELIST)[number];

/** 带 teamId 第一参数、需要强制为调用者战队的 RPC */
export const RPC_TEAM_ARG: Partial<Record<RpcName, number>> = {
  setLineupSlot: 0,
  autoLineup: 0,
};

// ============================================================================
// 在线统计：当前在线人数 / 大厅与房间内 / 对局中、房间数、自启动以来的峰值、运行时长。
// - 只统计人数：不记录昵称、会话 ID、IP。按日去重的独立玩家数用「每日随机盐 + 会话 ID」的散列计数，
//   散列只保存在当天的 current.json（跨重启继续去重），换日后丢弃；月度文件里只有数字。
// - GET /api/status 返回 status()；客户端收到节流后的 serverStats 推送（≤ 每 pushIntervalMs 一次，只在变化时）。
// - 服务器日志：每 logIntervalMs 一行（只在有变化时），创新高时一行（节流）；换日时一行前一天的汇总。
// - 每日汇总追加到 <dataDir>/stats/online-YYYY-MM.jsonl（换日时；正常关闭时追加一行 partial: true 的当天截至目前的汇总，
//   重启后同一天继续累计，同一日期以最后一行为准）。--no-save 时不写任何文件。
// ============================================================================
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ServerMsg, ServerStatsSummary } from '../src/shared/protocol';

/** 房间数（按状态） */
export interface RoomCounts {
  /** 全部房间（含等待清理的已结束对局） */
  total: number;
  /** 等待中（大厅阶段） */
  waiting: number;
  /** 进行中的对局（含暂时无人在线的） */
  playing: number;
  /** 进行中且至少有一名玩家在线的对局 */
  active: number;
  /** 已结束、尚未清理的对局 */
  finished: number;
}

/** 当前人数快照 */
export interface OnlineCounts {
  /** WebSocket 连接数（含尚未发送 hello 的） */
  connections: number;
  /** 在线玩家（不同会话） */
  online: number;
  /** 在大厅（不在任何房间内） */
  inLobby: number;
  /** 在房间座位上（等待中 / 进行中 / 已结束的房间） */
  inRoom: number;
  /** 其中在进行中的对局里 */
  inGame: number;
  rooms: RoomCounts;
}

/** 某一天的汇总（月度 jsonl 文件中的一行） */
export interface DailyRecord {
  /** 日期（服务器本地时间 YYYY-MM-DD） */
  date: string;
  /** 当天同时在线玩家的峰值与时间 */
  peakOnline: number;
  peakAt: string | null;
  /** 当天同时在对局中的玩家峰值 */
  peakInGame: number;
  /** 当天连接过的不同玩家（会话）数 */
  uniquePlayers: number;
  /** 当天建立的 WebSocket 连接次数（含重连） */
  totalConnections: number;
  /** 当天开始的对局数 */
  gamesStarted: number;
  /** 当天尚未结束时写出的汇总（服务器关闭 / 重启）；同一日期以最后一行为准 */
  partial?: true;
}

/** GET /api/status 的返回值（只有数字与时间） */
export interface ServerStatus extends OnlineCounts {
  ok: true;
  time: string;
  startedAt: string;
  uptimeSec: number;
  uptimeText: string;
  /** 自启动以来的峰值 */
  peak: { online: number; at: string | null; inGame: number; inGameAt: string | null };
  /** 今天截至目前 */
  today: DailyRecord;
  /** 自启动以来的累计 */
  sinceStart: { connections: number; gamesStarted: number };
}

/** RoomManager 调用的事件接口 */
export interface StatsEvents {
  /** 建立了一个 WebSocket 连接 */
  connection(): void;
  /** 某会话发送了 hello（用于按日去重的独立玩家数，只保存散列） */
  session(sessionId: string): void;
  /** 开始了一局对局 */
  gameStarted(): void;
  /** 人数 / 房间可能变化（更新峰值、安排推送） */
  changed(): void;
  /** hello 后直接发给该连接的当前统计（serverStats 消息 JSON） */
  snapshotJson(): string | null;
}

/** 统计数据来源（RoomManager） */
export interface StatsSource {
  counts(): OnlineCounts;
  /** 当前在线的会话（换日时计入新一天的独立玩家） */
  sessions(): Iterable<string>;
  /** 推送给所有已 hello 的连接 */
  push(data: string): void;
}

export interface ServerStatsOptions {
  /** 统计文件目录（<dataDir>/stats）；null = 不写文件 */
  dir: string | null;
  log?: (msg: string) => void;
  /** 日志间隔（毫秒，默认 10 分钟；0 = 不定期输出） */
  logIntervalMs?: number;
  /** 客户端推送最小间隔（毫秒，默认 2000） */
  pushIntervalMs?: number;
  /** 「创新高」日志的最小间隔（毫秒，默认 5 分钟） */
  peakLogMinMs?: number;
  /** 时钟（测试用） */
  now?: () => number;
  /** 关闭定时器（测试用：手动调用 tick） */
  timers?: boolean;
}

export const DEFAULT_STATS_LOG_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_STATS_PUSH_INTERVAL_MS = 2000;
/** 推送合并窗口：同一时刻的多次变化只推一次 */
const PUSH_BATCH_MS = 100;
const CURRENT_FILE = 'current.json';
const CURRENT_FORMAT = 1;
/**
 * 当天独立玩家去重集合的上限（只存每日加盐散列）：任何人都可以用新的会话 ID 反复连接来虚增「独立玩家」，
 * 上限 100 万时 current.json 约 19 MB、内存 100 MB 以上；5 万足够一台小服务器一天的真实玩家（超出后停止计数，
 * 每日汇总日志显示为「≥ 50000」）。按地址的连接速率限制（app.ts）也限制了虚增速度。
 */
export const MAX_UNIQUES = 50_000;

interface DayAcc {
  date: string;
  salt: string;
  uniques: Set<string>;
  peakOnline: number;
  peakAt: string | null;
  peakInGame: number;
  totalConnections: number;
  gamesStarted: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 服务器本地日期 YYYY-MM-DD */
export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 日志里的时间：今天只写 HH:MM，否则 MM-DD HH:MM */
function shortTime(ms: number, now: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return dayKeyOf(ms) === dayKeyOf(now) ? hhmm(ms) : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(ms)}`;
}

function uptimeText(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

export function zeroCounts(): OnlineCounts {
  return { connections: 0, online: 0, inLobby: 0, inRoom: 0, inGame: 0, rooms: { total: 0, waiting: 0, playing: 0, active: 0, finished: 0 } };
}

/** 推送给客户端的摘要 */
export function statsSummaryOf(c: OnlineCounts): ServerStatsSummary {
  return { online: c.online, inGame: c.inGame, rooms: c.rooms.waiting + c.rooms.playing, playing: c.rooms.active };
}

function newDay(date: string): DayAcc {
  return { date, salt: randomBytes(16).toString('hex'), uniques: new Set(), peakOnline: 0, peakAt: null, peakInGame: 0, totalConnections: 0, gamesStarted: 0 };
}

function hashSession(salt: string, sessionId: string): string {
  return createHash('sha256').update(salt).update('\0').update(sessionId).digest('hex').slice(0, 16);
}

const nonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export class ServerStats implements StatsEvents {
  readonly startedAt: number;
  readonly dir: string | null;
  private src: StatsSource | null = null;
  private readonly log: (msg: string) => void;
  private readonly logIntervalMs: number;
  private readonly pushIntervalMs: number;
  private readonly peakLogMinMs: number;
  private readonly now: () => number;
  private day: DayAcc;
  private peak = { online: 0, at: 0, inGame: 0, inGameAt: 0 };
  private totals = { connections: 0, gamesStarted: 0 };
  private dirty = false;
  private closed = false;
  // 推送节流
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPushAt = 0;
  private lastPushKey = '';
  // 日志
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastLogAt: number;
  private lastLogKey: string;
  private peakTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPeakLogAt = 0;
  private loggedPeak = 0;

  constructor(opts: ServerStatsOptions) {
    this.dir = opts.dir;
    this.log = opts.log ?? (() => undefined);
    this.logIntervalMs = Math.max(0, opts.logIntervalMs ?? DEFAULT_STATS_LOG_INTERVAL_MS);
    this.pushIntervalMs = Math.max(0, opts.pushIntervalMs ?? DEFAULT_STATS_PUSH_INTERVAL_MS);
    this.peakLogMinMs = Math.max(0, opts.peakLogMinMs ?? 5 * 60_000);
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.lastLogAt = this.startedAt;
    this.lastLogKey = this.logKey(zeroCounts());
    this.day = this.restoreDay(dayKeyOf(this.startedAt));
    if (opts.timers !== false) {
      // 每分钟检查一次换日；日志按 logIntervalMs 输出
      const every = this.logIntervalMs > 0 ? Math.min(60_000, this.logIntervalMs) : 60_000;
      this.tickTimer = setInterval(() => this.tick(), every);
      this.tickTimer.unref?.();
    }
  }

  attach(src: StatsSource): void {
    this.src = src;
  }

  // =========================================================================
  // 事件
  // =========================================================================
  connection(): void {
    if (this.closed) return;
    this.rollover(this.now());
    this.totals.connections++;
    this.day.totalConnections++;
    this.dirty = true;
  }

  session(sessionId: string): void {
    if (this.closed || !sessionId) return;
    this.rollover(this.now());
    if (this.day.uniques.size >= MAX_UNIQUES) return;
    const h = hashSession(this.day.salt, sessionId);
    if (!this.day.uniques.has(h)) {
      this.day.uniques.add(h);
      this.dirty = true;
    }
  }

  gameStarted(): void {
    if (this.closed) return;
    this.rollover(this.now());
    this.totals.gamesStarted++;
    this.day.gamesStarted++;
    this.dirty = true;
  }

  changed(): void {
    if (this.closed || !this.src) return;
    const now = this.now();
    this.rollover(now);
    this.observe(this.src.counts(), now);
    this.schedulePush();
  }

  snapshotJson(): string | null {
    if (!this.src) return null;
    return JSON.stringify({ t: 'serverStats', ...statsSummaryOf(this.src.counts()) } satisfies ServerMsg);
  }

  // =========================================================================
  // 查询
  // =========================================================================
  counts(): OnlineCounts {
    return this.src ? this.src.counts() : zeroCounts();
  }

  status(): ServerStatus {
    const now = this.now();
    this.rollover(now);
    const c = this.counts();
    this.observe(c, now);
    const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
    const uptimeSec = Math.max(0, Math.floor((now - this.startedAt) / 1000));
    return {
      ok: true,
      time: new Date(now).toISOString(),
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSec,
      uptimeText: uptimeText(uptimeSec),
      ...c,
      rooms: { ...c.rooms },
      peak: { online: this.peak.online, at: iso(this.peak.at), inGame: this.peak.inGame, inGameAt: iso(this.peak.inGameAt) },
      today: this.record(),
      sinceStart: { ...this.totals },
    };
  }

  /** 日志行：在线 12 人（峰值 30，20:15）· 对局中 3 局 · 房间 5 个 */
  summaryLine(c: OnlineCounts = this.counts(), now = this.now()): string {
    const s = statsSummaryOf(c);
    return `在线 ${s.online} 人（峰值 ${this.peak.online}，${shortTime(this.peak.at, now)}）· 对局中 ${s.playing} 局 · 房间 ${s.rooms} 个`;
  }

  // =========================================================================
  // 定期任务 / 生命周期
  // =========================================================================
  /** 定期：换日检查、按间隔输出日志（只在有变化时）、写出当天累计 */
  tick(): void {
    if (this.closed) return;
    const now = this.now();
    this.rollover(now);
    // 容忍定时器的少许提前，避免漏掉一个周期
    if (this.logIntervalMs > 0 && now - this.lastLogAt >= this.logIntervalMs - Math.min(1000, this.logIntervalMs / 10)) {
      this.lastLogAt = now;
      const c = this.counts();
      this.observe(c, now);
      const key = this.logKey(c);
      if (key !== this.lastLogKey) {
        this.lastLogKey = key;
        this.log(this.summaryLine(c, now));
      }
    }
    if (this.dirty) this.persistCurrent();
  }

  /** 同步写出当天累计（不追加日汇总） */
  flush(): void {
    if (this.dirty) this.persistCurrent();
  }

  /** 关闭：追加当天截至目前的汇总（partial）、写出当天累计、停止定时器 */
  close(): void {
    if (this.closed) return;
    const now = this.now();
    this.rollover(now);
    const rec = this.record();
    if (rec.peakOnline || rec.totalConnections || rec.gamesStarted || rec.uniquePlayers) this.appendRecord({ ...rec, partial: true });
    this.persistCurrent();
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.peakTimer) clearTimeout(this.peakTimer);
    this.tickTimer = null;
    this.pushTimer = null;
    this.peakTimer = null;
  }

  // =========================================================================
  // 内部
  // =========================================================================
  private logKey(c: OnlineCounts): string {
    const s = statsSummaryOf(c);
    return `${s.online}|${s.playing}|${s.rooms}|${this.peak?.online ?? 0}`;
  }

  /** 更新峰值（自启动以来 + 当天） */
  private observe(c: OnlineCounts, now: number): void {
    if (c.online > this.peak.online) {
      this.peak.online = c.online;
      this.peak.at = now;
      this.onNewPeak();
    }
    if (c.inGame > this.peak.inGame) {
      this.peak.inGame = c.inGame;
      this.peak.inGameAt = now;
    }
    if (c.online > this.day.peakOnline) {
      this.day.peakOnline = c.online;
      this.day.peakAt = new Date(now).toISOString();
      this.dirty = true;
    }
    if (c.inGame > this.day.peakInGame) {
      this.day.peakInGame = c.inGame;
      this.dirty = true;
    }
  }

  /** 创新高日志（节流：peakLogMinMs 内只输出一次，到期时输出届时的最高值） */
  private onNewPeak(): void {
    if (this.peakTimer || this.closed) return;
    const wait = this.lastPeakLogAt + this.peakLogMinMs - this.now();
    if (wait <= 0) {
      this.logPeak();
      return;
    }
    this.peakTimer = setTimeout(() => {
      this.peakTimer = null;
      this.logPeak();
    }, wait);
    this.peakTimer.unref?.();
  }

  private logPeak(): void {
    if (this.closed || this.peak.online <= this.loggedPeak) return;
    this.loggedPeak = this.peak.online;
    this.lastPeakLogAt = this.now();
    this.log(`在线人数创新高：${this.peak.online} 人（自启动以来，${shortTime(this.peak.at, this.now())}）`);
  }

  private schedulePush(): void {
    if (this.pushTimer || this.closed) return;
    const wait = Math.max(PUSH_BATCH_MS, this.lastPushAt + this.pushIntervalMs - Date.now());
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.flushPush();
    }, wait);
    this.pushTimer.unref?.();
  }

  private flushPush(): void {
    if (this.closed || !this.src) return;
    const data = JSON.stringify({ t: 'serverStats', ...statsSummaryOf(this.src.counts()) } satisfies ServerMsg);
    if (data === this.lastPushKey) return;
    this.lastPushKey = data;
    this.lastPushAt = Date.now();
    this.src.push(data);
  }

  private record(day: DayAcc = this.day): DailyRecord {
    return {
      date: day.date,
      peakOnline: day.peakOnline,
      peakAt: day.peakAt,
      peakInGame: day.peakInGame,
      uniquePlayers: day.uniques.size,
      totalConnections: day.totalConnections,
      gamesStarted: day.gamesStarted,
    };
  }

  /** 跨过了日期：追加前一天的汇总，新的一天从当前在线状态开始计 */
  private rollover(now: number): void {
    const key = dayKeyOf(now);
    if (key === this.day.date) return;
    const rec = this.record();
    this.appendRecord(rec);
    this.log(
      `在线统计 ${rec.date}：峰值 ${rec.peakOnline} 人${rec.peakAt ? `（${hhmm(Date.parse(rec.peakAt))}）` : ''} · 对局中峰值 ${rec.peakInGame} 人 · `
      + `独立玩家 ${rec.uniquePlayers >= MAX_UNIQUES ? `≥ ${MAX_UNIQUES}` : rec.uniquePlayers} 人 · 连接 ${rec.totalConnections} 次 · 开局 ${rec.gamesStarted} 局`,
    );
    const day = newDay(key);
    if (this.src) {
      const c = this.src.counts();
      day.peakOnline = c.online;
      day.peakAt = c.online ? new Date(now).toISOString() : null;
      day.peakInGame = c.inGame;
      for (const sid of this.src.sessions()) day.uniques.add(hashSession(day.salt, sid));
    }
    this.day = day;
    this.dirty = true;
    this.persistCurrent();
  }

  private appendRecord(rec: DailyRecord): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `online-${rec.date.slice(0, 7)}.jsonl`), `${JSON.stringify(rec)}\n`);
    } catch (err) {
      this.log(`写入在线统计失败：${(err as Error).message}`);
    }
  }

  /** 写出当天累计（临时文件 + rename）：含当天的随机盐与会话散列，重启后同一天继续去重 */
  private persistCurrent(): void {
    this.dirty = false;
    if (!this.dir) return;
    const d = this.day;
    const body = {
      format: CURRENT_FORMAT,
      date: d.date,
      salt: d.salt,
      uniques: [...d.uniques],
      peakOnline: d.peakOnline,
      peakAt: d.peakAt,
      peakInGame: d.peakInGame,
      totalConnections: d.totalConnections,
      gamesStarted: d.gamesStarted,
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, CURRENT_FILE);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(body));
      renameSync(tmp, file);
    } catch (err) {
      this.log(`写入在线统计失败：${(err as Error).message}`);
    }
  }

  /** 启动：同一天接着累计；更早日期的未完成累计（如跨零点时服务器未运行）作为该日汇总追加 */
  private restoreDay(today: string): DayAcc {
    if (!this.dir) return newDay(today);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(this.dir, CURRENT_FILE), 'utf8'));
    } catch {
      return newDay(today);
    }
    const f = raw as Record<string, unknown> | null;
    if (!f || typeof f !== 'object' || typeof f.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f.date) || typeof f.salt !== 'string') {
      return newDay(today);
    }
    const acc: DayAcc = {
      date: f.date,
      salt: f.salt,
      uniques: new Set(Array.isArray(f.uniques) ? f.uniques.filter((x): x is string => typeof x === 'string').slice(0, MAX_UNIQUES) : []),
      peakOnline: nonNeg(f.peakOnline),
      peakAt: typeof f.peakAt === 'string' ? f.peakAt : null,
      peakInGame: nonNeg(f.peakInGame),
      totalConnections: nonNeg(f.totalConnections),
      gamesStarted: nonNeg(f.gamesStarted),
    };
    if (acc.date === today) return acc;
    this.appendRecord(this.record(acc));
    this.dirty = true;
    return newDay(today);
  }
}

// ============================================================================
// 房间持久化：server-data/rooms/<roomId>.json
// - 变更后防抖写入（合并频繁操作），最长等待 maxWaitMs；写入用「临时文件 + rename」保证原子性；
// - 进程退出（SIGINT/SIGTERM）时 flushSync 同步写出所有未落盘的房间；
// - 启动时 loadAll 读回全部房间（损坏的文件改名为 .corrupt-<时间戳> 并跳过）。
// ============================================================================
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GameState } from '../src/engine/types';
import type { RoomInfo, RoomSeat } from '../src/shared/protocol';

export const ROOM_FILE_FORMAT = 1;

/** 服务器内部的座位：协议座位 + 会话 ID（会话 ID 是重连凭证，只在服务器内存与存档中，发给客户端前去掉） */
export interface StoredSeat extends RoomSeat {
  sessionId: string;
}

/** 服务器内部的房间信息（也是存档格式）：房主按会话 ID 记录；发给客户端时转换为 RoomInfo（座位键） */
export interface StoredRoom extends Omit<RoomInfo, 'seats' | 'hostSeatKey' | 'yourSeatKey'> {
  hostSessionId: string;
  seats: StoredSeat[];
}

/** 磁盘上的房间文件 */
export interface RoomFile {
  format: number;
  savedAt: string;
  version: number;
  /** 旧存档（v1 协议）的座位没有 seatKey，载入时补齐 */
  room: StoredRoom;
  /** 主动离开进行中对局的会话（重连时不自动回到该房间） */
  away: string[];
  /** 由服务器托管的离线玩家战队（玩家重连后自动解除） */
  autopilot?: string[];
  /** 被房主移出的会话（不能再加入该房间） */
  kicked?: string[];
  /** 保存时已连续无人在线的时长（毫秒，只计服务器运行时间）；载入后接着计时，供定期清理使用 */
  idleMs?: number;
  state: GameState | null;
}

export interface RoomSnapshotSource {
  /** 生成当前快照（同步，保证一致性）；返回 null 表示房间已不存在 */
  snapshot(roomId: string): RoomFile | null;
}

export interface RoomStoreOptions {
  dir: string;
  debounceMs?: number;
  maxWaitMs?: number;
  log?: (msg: string) => void;
}

const ROOM_ID_RE = /^[A-Z0-9]{6}$/;

export class RoomStore {
  readonly dir: string;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly log: (msg: string) => void;
  private source: RoomSnapshotSource | null = null;
  /** roomId -> { timer, firstDirtyAt } */
  private dirty = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>();
  /** 每个房间的写入串行化 */
  private writing = new Map<string, Promise<void>>();
  /** flushSync 写入代数：进行中的异步写入若在快照之后被 flushSync 抢先写出更新的状态，则放弃 rename（避免旧快照覆盖新快照） */
  private syncGen = new Map<string, number>();
  /** 已请求删除、删除尚未完成的房间（flushSync 时同步删除，进程随即退出也不会留下已删除房间的存档） */
  private removing = new Set<string>();
  private closed = false;

  constructor(opts: RoomStoreOptions) {
    this.dir = opts.dir;
    this.debounceMs = opts.debounceMs ?? 1500;
    this.maxWaitMs = opts.maxWaitMs ?? 8000;
    this.log = opts.log ?? (() => undefined);
    mkdirSync(this.dir, { recursive: true });
  }

  attach(source: RoomSnapshotSource): void {
    this.source = source;
  }

  private file(roomId: string): string {
    return join(this.dir, `${roomId}.json`);
  }

  /** 读取全部房间文件 */
  loadAll(): RoomFile[] {
    const out: RoomFile[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const name of names) {
      const m = /^([A-Z0-9]{6})\.json$/.exec(name);
      if (!m) continue;
      const path = join(this.dir, name);
      try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as RoomFile;
        if (!isRoomFile(data) || data.room.id !== m[1]) throw new Error('房间文件格式错误');
        out.push(data);
      } catch (err) {
        const bad = `${path}.corrupt-${Date.now()}`;
        try {
          renameSync(path, bad);
        } catch {
          /* ignore */
        }
        this.log(`房间文件 ${name} 无法读取（${(err as Error).message}），已改名为 ${bad}`);
      }
    }
    return out;
  }

  /** 标记房间有变更：防抖写入（最长 maxWaitMs 必写一次） */
  markDirty(roomId: string): void {
    if (this.closed || !ROOM_ID_RE.test(roomId)) return;
    const now = Date.now();
    const cur = this.dirty.get(roomId);
    const since = cur?.since ?? now;
    if (cur) clearTimeout(cur.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, since + this.maxWaitMs - now));
    const timer = setTimeout(() => {
      this.dirty.delete(roomId);
      void this.saveNow(roomId);
    }, wait);
    timer.unref?.();
    this.dirty.set(roomId, { timer, since });
  }

  /** 立即异步写入一个房间 */
  saveNow(roomId: string): Promise<void> {
    const prev = this.writing.get(roomId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const snap = this.source?.snapshot(roomId);
      if (!snap) return;
      const gen = this.syncGen.get(roomId) ?? 0;
      const path = this.file(roomId);
      const tmp = `${path}.tmp-${process.pid}`;
      try {
        await writeFile(tmp, JSON.stringify(snap), 'utf8');
        if ((this.syncGen.get(roomId) ?? 0) !== gen) {
          // 写入期间 flushSync 已同步写出更新的快照（如 Ctrl+C）：丢弃这份旧快照
          await unlink(tmp).catch(() => undefined);
          return;
        }
        await rename(tmp, path);
      } catch (err) {
        this.log(`保存房间 ${roomId} 失败：${(err as Error).message}`);
        try {
          await unlink(tmp);
        } catch {
          /* ignore */
        }
      }
    });
    const tracked = next.finally(() => {
      if (this.writing.get(roomId) === tracked) this.writing.delete(roomId);
    });
    this.writing.set(roomId, tracked);
    return tracked;
  }

  /** 删除房间文件（取消未执行的写入；排在进行中的写入之后，flush 会等待删除完成） */
  remove(roomId: string): Promise<void> {
    const cur = this.dirty.get(roomId);
    if (cur) clearTimeout(cur.timer);
    this.dirty.delete(roomId);
    this.removing.add(roomId);
    const prev = this.writing.get(roomId) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await unlink(this.file(roomId));
      } catch {
        /* 不存在 */
      }
    });
    const tracked = next.finally(() => {
      this.removing.delete(roomId);
      if (this.writing.get(roomId) === tracked) this.writing.delete(roomId);
    });
    this.writing.set(roomId, tracked);
    return tracked;
  }

  /** 是否有尚未落盘的变更 */
  hasPending(): boolean {
    return this.dirty.size > 0 || this.writing.size > 0;
  }

  /** 等待所有防抖写入完成（测试/关闭用） */
  async flush(): Promise<void> {
    const ids = [...this.dirty.keys()];
    for (const id of ids) {
      const cur = this.dirty.get(id);
      if (cur) clearTimeout(cur.timer);
      this.dirty.delete(id);
      void this.saveNow(id);
    }
    await Promise.all([...this.writing.values()]);
  }

  /** 同步写出所有未落盘的房间（进程退出前调用）；ids 给出时额外强制写这些房间 */
  flushSync(extraIds: string[] = []): number {
    const ids = new Set([...this.dirty.keys(), ...this.writing.keys(), ...extraIds]);
    for (const cur of this.dirty.values()) clearTimeout(cur.timer);
    this.dirty.clear();
    let n = 0;
    for (const id of ids) {
      const snap = this.source?.snapshot(id);
      if (!snap) {
        // 已删除的房间（定期清理等）：异步删除可能还没执行，进程退出前同步删掉存档；
        // 同时作废进行中的异步写入（其快照取于删除之前，不能在删除后重新写出文件）
        if (this.removing.has(id)) {
          this.syncGen.set(id, (this.syncGen.get(id) ?? 0) + 1);
          try {
            if (existsSync(this.file(id))) unlinkSync(this.file(id));
          } catch (err) {
            this.log(`删除房间 ${id} 的存档失败：${(err as Error).message}`);
          }
        }
        continue;
      }
      this.syncGen.set(id, (this.syncGen.get(id) ?? 0) + 1);
      const path = this.file(id);
      const tmp = `${path}.tmp-sync-${process.pid}`;
      try {
        writeFileSync(tmp, JSON.stringify(snap), 'utf8');
        renameSync(tmp, path);
        n++;
      } catch (err) {
        this.log(`保存房间 ${id} 失败：${(err as Error).message}`);
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    }
    return n;
  }

  /** 停止接受新的防抖写入 */
  close(): void {
    this.closed = true;
    for (const cur of this.dirty.values()) clearTimeout(cur.timer);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRoomFile(v: unknown): v is RoomFile {
  if (!isObj(v) || !isObj(v.room)) return false;
  const r = v.room;
  return typeof r.id === 'string'
    && ROOM_ID_RE.test(r.id)
    && typeof r.name === 'string'
    && typeof r.hostSessionId === 'string'
    && Array.isArray(r.seats)
    && isObj(r.settings)
    && (r.status === 'lobby' || r.status === 'playing' || r.status === 'finished')
    && (v.state === null || v.state === undefined || isObj(v.state));
}

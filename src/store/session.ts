// ============================================================================
// 会话（Session）与进度存储
// - 目前为「匿名模式」：首次访问时在本浏览器生成匿名会话 ID，进度自动保存到该会话下。
// - 进度存放在 IndexedDB（容量远大于 localStorage，单个存档约 1~2MB）；IndexedDB 不可用时降级到 localStorage。
// - 预留 SessionProvider 接口：以后接入登录（账号模式）时，只需实现同样的 load/save/clear 并切换 provider，
//   可把进度同步到服务器。
// ============================================================================
import type { GameState } from '../engine/types';
import { exportSave, importSave, upgradeLoadedState } from '../engine';

export type SessionKind = 'anonymous' | 'account';

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  /** 显示名（匿名模式为"匿名经理-xxxx"） */
  name: string;
  createdAt: string;
}

/** 进度摘要（同步可读，用于入口页「继续游戏」卡片） */
export interface ProgressMeta {
  sessionId: string;
  savedAt: string;
  managerName: string;
  teamName: string;
  teamTag: string;
  teamColor: string;
  ti: number;
  year: number;
  round: number;
  totalRounds: number;
  phase: string;
  honor: number;
  gold: number;
  startTi: number;
  endTi: number;
  gameOver: boolean;
}

const SESSION_KEY = 'd2m:session';
const META_KEY = (sid: string) => `d2m:progress-meta:${sid}`;
const LS_FALLBACK_KEY = (sid: string) => `d2m:progress:${sid}`;
const DB_NAME = 'dota2-manager';
const DB_STORE = 'progress';

// ---------------------------------------------------------------------------
// localStorage 安全访问
// ---------------------------------------------------------------------------
function ls(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let cachedSession: SessionInfo | null = null;

/** 当前会话（匿名模式下首次调用时创建） */
export function getSession(): SessionInfo {
  if (cachedSession) return cachedSession;
  const store = ls();
  try {
    const raw = store?.getItem(SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw) as SessionInfo;
      if (s && typeof s.id === 'string') {
        cachedSession = s;
        return s;
      }
    }
  } catch {
    /* 损坏则重建 */
  }
  const id = randomId();
  const s: SessionInfo = { id, kind: 'anonymous', name: `匿名经理-${id.replace(/-/g, '').slice(0, 4).toUpperCase()}`, createdAt: new Date().toISOString() };
  try {
    store?.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式等：本次会话内仍可用 */
  }
  cachedSession = s;
  return s;
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      // put() 在调用时同步完成结构化克隆，之后引擎继续原地修改 state 不影响已写入的快照
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// 进度读写
// ---------------------------------------------------------------------------
function buildMeta(state: GameState, sid: string): ProgressMeta {
  const team = state.teams[state.settings.playerTeamId];
  return {
    sessionId: sid,
    savedAt: new Date().toISOString(),
    managerName: state.settings.managerName,
    teamName: team?.name ?? '未知战队',
    teamTag: team?.tag ?? '?',
    teamColor: team?.color ?? '#888',
    ti: state.season?.ti ?? state.settings.startTi,
    year: state.season?.year ?? 0,
    round: state.roundIndex,
    totalRounds: state.season?.rounds?.length ?? 0,
    phase: state.phase,
    honor: Math.round(team?.honor ?? 0),
    gold: Math.round(team?.gold ?? 0),
    startTi: state.settings.startTi,
    endTi: state.settings.endTi,
    gameOver: !!state.gameOver,
  };
}

/** 当前会话的进度摘要（同步） */
export function getProgressMeta(): ProgressMeta | null {
  const sid = getSession().id;
  try {
    const raw = ls()?.getItem(META_KEY(sid));
    return raw ? (JSON.parse(raw) as ProgressMeta) : null;
  } catch {
    return null;
  }
}

export type SaveStatus = { state: 'idle' | 'saving' | 'saved' | 'error'; at?: string };
let status: SaveStatus = { state: 'idle' };
const listeners = new Set<(s: SaveStatus) => void>();
function setStatus(s: SaveStatus) {
  status = s;
  listeners.forEach((fn) => fn(s));
}
export function getSaveStatus(): SaveStatus {
  return status;
}
export function onSaveStatus(fn: (s: SaveStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 立即保存当前进度到会话 */
export async function saveProgressNow(state: GameState): Promise<boolean> {
  const sid = getSession().id;
  setStatus({ state: 'saving' });
  let ok = false;
  const db = await openDb();
  if (db) ok = await idbPut(db, sid, state);
  if (!ok) {
    // 降级：localStorage（可能因容量不足失败）
    try {
      ls()?.setItem(LS_FALLBACK_KEY(sid), exportSave(state));
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (ok) {
    const meta = buildMeta(state, sid);
    try {
      ls()?.setItem(META_KEY(sid), JSON.stringify(meta));
    } catch {
      /* ignore */
    }
    setStatus({ state: 'saved', at: meta.savedAt });
  } else {
    setStatus({ state: 'error' });
  }
  return ok;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: GameState | null = null;

/** 防抖保存（频繁操作时合并为一次写入） */
export function scheduleSave(state: GameState, delayMs = 500): void {
  pending = state;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const s = pending;
    pending = null;
    if (s) void saveProgressNow(s);
  }, delayMs);
}

/** 立刻写入尚未落盘的防抖保存（切页、隐藏标签页、返回菜单时调用） */
export async function flushSave(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const s = pending;
  pending = null;
  if (s) await saveProgressNow(s);
}

/** 读取当前会话的进度 */
export async function loadProgress(): Promise<GameState | null> {
  const sid = getSession().id;
  const db = await openDb();
  if (db) {
    const g = await idbGet<GameState>(db, sid);
    // 多人对战的座位视图不能在单机中继续（无法推进）；正常流程不会写入会话进度，这里防御性跳过
    if (g && !g.multiplayer) {
      // 与 JSON 读档同样做规范化与一次性迁移（如真实生涯位置），否则旧进度「继续游戏」不会迁移
      try {
        upgradeLoadedState(g);
      } catch (err) {
        console.error('[session] 进度迁移失败', err);
      }
      return g;
    }
  }
  try {
    const raw = ls()?.getItem(LS_FALLBACK_KEY(sid));
    if (raw) return importSave(raw);
  } catch {
    /* ignore */
  }
  return null;
}

/** 清除当前会话进度（新建游戏覆盖前调用） */
export async function clearProgress(): Promise<void> {
  const sid = getSession().id;
  const db = await openDb();
  if (db) await idbDelete(db, sid);
  try {
    ls()?.removeItem(LS_FALLBACK_KEY(sid));
    ls()?.removeItem(META_KEY(sid));
  } catch {
    /* ignore */
  }
  setStatus({ state: 'idle' });
}

// 标签页隐藏/关闭前尽量落盘
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSave();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushSave());
}

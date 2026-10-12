// ============================================================================
// 背景音乐（第十波 #6）
//
// Dota 2 官网的背景音乐是 Valve 的版权音频，不能下载、打包或随公开仓库分发，所以这里不含任何外部音频：
//   - 默认音源：浏览器 WebAudio 实时合成的原创氛围音乐（D 小调八和弦循环约一分钟：宽广的弦乐 pad + 低音 + 缓慢琶音 + 回声），
//     全部由振荡器生成，节点很少、按需创建，CPU 占用低；
//   - 本地音源：用户自己电脑上的音频文件（文件选择框），只保存在本浏览器的 IndexedDB，不上传、不进仓库。
// 设置（开关 / 音量 / 音源 / 文件名）按浏览器记在 localStorage（`d2m:bgm`），不进存档。
// 遵守自动播放策略：首次用户交互（点击 / 按键 / 触摸）之后才开始发声；标签页隐藏时淡出并暂停，回来后淡入继续。
//
// 本文件的前半部分是纯逻辑（设置解析、音量曲线、音源选择、乐谱），可在 Node 中测试（tests/bankruptcy.test.ts）；
// 后半部分的播放器只在浏览器中运行（模块加载时不访问 window / document）。界面见 src/ui/components/MusicControl.tsx。
// ============================================================================

// ---------------------------------------------------------------------------
// 设置（纯逻辑）
// ---------------------------------------------------------------------------

export type BgmSource = 'generated' | 'file';

export interface BgmSettings {
  enabled: boolean;
  /** 0..1（界面滑块值；实际增益见 volumeToGain） */
  volume: number;
  source: BgmSource;
  /** 本地文件名（只用于显示；文件本身在 IndexedDB） */
  fileName?: string;
}

export const BGM_DEFAULTS: BgmSettings = Object.freeze({ enabled: true, volume: 0.35, source: 'generated' }) as BgmSettings;
export const BGM_STORAGE_KEY = 'd2m:bgm';
/** 本地音频文件大小上限（IndexedDB 容量与读取耗时的折中） */
export const BGM_MAX_FILE_BYTES = 80 * 1024 * 1024;
const FILE_NAME_MAX = 120;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|weba)$/i;

/** 解析存储的设置（JSON 字符串或对象）；损坏 / 非法 / 缺失的字段回退默认值 */
export function parseBgmSettings(raw: unknown): BgmSettings {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  const out: BgmSettings = { ...BGM_DEFAULTS };
  if (!obj || typeof obj !== 'object') return out;
  const o = obj as Record<string, unknown>;
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  if (typeof o.volume === 'number' && Number.isFinite(o.volume)) out.volume = Math.min(1, Math.max(0, o.volume));
  if (o.source === 'generated' || o.source === 'file') out.source = o.source;
  if (typeof o.fileName === 'string' && o.fileName.trim()) out.fileName = o.fileName.trim().slice(0, FILE_NAME_MAX);
  return out;
}

export function serializeBgmSettings(s: BgmSettings): string {
  return JSON.stringify(parseBgmSettings(s));
}

/** 实际使用的音源：选了本地文件但文件不存在（被清除 / 读取失败）时回退到内置音乐 */
export function effectiveSource(s: BgmSettings, hasFile: boolean): BgmSource {
  return s.source === 'file' && hasFile ? 'file' : 'generated';
}

/** 滑块值 → 增益（平方曲线，接近听感的线性） */
export function volumeToGain(volume: number): number {
  const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
  return v * v;
}

/** 目标增益：关闭、标签页隐藏或尚未解锁（自动播放策略）时为 0 */
export function targetGain(s: BgmSettings, env: { hidden: boolean; unlocked: boolean }): number {
  if (!s.enabled || env.hidden || !env.unlocked) return 0;
  return volumeToGain(s.volume);
}

/** 淡入 / 淡出时长（秒） */
export function fadeSeconds(kind: 'in' | 'out'): number {
  return kind === 'in' ? 2.5 : 0.9;
}

/** 本地文件校验：返回中文错误，null = 可用 */
export function validateAudioFile(f: { name: string; type: string; size: number }): string | null {
  const isAudio = (f.type ?? '').startsWith('audio/') || AUDIO_EXT.test(f.name ?? '');
  if (!isAudio) return '请选择音频文件（mp3 / m4a / ogg / wav / flac 等）';
  if (!(f.size > 0)) return '文件为空';
  if (f.size > BGM_MAX_FILE_BYTES) return `文件过大（上限 ${Math.round(BGM_MAX_FILE_BYTES / 1024 / 1024)}MB）`;
  return null;
}

// ---------------------------------------------------------------------------
// 原创氛围音乐的乐谱（纯逻辑）
// ---------------------------------------------------------------------------

/** 速度（每分钟拍数）与每个和弦的拍数：64 BPM × 8 拍 ≈ 7.5 秒一个和弦 */
export const BGM_BPM = 64;
export const CHORD_BEATS = 8;
/** 琶音每步 = 八分音符 */
export const ARP_STEP_BEATS = 0.5;

export interface BgmChord {
  name: string;
  /** 低音（MIDI） */
  bass: number;
  /** pad 和声（MIDI，升序） */
  notes: number[];
}

/** D 小调：Dm – B♭ – F – C – Gm – B♭ – Dm/A – A（属和弦回到主和弦），宽广、平静的史诗感 */
export const PROGRESSION: readonly BgmChord[] = Object.freeze([
  { name: 'Dm', bass: 38, notes: [50, 57, 62, 65] },
  { name: 'B♭', bass: 34, notes: [46, 53, 58, 62] },
  { name: 'F', bass: 41, notes: [53, 57, 60, 65] },
  { name: 'C', bass: 36, notes: [48, 55, 60, 64] },
  { name: 'Gm', bass: 43, notes: [55, 58, 62, 67] },
  { name: 'B♭', bass: 34, notes: [46, 53, 58, 62] },
  { name: 'Dm/A', bass: 33, notes: [45, 57, 62, 65] },
  { name: 'A', bass: 33, notes: [45, 52, 57, 61] },
]);

/** 琶音型（每个和弦 16 个八分音符）：数字为「和弦音阶梯」下标，null 为休止 */
export const ARP_PATTERN: readonly (number | null)[] = Object.freeze([
  0, 1, 2, 3, 4, 3, 2, null, 1, 2, 3, 5, 4, 2, null, null,
]);

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function chordAt(index: number): BgmChord {
  return PROGRESSION[mod(Math.floor(index), PROGRESSION.length)];
}

/** 第 chordIndex 个和弦的第 step 个琶音音符（MIDI；休止为 null）：和弦音升八度排成阶梯，再接最低两音的两个八度 */
export function arpNoteAt(chordIndex: number, step: number): number | null {
  const idx = ARP_PATTERN[mod(Math.floor(step), ARP_PATTERN.length)];
  if (idx === null || idx === undefined) return null;
  const n = chordAt(chordIndex).notes;
  const ladder = [...n.map((x) => x + 12), n[0] + 24, n[1] + 24];
  return ladder[mod(idx, ladder.length)];
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function beatSeconds(): number {
  return 60 / BGM_BPM;
}

/** 整个循环的时长（秒） */
export function patternLengthSeconds(): number {
  return PROGRESSION.length * CHORD_BEATS * beatSeconds();
}

// ---------------------------------------------------------------------------
// 浏览器部分：存储
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function loadSettings(): BgmSettings {
  try {
    return parseBgmSettings(storage()?.getItem(BGM_STORAGE_KEY) ?? null);
  } catch {
    return { ...BGM_DEFAULTS };
  }
}

function saveSettings(s: BgmSettings): void {
  try {
    storage()?.setItem(BGM_STORAGE_KEY, serializeBgmSettings(s));
  } catch {
    // 隐私模式 / 配额不足：只是不记住设置
  }
}

const IDB_NAME = 'd2m-bgm';
const IDB_STORE = 'files';
const IDB_KEY = 'custom';

interface StoredFile {
  name: string;
  type: string;
  size: number;
  blob: Blob;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | null): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      let result: T | null = null;
      if (req) req.onsuccess = () => { result = (req.result ?? null) as T | null; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); resolve(null); };
      tx.onabort = () => { db.close(); resolve(null); };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function readStoredFile(): Promise<StoredFile | null> {
  const v = await idb<StoredFile>('readonly', (s) => s.get(IDB_KEY));
  return v && v.blob instanceof Blob ? v : null;
}

async function writeStoredFile(f: StoredFile): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(f, IDB_KEY);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
      tx.onabort = () => { db.close(); resolve(false); };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

async function deleteStoredFile(): Promise<void> {
  await idb('readwrite', (s) => s.delete(IDB_KEY));
}

// ---------------------------------------------------------------------------
// 浏览器部分：原创氛围音乐合成器
// ---------------------------------------------------------------------------

/** 调度窗口：每 SCHED_MS 毫秒把未来 LOOKAHEAD 秒内的音符排进 WebAudio 时间线 */
const SCHED_MS = 120;
const LOOKAHEAD = 0.9;
/** 合成器自身的输出电平（总音量另由播放器控制） */
const SYNTH_LEVEL = 0.55;
/** 换音源时的交叉淡化（秒） */
const SWAP_FADE = 0.6;

function safeDisconnect(n: AudioNode | null | undefined): void {
  try {
    n?.disconnect();
  } catch {
    // 已断开
  }
}

/** 一组共用包络的振荡器：全部结束后断开包络节点 */
interface Voice {
  env: GainNode;
  left: number;
}

class AmbientSynth {
  private ctx: AudioContext;
  readonly out: GainNode;
  private padBus: GainNode;
  private arpBus: GainNode;
  private nodes: AudioNode[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private t0 = 0;
  private nextChord = 0;
  private nextStep = 0;
  private live = new Set<OscillatorNode>();

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);

    // pad：低通滤波得到温暖的弦乐音色
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 950;
    padFilter.Q.value = 0.6;
    this.padBus = ctx.createGain();
    this.padBus.gain.value = 0.5;
    this.padBus.connect(padFilter);
    padFilter.connect(this.out);

    this.arpBus = ctx.createGain();
    this.arpBus.gain.value = 0.32;
    this.arpBus.connect(this.out);

    // 回声（代替卷积混响，CPU 占用更低）：带低通的反馈延迟，pad 与琶音都送一部分
    const delay = ctx.createDelay(2);
    delay.delayTime.value = beatSeconds() * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 1700;
    const wet = ctx.createGain();
    wet.gain.value = 0.42;
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wet);
    wet.connect(this.out);
    const sendPad = ctx.createGain();
    sendPad.gain.value = 0.35;
    const sendArp = ctx.createGain();
    sendArp.gain.value = 0.6;
    padFilter.connect(sendPad);
    sendPad.connect(delay);
    this.arpBus.connect(sendArp);
    sendArp.connect(delay);

    this.nodes.push(this.out, padFilter, this.padBus, this.arpBus, delay, fb, damp, wet, sendPad, sendArp);
  }

  /** 开始调度并淡入 */
  start(fade: number): void {
    if (this.timer) return;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(SYNTH_LEVEL, now + Math.max(0.05, fade));
    this.t0 = now + 0.1;
    this.nextChord = 0;
    this.nextStep = 0;
    this.tick();
    this.timer = setInterval(() => this.tick(), SCHED_MS);
  }

  /** 淡出后停止并释放全部节点 */
  stop(fade: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + Math.max(0.02, fade));
    setTimeout(() => this.dispose(), Math.max(0.02, fade) * 1000 + 60);
  }

  private dispose(): void {
    for (const o of this.live) {
      try {
        o.stop();
      } catch {
        // 已停止
      }
      safeDisconnect(o);
    }
    this.live.clear();
    for (const n of this.nodes) safeDisconnect(n);
    this.nodes = [];
  }

  private tick(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const horizon = ctx.currentTime + LOOKAHEAD;
    const chordLen = CHORD_BEATS * beatSeconds();
    const stepLen = ARP_STEP_BEATS * beatSeconds();
    const stepsPerChord = Math.round(CHORD_BEATS / ARP_STEP_BEATS);
    // 落后太多（如主线程长时间卡顿）：跳到当前时间附近，避免一次排入大量音符
    if (this.t0 + this.nextStep * stepLen < ctx.currentTime - 1) {
      const skip = Math.ceil((ctx.currentTime - this.t0) / stepLen);
      this.nextStep = skip;
      this.nextChord = Math.ceil(skip / stepsPerChord);
    }
    while (this.t0 + this.nextChord * chordLen < horizon) {
      this.playChord(this.nextChord, this.t0 + this.nextChord * chordLen, chordLen);
      this.nextChord++;
    }
    while (this.t0 + this.nextStep * stepLen < horizon) {
      const chordIdx = Math.floor(this.nextStep / stepsPerChord);
      const note = arpNoteAt(chordIdx, this.nextStep % stepsPerChord);
      if (note !== null) this.playPluck(note, this.t0 + this.nextStep * stepLen, this.nextStep % 4 === 0 ? 1 : 0.75);
      this.nextStep++;
    }
  }

  private voice(dest: AudioNode): Voice {
    const env = this.ctx.createGain();
    env.gain.value = 0;
    env.connect(dest);
    return { env, left: 0 };
  }

  private osc(v: Voice, type: OscillatorType, freq: number, detune: number, start: number, stop: number): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    o.connect(v.env);
    o.start(start);
    o.stop(stop);
    v.left++;
    this.live.add(o);
    o.onended = () => {
      this.live.delete(o);
      safeDisconnect(o);
      if (--v.left <= 0) safeDisconnect(v.env);
    };
  }

  private playChord(index: number, at: number, len: number): void {
    const chord = chordAt(index);
    const attack = 2.2;
    const release = 3.2;
    const end = at + len;
    // pad：每个和弦音两只略微失谐的锯齿波（经总线低通），与下一个和弦交叠
    const pad = this.voice(this.padBus);
    pad.env.gain.setValueAtTime(0, at);
    pad.env.gain.linearRampToValueAtTime(0.11, at + attack);
    pad.env.gain.setValueAtTime(0.11, end);
    pad.env.gain.linearRampToValueAtTime(0, end + release);
    for (const n of chord.notes) {
      const f = midiToFreq(n);
      this.osc(pad, 'sawtooth', f, -7, at, end + release + 0.05);
      this.osc(pad, 'sawtooth', f, 7, at, end + release + 0.05);
    }
    // 低音：正弦 + 低八度三角波，缓慢起伏
    const bass = this.voice(this.out);
    bass.env.gain.setValueAtTime(0, at);
    bass.env.gain.linearRampToValueAtTime(0.22, at + 1.2);
    bass.env.gain.setValueAtTime(0.22, end - 0.2);
    bass.env.gain.linearRampToValueAtTime(0, end + 1.5);
    this.osc(bass, 'sine', midiToFreq(chord.bass), 0, at, end + 1.6);
    this.osc(bass, 'triangle', midiToFreq(chord.bass - 12), 0, at, end + 1.6);
  }

  private playPluck(note: number, at: number, accent: number): void {
    const v = this.voice(this.arpBus);
    v.env.gain.setValueAtTime(0, at);
    v.env.gain.linearRampToValueAtTime(0.16 * accent, at + 0.015);
    v.env.gain.exponentialRampToValueAtTime(0.0008, at + 1.6);
    this.osc(v, 'triangle', midiToFreq(note), 0, at, at + 1.7);
    this.osc(v, 'sine', midiToFreq(note + 12), 3, at, at + 1.0);
  }
}

// ---------------------------------------------------------------------------
// 浏览器部分：播放器（单例）
// ---------------------------------------------------------------------------

export type BgmStatus = 'off' | 'waiting' | 'loading' | 'playing' | 'paused' | 'unsupported';

export interface BgmSnapshot {
  settings: BgmSettings;
  status: BgmStatus;
  /** 实际在用的音源（本地文件缺失时为 generated） */
  active: BgmSource;
  /** 本地文件可用（IndexedDB 中已保存，或本次会话刚选择） */
  hasFile: boolean;
  /** 最近一次提示（中文；如文件无法播放已改用内置音乐） */
  error: string | null;
}

type Listener = () => void;

/** 用户交互事件：首次交互解锁自动播放；之后音频上下文仍未运行时（Safari 等要求手势、切回前台时恢复失败）在手势中重试 */
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend', 'click'] as const;

function audioContextCtor(): (new (opts?: AudioContextOptions) => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

class BgmPlayer {
  private settings: BgmSettings = { ...BGM_DEFAULTS };
  private snapshot: BgmSnapshot = { settings: this.settings, status: 'off', active: 'generated', hasFile: false, error: null };
  private listeners = new Set<Listener>();
  private inited = false;
  private unlocked = false;
  private ctx: AudioContext | null = null;
  /** 总音量（音量滑块 + 开关 / 隐藏时的淡入淡出） */
  private master: GainNode | null = null;
  private synth: AmbientSynth | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioGain: GainNode | null = null;
  private audioUrl: string | null = null;
  private file: StoredFile | null = null;
  private fileChecked = false;
  private current: BgmSource | null = null;
  /** 当前已在发声（音量变化用短过渡，否则用淡入） */
  private audible = false;
  private error: string | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private applying: Promise<void> = Promise.resolve();

  /** 初始化（App 挂载时调用一次；重复调用无副作用） */
  init(): void {
    if (this.inited || typeof window === 'undefined') return;
    this.inited = true;
    this.settings = loadSettings();
    // 监听常驻（开销很小）：首次交互解锁；之后只在「应当发声但音频上下文未运行」时重试，
    // 否则浏览器拒绝无手势恢复时（如 Safari 从后台切回）会一直静音，直到用户去点音乐面板
    const onGesture = () => {
      const first = !this.unlocked;
      this.unlocked = true;
      const stalled = !!audioContextCtor() && this.ctx?.state !== 'running'
        && targetGain(this.settings, { hidden: pageHidden(), unlocked: true }) > 0;
      if (first || stalled) this.schedule();
    };
    for (const ev of UNLOCK_EVENTS) window.addEventListener(ev, onGesture, true);
    document.addEventListener('visibilitychange', () => this.schedule());
    // 读取本地文件（异步），之后按设置决定音源
    void readStoredFile().then((f) => {
      if (!this.file) this.file = f;
      this.fileChecked = true;
      this.schedule();
    });
    this.emit();
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): BgmSnapshot => this.snapshot;

  setEnabled(enabled: boolean): void {
    this.update({ enabled });
  }

  setVolume(volume: number): void {
    this.update({ volume });
  }

  setSource(source: BgmSource): void {
    this.update({ source });
  }

  /** 选择本地音频文件：校验后存入 IndexedDB 并切换为本地音源。返回提示文案（null = 成功） */
  async chooseFile(file: File): Promise<string | null> {
    const err = validateAudioFile(file);
    if (err) return err;
    // 在用户手势中先准备好音频上下文（之后的异步存储完成时可能已不在手势内）
    this.unlocked = true;
    this.ensureContext();
    void this.ctx?.resume().catch(() => undefined);
    const stored: StoredFile = { name: file.name, type: file.type, size: file.size, blob: file };
    const saved = await writeStoredFile(stored);
    // 存储失败（隐私模式等）时本次会话仍可播放，只是刷新后不会记住
    this.dropFilePlayback();
    this.file = stored;
    this.fileChecked = true;
    this.error = null;
    this.update({ source: 'file', fileName: file.name });
    return saved ? null : '浏览器不允许保存文件（可能处于隐私模式）：本次可以播放，刷新后需要重新选择';
  }

  /** 移除本地文件（回到内置音乐） */
  async removeFile(): Promise<void> {
    await deleteStoredFile();
    this.dropFilePlayback();
    this.file = null;
    this.error = null;
    this.update({ source: 'generated', fileName: undefined });
  }

  // ---- 内部 ----

  private update(patch: Partial<BgmSettings>): void {
    const next = parseBgmSettings({ ...this.settings, ...patch });
    if ('fileName' in patch && patch.fileName === undefined) delete next.fileName;
    this.settings = next;
    saveSettings(next);
    // 由用户操作触发：视为一次交互（自动播放策略允许在用户手势中启动音频）
    this.unlocked = true;
    this.schedule();
  }

  /** 串行执行 apply（避免并发的切换互相打断） */
  private schedule(): void {
    // 用户手势中同步创建 / 恢复音频上下文（之后的异步步骤可能已不在手势内）
    if (targetGain(this.settings, { hidden: pageHidden(), unlocked: this.unlocked }) > 0) {
      const ctx = this.ensureContext();
      if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    }
    this.applying = this.applying.then(() => this.apply()).catch((e) => console.error('[bgm]', e));
    this.emit();
  }

  private emit(): void {
    const supported = !!audioContextCtor();
    const active = effectiveSource(this.settings, !!this.file);
    let status: BgmStatus;
    if (!supported) status = 'unsupported';
    else if (!this.settings.enabled) status = 'off';
    else if (!this.unlocked) status = 'waiting';
    else if (pageHidden()) status = 'paused';
    // 浏览器仍未允许发声（需要再与页面交互一次）：不显示「播放中」
    else if (this.ctx && this.ctx.state !== 'running') status = 'waiting';
    else status = this.current === active && this.audible ? 'playing' : 'loading';
    const prev = this.snapshot;
    if (prev.settings === this.settings && prev.status === status && prev.active === active
      && prev.hasFile === !!this.file && prev.error === this.error) return;
    this.snapshot = { settings: this.settings, status, active, hasFile: !!this.file, error: this.error };
    for (const fn of this.listeners) fn();
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
      this.ctx.onstatechange = () => this.emit();
    } catch {
      this.ctx = null;
      this.master = null;
    }
    return this.ctx;
  }

  /** 按当前设置 / 可见性 / 解锁状态调整播放（幂等） */
  private async apply(): Promise<void> {
    const goal = targetGain(this.settings, { hidden: pageHidden(), unlocked: this.unlocked });
    if (goal <= 0) {
      this.fadeOutAndPause(!this.settings.enabled);
      this.emit();
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return this.emit();
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      // 浏览器仍不允许：等下一次交互
    }
    // 选了本地文件但还没读完：先不启动内置音乐（避免刷新后先响内置音乐再切换）
    if (this.settings.source === 'file' && !this.fileChecked) return this.emit();
    const want = effectiveSource(this.settings, !!this.file);
    if (want !== this.current) this.switchTo(want);
    if (this.current === 'file' && this.audio?.paused) {
      try {
        await this.audio.play();
      } catch {
        // 格式不受支持 / 文件损坏：回退内置音乐（设置保留，下次仍会尝试该文件）
        this.error = '无法播放该音频文件，已改用内置音乐';
        this.dropFilePlayback();
        this.file = null;
        this.switchTo('generated');
      }
    }
    this.ramp(volumeToGain(this.settings.volume), this.audible ? 0.15 : fadeSeconds('in'));
    this.audible = true;
    this.emit();
  }

  private ramp(target: number, seconds: number): void {
    const ctx = this.ctx;
    const g = this.master?.gain;
    if (!ctx || !g) return;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(target, now + Math.max(0.02, seconds));
  }

  /** 淡出后暂停（关闭时释放音源；标签页隐藏时保留，回来后接着播） */
  private fadeOutAndPause(release: boolean): void {
    if (!this.ctx || !this.master) return;
    const out = fadeSeconds('out');
    if (this.audible) this.ramp(0, out);
    this.audible = false;
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      // 期间又恢复了播放：不暂停
      if (targetGain(this.settings, { hidden: pageHidden(), unlocked: this.unlocked }) > 0) return;
      this.audio?.pause();
      if (release) {
        this.synth?.stop(0.02);
        this.synth = null;
        this.current = null;
      }
      void this.ctx?.suspend().catch(() => undefined);
      this.emit();
    }, out * 1000 + 80);
  }

  /** 切换音源：旧音源淡出后释放，新音源淡入（交叉淡化） */
  private switchTo(src: BgmSource): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    if (this.synth) {
      this.synth.stop(SWAP_FADE);
      this.synth = null;
    }
    if (this.current === 'file' && src !== 'file') this.fadeAudioOut();
    this.current = null;
    if (src === 'generated') {
      this.synth = new AmbientSynth(ctx, master);
      this.synth.start(this.audible ? SWAP_FADE : 0.05);
      this.current = 'generated';
      return;
    }
    const f = this.file;
    if (!f) return;
    try {
      if (!this.audio) {
        this.audio = new Audio();
        this.audio.loop = true;
        this.audio.preload = 'auto';
        this.audioGain = ctx.createGain();
        this.audioGain.connect(master);
        ctx.createMediaElementSource(this.audio).connect(this.audioGain);
      }
      if (!this.audioUrl) {
        this.audioUrl = URL.createObjectURL(f.blob);
        this.audio.src = this.audioUrl;
      }
      const g = this.audioGain!.gain;
      const now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(this.audible ? 0 : 1, now);
      if (this.audible) g.linearRampToValueAtTime(1, now + SWAP_FADE);
      this.current = 'file';
    } catch {
      this.error = '无法加载该音频文件，已改用内置音乐';
      this.dropFilePlayback();
      this.file = null;
      this.synth = new AmbientSynth(ctx, master);
      this.synth.start(0.05);
      this.current = 'generated';
    }
  }

  private fadeAudioOut(): void {
    const ctx = this.ctx;
    const audio = this.audio;
    const g = this.audioGain?.gain;
    if (!ctx || !audio || !g) return;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + SWAP_FADE);
    setTimeout(() => {
      if (this.current !== 'file') audio.pause();
    }, SWAP_FADE * 1000 + 60);
  }

  /** 停止本地文件播放并释放对象 URL（音频元素与其 WebAudio 节点保留复用） */
  private dropFilePlayback(): void {
    if (this.current === 'file') this.current = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      try {
        this.audio.load();
      } catch {
        // 忽略
      }
    }
    if (this.audioUrl) {
      try {
        URL.revokeObjectURL(this.audioUrl);
      } catch {
        // 忽略
      }
      this.audioUrl = null;
    }
  }
}

/** 背景音乐播放器单例（浏览器中使用；Node 中只创建对象、不做任何事） */
export const bgm = new BgmPlayer();

/** App 挂载时调用 */
export function initBgm(): void {
  bgm.init();
}

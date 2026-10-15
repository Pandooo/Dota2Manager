// 背景音乐控制（第十波 #6）：顶栏的小按钮 + 点击展开的小面板（开关、音量、音源、本地文件）。
// 播放器见 src/ui/audio/bgm.ts（默认为浏览器实时生成的原创氛围音乐；本地文件只存在本浏览器的 IndexedDB，不上传、不进仓库）。
// 设置按浏览器记住，不进存档，与游戏状态无关（不经 call()）。非游戏界面（主菜单 / 大厅 / 新游戏 / 结算页）用 floating 版本固定在角落：
// 主菜单右上角空着用 'top'；新游戏 / 大厅 / 房间的右上角有返回按钮或玩家名，用 'bottom'（右下角，面板向上展开）；
// 'inline' = 浮动样式但不固定位置，由页面自己摆放（手机上的生涯总结放在横幅右上角、随页面滚走，不压住下方的排行表）。
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { bgm, type BgmSnapshot, type BgmStatus } from '../audio/bgm';
import { ConfirmButton } from './ConfirmPopover';
import { Button, cx } from './common';
import NewBadge from './NewBadge';

const STATUS_TEXT: Record<BgmStatus, string> = {
  off: '已关闭',
  waiting: '等待播放：浏览器要求先与页面交互，点击页面任意位置后开始',
  loading: '准备中…',
  playing: '播放中',
  paused: '标签页在后台，已暂停',
  unsupported: '当前浏览器不支持网页音频',
};

function useBgm(): BgmSnapshot {
  return useSyncExternalStore(bgm.subscribe, bgm.getSnapshot, bgm.getSnapshot);
}

/** 音符图标；关闭时带斜线 */
function NoteIcon({ off, className }: { off?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cx('h-4 w-4', className)} fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path d="M8 14.5V4.2l8-1.7v10.2" strokeLinejoin="round" />
      <ellipse cx="5.8" cy="14.6" rx="2.3" ry="1.8" fill="currentColor" stroke="none" />
      <ellipse cx="13.8" cy="12.9" rx="2.3" ry="1.8" fill="currentColor" stroke="none" />
      {off && <path d="M3 3l14 14" strokeLinecap="round" />}
    </svg>
  );
}

/** 播放中的小均衡器动画（减少动态效果时静止） */
function Bars() {
  return (
    <span className="ml-0.5 inline-flex h-3 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-[2px] rounded-sm bg-gold motion-safe:animate-pulse"
          style={{ height: `${[60, 100, 75][i]}%`, animationDelay: `${i * 220}ms`, animationDuration: '1.4s' }}
        />
      ))}
    </span>
  );
}

const PANEL_W = 300;

export default function MusicControl({ floating = false }: { floating?: boolean | 'top' | 'bottom' | 'inline' }) {
  const snap = useBgm();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const s = snap.settings;
  const on = s.enabled && snap.status !== 'unsupported';
  const sourceLabel = snap.active === 'file' ? `本地文件「${s.fileName ?? '音频'}」` : '内置原创氛围音乐';
  const title = `背景音乐：${STATUS_TEXT[snap.status]}${on ? `（${sourceLabel}，音量 ${Math.round(s.volume * 100)}%）` : ''}`;

  const button = (
    <button
      ref={btnRef}
      type="button"
      onClick={() => setOpen((o) => !o)}
      title={title}
      aria-label="背景音乐设置"
      aria-expanded={open}
      className={cx(
        'relative inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors pointer-coarse:min-h-10 pointer-coarse:min-w-10 pointer-coarse:justify-center',
        floating ? 'border-line bg-panel/90 shadow-lg shadow-black/40 backdrop-blur' : 'border-transparent',
        open ? 'border-gold/50 text-gold' : on ? 'text-ink hover:bg-panel-2' : 'text-faint hover:bg-panel-2 hover:text-mute',
      )}
    >
      <NoteIcon off={!on} />
      {snap.status === 'playing' && <Bars />}
      {snap.status === 'waiting' && <span className="h-1.5 w-1.5 rounded-full bg-gold/80" />}
      {/* 新功能徽标（v0.2）：点击本按钮后消失；顶栏里窄屏时改为右上角角标，不占顶栏宽度 */}
      <NewBadge feature="bgm" narrow={floating ? 'inline' : 'corner'} />
    </button>
  );

  return (
    <>
      {floating && floating !== 'inline' ? (
        <div
          className="fixed z-40"
          style={
            floating === 'bottom'
              ? { right: 'calc(0.75rem + env(safe-area-inset-right, 0px))', bottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }
              : { right: 'calc(0.75rem + env(safe-area-inset-right, 0px))', top: 'calc(0.75rem + env(safe-area-inset-top, 0px))' }
          }
        >
          {button}
        </div>
      ) : (
        button
      )}
      {open && <MusicPanel snap={snap} anchorRef={btnRef} onClose={() => setOpen(false)} />}
    </>
  );
}

function MusicPanel({ snap, anchorRef, onClose }: { snap: BgmSnapshot; anchorRef: React.RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = snap.settings;

  // 定位：按钮正下方（下方放不下时在上方，如右下角的 floating 按钮），靠右对齐，不超出视口
  // （header 的 backdrop-filter 会成为 fixed 的包含块，故 portal 到 body）
  useLayoutEffect(() => {
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      if (!a) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const h = boxRef.current?.offsetHeight ?? 0;
      const left = Math.min(Math.max(8, a.right - PANEL_W), vw - PANEL_W - 8);
      const below = a.bottom + 8;
      const top = below + h > vh - 8 && a.top - 8 - h >= 8 ? a.top - 8 - h : below;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);

  // 点击外部 / Esc 关闭（确认气泡在面板外渲染：点击气泡不算外部）
  useEffect(() => {
    // pointerdown：iOS Safari 点按页面空白处不发 mousedown
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || boxRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      if (t.closest?.('[role="dialog"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const msg = await bgm.chooseFile(f);
      setNote(msg ? { text: msg, ok: false } : { text: `已选择「${f.name}」，只保存在本浏览器`, ok: true });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const unsupported = snap.status === 'unsupported';
  const fileBlock = !snap.hasFile ? '尚未选择本地音频文件' : undefined;

  return createPortal(
    <div
      ref={boxRef}
      className="fade-up fixed z-[70] rounded-xl border border-line bg-panel p-3 text-sm shadow-2xl shadow-black/60"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: PANEL_W }}
    >
      <div className="flex items-center gap-2">
        <NoteIcon off={!s.enabled} className="text-gold" />
        <span className="font-semibold">背景音乐</span>
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled}
          disabled={unsupported}
          onClick={() => bgm.setEnabled(!s.enabled)}
          title={unsupported ? STATUS_TEXT.unsupported : s.enabled ? '关闭背景音乐' : '开启背景音乐'}
          className={cx(
            'relative ml-auto h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            s.enabled ? 'border-gold/60 bg-gold/80' : 'border-line bg-panel-3',
          )}
        >
          <span className={cx('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all', s.enabled ? 'left-[18px]' : 'left-0.5')} />
        </button>
      </div>
      <div className={cx('mt-1 text-[11px]', snap.status === 'playing' ? 'text-good' : snap.status === 'waiting' ? 'text-gold' : 'text-faint')}>
        {STATUS_TEXT[snap.status]}
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs text-mute">
        音量
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(s.volume * 100)}
          onChange={(e) => bgm.setVolume(Number(e.target.value) / 100)}
          disabled={unsupported}
          className="h-1 flex-1 cursor-pointer accent-[var(--color-gold)] disabled:cursor-not-allowed"
          aria-label="背景音乐音量"
        />
        <span className="w-9 text-right tabular text-ink">{Math.round(s.volume * 100)}%</span>
      </label>

      <div className="mt-3 text-xs text-mute">音源</div>
      <div className="mt-1 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() => bgm.setSource('generated')}
          disabled={unsupported}
          className={cx(
            'cursor-pointer rounded-md border px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            snap.active === 'generated' ? 'border-gold/60 bg-gold/10 text-gold' : 'border-line text-mute hover:bg-panel-2 hover:text-ink',
          )}
          title="浏览器实时合成的原创氛围音乐（pad + 缓慢琶音），约一分钟一循环"
        >
          内置氛围音乐
          <div className="text-[10px] text-faint">原创 · 实时生成</div>
        </button>
        <button
          type="button"
          onClick={() => bgm.setSource('file')}
          disabled={unsupported || !snap.hasFile}
          className={cx(
            'cursor-pointer rounded-md border px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            snap.active === 'file' ? 'border-gold/60 bg-gold/10 text-gold' : 'border-line text-mute hover:bg-panel-2 hover:text-ink',
          )}
          title={fileBlock ?? `播放本地文件「${s.fileName ?? '音频'}」`}
        >
          本地文件
          <div className="truncate text-[10px] text-faint">{snap.hasFile ? s.fileName ?? '已保存' : '未选择'}</div>
        </button>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.aac,.ogg,.oga,.opus,.wav,.flac,.webm"
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <Button size="xs" variant="secondary" disabled={unsupported || busy} onClick={() => fileRef.current?.click()}>
          {busy ? '保存中…' : snap.hasFile ? '更换音频文件…' : '选择音频文件…'}
        </Button>
        {snap.hasFile && (
          <ConfirmButton
            size="xs"
            variant="ghost"
            confirm={{ message: '从本浏览器删除已保存的音频文件，改回内置氛围音乐。', confirmLabel: '移除' }}
            onConfirm={() => {
              void bgm.removeFile();
              setNote(null);
            }}
          >
            移除
          </ConfirmButton>
        )}
      </div>
      {(note || snap.error) && (
        <div className={cx('mt-1.5 text-[11px]', note?.ok && !snap.error ? 'text-good' : 'text-bad')}>{snap.error ?? note?.text}</div>
      )}
      <p className="mt-2.5 border-t border-line pt-2 text-[11px] leading-relaxed text-faint">
        本地音频文件只保存在本浏览器（IndexedDB），不会上传，也不进入存档；设置按浏览器记住。标签页切到后台时自动暂停。
      </p>
    </div>,
    document.body,
  );
}

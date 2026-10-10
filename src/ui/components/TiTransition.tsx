// ============================================================================
// TI 转场（第八波 item 8）
// - 进入 TI 正赛回合：全屏转场——不朽之盾升起 → 发光 → 消失，随后露出界面（约 3.2 秒；点击 / 空格 / 回车 / Esc 跳过；
//   系统开启「减少动态效果」时只做简单淡入淡出）。配色取该届 TI 的官方主视觉主题（src/data/tis.json theme）。
// - TI 预选回合：顶部简短横幅（数秒后自动收起，可点击关闭）；回合通知已是总览内的卡片（不再弹窗），横幅回合开始即出现。
// - 页面在后台（切到其他标签页；多人模式下回合常由其他玩家准备后推进）时先不播放，回到页面再播放（tiIntroCanShow）。
// - TI 正赛回合期间：顶栏 / 底栏的主题色点缀（TiTopAccent / TiBarGlow，由 TopBar / ActionBar 挂载）。
// 触发逻辑见 src/ui/tiTheme.ts（纯函数）与 store/gameStore.ts 的 syncTiIntro：每个存档 × 座位 × 届次只触发一次，
// 单机与多人（每个座位的客户端各自）一致。本组件只读游戏状态，不修改任何引擎数据。
// ============================================================================
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useGameStore } from '../../store/gameStore';
import { tiYear } from '../../engine';
import type { TiTheme } from '../../engine/types';
import {
  rgba, tiCityOf, tiEntryInfo, tiInfoOf, tiIntroCanShow, tiThemeOf, type TiEntryInfo, type TiIntroCue,
} from '../tiTheme';
import { cx } from './common';

/** 正赛转场总时长（与 index.css .ti-intro 的 --ti-dur 一致） */
const MAIN_MS = 3200;
/** 减少动态效果时的淡入淡出时长（与 .ti-intro-reduced 一致） */
const REDUCED_MS = 1800;
/** 跳过时的淡出时长（与 .ti-intro-leave 一致） */
const SKIP_FADE_MS = 280;
/** 预选横幅停留时长 / 收起动画时长 */
const BANNER_MS = 7000;
const BANNER_LEAVE_MS = 250;

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_QUERY).matches;
  } catch {
    return false;
  }
}

/** 年份：tis.json > 引擎推算 */
function tiYearOf(ti: number): number {
  const y = tiInfoOf(ti)?.year;
  if (typeof y === 'number' && Number.isFinite(y)) return y;
  try {
    return tiYear(ti);
  } catch {
    return 2010 + ti;
  }
}

/** 「The International 2019 · 上海」（城市未知时省略） */
function tiTitle(ti: number, city: string): string {
  return `The International ${tiYearOf(ti)}${city ? ` · ${city}` : ''}`;
}

function themeVars(theme: TiTheme): CSSProperties {
  return {
    '--ti-primary': theme.primary,
    '--ti-secondary': theme.secondary,
    '--ti-accent': theme.accent,
    '--ti-glow': rgba(theme.accent, 0.55),
  } as CSSProperties;
}

// ---------------------------------------------------------------------------
// 挂载点（GameScreen）
// ---------------------------------------------------------------------------
export default function TiTransition() {
  const cue = useGameStore((s) => s.tiIntro);
  const visible = useDocumentVisible();
  // 条件未满足（页面在后台）时先不挂载，提示保留在 store，满足后再播放。
  // 回合通知（game.popups）已改为总览中的「通知」卡片、不再弹出遮罩，预选横幅不必等通知清空
  // （否则一直点「下一回合」、从不清通知的玩家永远看不到横幅），因此待显示弹窗数恒为 0。
  if (!cue || !tiIntroCanShow(cue.kind, { visible, popupsPending: 0 })) return null;
  return cue.kind === 'main' ? <TiMainIntro key={cue.key} cue={cue} /> : <TiQualifierBanner key={cue.key} cue={cue} />;
}

/** 页面是否可见（document.visibilityState；无 document 时视为可见） */
function readDocumentVisible(): boolean {
  try {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  } catch {
    return true;
  }
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(readDocumentVisible);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const on = () => setVisible(readDocumentVisible());
    document.addEventListener('visibilitychange', on);
    on();
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

// ---------------------------------------------------------------------------
// 正赛：全屏转场
// ---------------------------------------------------------------------------
const SPARKS = Array.from({ length: 14 }, (_, i) => ({
  left: 6 + ((i * 37) % 88),
  delay: 0.55 + ((i * 0.17) % 1.2),
  size: 3 + (i % 4),
}));

function TiMainIntro({ cue }: { cue: TiIntroCue }) {
  const dismiss = useGameStore((s) => s.dismissTiIntro);
  const game = useGameStore((s) => s.game);
  const [reduced] = useState(prefersReducedMotion);
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const theme = tiThemeOf(cue.ti);
  const city = tiCityOf(game, cue.ti);
  const title = tiTitle(cue.ti, city);
  let entry: TiEntryInfo | null = null;
  try {
    entry = game ? tiEntryInfo(game, cue.ti, 'main') : null;
  } catch {
    entry = null;
  }

  // 播放完毕自动收起
  useEffect(() => {
    const t = setTimeout(dismiss, reduced ? REDUCED_MS : MAIN_MS);
    return () => clearTimeout(t);
  }, [dismiss, reduced]);

  // 跳过：快速淡出后收起
  const skip = useCallback(() => setLeaving(true), []);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(dismiss, SKIP_FADE_MS);
    return () => clearTimeout(t);
  }, [leaving, dismiss]);

  // 键盘跳过；先把焦点移到遮罩上，避免空格 / 回车落在刚点过的「下一回合」按钮上再次触发
  useEffect(() => {
    try {
      rootRef.current?.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        skip();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [skip]);

  const entryText =
    entry?.status === 'main' ? '你的战队入围本届正赛' : entry?.status === 'out' ? '本届无缘正赛 · 观赛' : null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`TI${cue.ti} 正赛开幕：${title}`}
      tabIndex={-1}
      onClick={skip}
      className={cx(
        'ti-intro fixed inset-0 z-[90] cursor-pointer select-none overflow-hidden outline-none',
        reduced ? 'ti-intro-reduced' : 'ti-intro-run',
        leaving && 'ti-intro-leave',
      )}
      style={{
        ...themeVars(theme),
        // 上层主色晕染 + 下层不透明底色（遮罩必须完全不透明，避免露出下面的界面）
        background: `radial-gradient(ellipse 80% 70% at 50% 58%, ${rgba(theme.primary, 0.5)} 0%, ${rgba(theme.primary, 0)} 60%), radial-gradient(ellipse 120% 100% at 50% 55%, ${theme.secondary} 0%, #040508 100%)`,
      }}
    >
      {/* 放射光 */}
      <div
        aria-hidden
        className="ti-intro-rays pointer-events-none absolute rounded-full"
        style={{
          left: '50%',
          top: '42%',
          width: '160vmax',
          height: '160vmax',
          marginLeft: '-80vmax',
          marginTop: '-80vmax',
          background: `repeating-conic-gradient(from 0deg, ${rgba(theme.accent, 0.13)} 0deg 3deg, transparent 3deg 15deg)`,
          maskImage: 'radial-gradient(circle, black 0%, transparent 55%)',
          WebkitMaskImage: 'radial-gradient(circle, black 0%, transparent 55%)',
        }}
      />
      {/* 上升的光点 */}
      {SPARKS.map((s, i) => (
        <span
          key={i}
          aria-hidden
          className="ti-spark pointer-events-none absolute rounded-full"
          style={{
            left: `${s.left}%`,
            bottom: '-2vh',
            width: s.size,
            height: s.size,
            background: theme.accent,
            boxShadow: `0 0 ${s.size * 3}px ${rgba(theme.accent, 0.9)}`,
            animationDelay: `${s.delay}s`,
          }}
        />
      ))}

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-7 px-6">
        <div className="relative grid place-items-center">
          {/* 光晕 */}
          <div
            aria-hidden
            className="ti-aegis-halo pointer-events-none absolute rounded-full"
            style={{
              left: '50%',
              top: '50%',
              width: 520,
              height: 520,
              marginLeft: -260,
              marginTop: -260,
              background: `radial-gradient(circle, ${rgba('#FFFFFF', 0.55)} 0%, ${rgba(theme.accent, 0.55)} 22%, ${rgba(theme.primary, 0.28)} 45%, transparent 70%)`,
            }}
          />
          <div className="ti-aegis relative" style={{ filter: `drop-shadow(0 0 22px ${rgba(theme.accent, 0.6)})` }}>
            <AegisSvg theme={theme} size={200} shine={!reduced} />
          </div>
        </div>

        <div className="ti-intro-text max-w-[92vw] text-center">
          <div className="text-[11px] font-semibold tracking-[0.5em]" style={{ color: rgba(theme.accent, 0.95) }}>
            TI{cue.ti} · 正赛开幕
          </div>
          <div className="mt-2 text-3xl font-black tracking-[0.12em] text-white sm:text-4xl" style={{ textShadow: `0 0 24px ${rgba(theme.accent, 0.55)}` }}>
            {title}
          </div>
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border px-4 py-1 text-sm font-semibold" style={{ borderColor: rgba(theme.accent, 0.55), color: theme.accent, background: rgba(theme.secondary, 0.55) }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: theme.primary, boxShadow: `0 0 8px ${theme.primary}` }} />
            {theme.name}
          </div>
          {entryText && <div className="mt-3 text-sm text-white/75">{entryText}</div>}
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-6 text-center text-xs text-white/45">点击或按空格跳过</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 预选：顶部横幅
// ---------------------------------------------------------------------------
function TiQualifierBanner({ cue }: { cue: TiIntroCue }) {
  const dismiss = useGameStore((s) => s.dismissTiIntro);
  const game = useGameStore((s) => s.game);
  const [leaving, setLeaving] = useState(false);
  const theme = tiThemeOf(cue.ti);
  const city = tiCityOf(game, cue.ti);
  let entry: TiEntryInfo | null = null;
  try {
    entry = game ? tiEntryInfo(game, cue.ti, 'qualifier') : null;
  } catch {
    entry = null;
  }

  const close = useCallback(() => setLeaving(true), []);
  useEffect(() => {
    const t = setTimeout(close, BANNER_MS);
    return () => clearTimeout(t);
  }, [close]);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(dismiss, BANNER_LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving, dismiss]);

  const entryText =
    entry?.status === 'invited'
      ? '你的战队已获直邀，静候正赛'
      : entry?.status === 'qualifier'
        ? `出战${entry.qualifierName ? `「${entry.qualifierName}」` : '赛区预选赛'}${entry.qualifierSlots ? `：前 ${entry.qualifierSlots} 名晋级正赛` : ''}`
        : entry?.status === 'out'
          ? '本届未获参赛资格'
          : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cx('ti-banner fixed inset-x-0 top-14 z-[45] cursor-pointer', leaving && 'ti-banner-leave')}
      style={{ ...themeVars(theme), '--ti-banner-ms': `${BANNER_MS}ms` } as CSSProperties}
      onClick={close}
      title="点击收起"
    >
      <div
        className="relative overflow-hidden border-b shadow-lg shadow-black/40"
        style={{
          borderColor: rgba(theme.accent, 0.5),
          background: `linear-gradient(90deg, ${rgba(theme.secondary, 0.97)} 0%, ${rgba(theme.primary, 0.55)} 50%, ${rgba(theme.secondary, 0.97)} 100%), #0b0e14`,
        }}
      >
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2 text-sm" style={{ textShadow: '0 1px 2px rgba(0, 0, 0, 0.65)' }}>
          <div className="shrink-0" style={{ filter: `drop-shadow(0 0 6px ${rgba(theme.accent, 0.7)})` }}>
            <AegisSvg theme={theme} size={22} />
          </div>
          <div className="min-w-0 flex-1 truncate">
            <span className="font-bold tracking-wider" style={{ color: theme.accent }}>
              TI{cue.ti} 预选赛
            </span>
            <span className="mx-2 text-white/40">|</span>
            <span className="text-white/90">
              {tiTitle(cue.ti, '')} 正赛{city ? `将于${city}举行` : '即将开幕'} · 主题「{theme.name}」
            </span>
            {entryText && (
              <>
                <span className="mx-2 text-white/40">·</span>
                <span className="font-semibold text-white">{entryText}</span>
              </>
            )}
          </div>
          <button
            className="shrink-0 cursor-pointer rounded px-1.5 text-white/60 hover:text-white"
            aria-label="关闭"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
          >
            ✕
          </button>
        </div>
        <div className="ti-banner-progress absolute inset-x-0 bottom-0 h-[2px]" style={{ background: theme.accent }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TI 正赛回合的主题点缀（顶栏 / 底栏）
// ---------------------------------------------------------------------------
/** TI 正赛回合（且游戏未结束）时返回该届主题，否则 null */
export function useTiRoundTheme(): TiTheme | null {
  const phase = useGameStore((s) => s.game?.phase);
  const ti = useGameStore((s) => s.game?.season?.ti);
  const over = useGameStore((s) => !!s.game?.gameOver);
  if (phase !== 'ti' || over || typeof ti !== 'number') return null;
  return tiThemeOf(ti);
}

/** 顶栏：底边主题渐变线 + 极淡的主题色晕染（父元素需 relative） */
export function TiTopAccent() {
  const theme = useTiRoundTheme();
  if (!theme) return null;
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: `linear-gradient(90deg, ${rgba(theme.primary, 0.18)} 0%, transparent 38%, transparent 62%, ${rgba(theme.accent, 0.12)} 100%)` }}
      />
      <span
        aria-hidden
        className="ti-accent-breathe pointer-events-none absolute inset-x-0 -bottom-px h-[2px]"
        style={{ background: `linear-gradient(90deg, transparent 0%, ${theme.primary} 20%, ${theme.accent} 50%, ${theme.primary} 80%, transparent 100%)` }}
      />
    </>
  );
}

/** 底栏：顶边主题渐变线 + 向上的柔和光晕（父元素需 relative） */
export function TiBarGlow() {
  const theme = useTiRoundTheme();
  if (!theme) return null;
  return (
    <>
      <span
        aria-hidden
        className="ti-accent-breathe pointer-events-none absolute inset-x-0 -top-7 h-7"
        style={{ background: `linear-gradient(to top, ${rgba(theme.accent, 0.14)}, transparent)` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-px h-px"
        style={{ background: `linear-gradient(90deg, transparent 0%, ${theme.primary} 25%, ${theme.accent} 50%, ${theme.primary} 75%, transparent 100%)` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: `radial-gradient(60% 140% at 50% 0%, ${rgba(theme.primary, 0.16)}, transparent 70%)` }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 不朽之盾（内联 SVG，无外部图片）
// ---------------------------------------------------------------------------
const SHIELD =
  'M100 6 C120 18 150 22 186 16 C182 34 184 52 190 66 C192 120 160 182 100 234 C40 182 8 120 10 66 C16 52 18 34 14 16 C50 22 80 18 100 6 Z';

export function AegisSvg({ theme, size, shine }: { theme: TiTheme; size: number; shine?: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const metal = `ti-metal-${uid}`;
  const edge = `ti-edge-${uid}`;
  const core = `ti-core-${uid}`;
  const sheen = `ti-sheen-${uid}`;
  const clip = `ti-clip-${uid}`;
  return (
    <svg viewBox="0 0 200 240" width={size} height={Math.round(size * 1.2)} aria-hidden focusable="false">
      <defs>
        <linearGradient id={metal} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.3" stopColor={theme.accent} />
          <stop offset="0.68" stopColor={theme.primary} />
          <stop offset="1" stopColor={theme.secondary} />
        </linearGradient>
        <linearGradient id={edge} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="0.5" stopColor={theme.accent} />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.7" />
        </linearGradient>
        <radialGradient id={core} cx="0.5" cy="0.44" r="0.5">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.85" />
          <stop offset="0.45" stopColor={theme.accent} stopOpacity="0.5" />
          <stop offset="1" stopColor={theme.accent} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={sheen} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.75" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <clipPath id={clip}>
          <path d={SHIELD} />
        </clipPath>
      </defs>
      {/* 盾身 */}
      <path d={SHIELD} fill={`url(#${metal})`} stroke={`url(#${edge})`} strokeWidth="3" strokeLinejoin="round" />
      <path d={SHIELD} fill="none" stroke="#FFFFFF" strokeOpacity="0.45" strokeWidth="2.5" transform="translate(100 120) scale(0.84) translate(-100 -120)" />
      <path d={SHIELD} fill={theme.secondary} fillOpacity="0.3" transform="translate(100 122) scale(0.7) translate(-100 -122)" />
      {/* 中脊 */}
      <path d="M100 30 L100 214" stroke="#FFFFFF" strokeOpacity="0.35" strokeWidth="1.5" />
      {/* 核心光 */}
      <ellipse cx="100" cy="106" rx="60" ry="66" fill={`url(#${core})`} />
      {/* 中央纹章 */}
      <path
        d="M100 50 C113 70 128 84 128 106 C128 126 113 138 100 156 C87 138 72 126 72 106 C72 84 87 70 100 50 Z"
        fill={theme.secondary}
        fillOpacity="0.78"
        stroke={theme.accent}
        strokeWidth="2.5"
      />
      <path d="M100 72 C107 84 114 93 114 106 C114 118 107 126 100 136 C93 126 86 118 86 106 C86 93 93 84 100 72 Z" fill={theme.accent} fillOpacity="0.92" />
      {/* 卷纹 */}
      <g fill="none" stroke={theme.accent} strokeWidth="3" strokeLinecap="round" strokeOpacity="0.9">
        <path d="M100 156 C86 170 66 168 54 152 C46 142 52 128 64 132" />
        <path d="M100 156 C114 170 134 168 146 152 C154 142 148 128 136 132" />
        <path d="M100 172 C94 186 84 196 72 198" />
        <path d="M100 172 C106 186 116 196 128 198" />
        <path d="M72 64 C60 70 50 82 48 98" />
        <path d="M128 64 C140 70 150 82 152 98" />
      </g>
      {/* 顶部宝石 */}
      <path d="M100 16 L108 29 L100 42 L92 29 Z" fill={theme.accent} stroke="#FFFFFF" strokeOpacity="0.8" strokeWidth="1.5" />
      {/* 扫光 */}
      {shine && (
        <g clipPath={`url(#${clip})`}>
          <g transform="skewX(-18)">
            <rect className="ti-aegis-shine" x="-60" y="-20" width="70" height="290" fill={`url(#${sheen})`} />
          </g>
        </g>
      )}
    </svg>
  );
}

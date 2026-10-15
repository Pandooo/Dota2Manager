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
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useGameStore } from '../../store/gameStore';
import { tiYear } from '../../engine';
import type { TiTheme } from '../../engine/types';
import {
  rgba, tiCityOf, tiEntryInfo, tiInfoOf, tiIntroCanShow, tiThemeOf, type TiEntryInfo, type TiIntroCue,
} from '../tiTheme';
import { cx } from './common';
import { isLocalArtFailed, localAegisUrl, markLocalArtFailed } from '../localArt';
import { mixHex } from '../emblem';

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
            <AegisArt theme={theme} size={220} shine={!reduced} />
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
      className={cx('ti-banner fixed inset-x-0 z-[45] cursor-pointer', leaving && 'ti-banner-leave')}
      // 紧贴顶栏下沿（--chrome-top = 顶栏实际高度：多人窄屏两行、刘海屏安全区都算在内，不压住顶栏第二行）
      style={{ ...themeVars(theme), top: 'var(--chrome-top, 56px)', '--ti-banner-ms': `${BANNER_MS}ms` } as CSSProperties}
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
            <AegisArt theme={theme} size={24} />
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
// 不朽之盾（第十波 #7：重新绘制的原创矢量图，内联 SVG，无外部图片）
// 官方冠军盾图片属于 Valve 版权美术，不随仓库分发。这里按「圆盾 + 中央宝石饰 + 雕纹盾缘」的大致轮廓与比例原创绘制，
// 不描摹、不复制官方美术的任何细节；配色取该届 TI 主题。用户可在 git 忽略的 public/local/aegis.png|svg|webp
// 放入自己的图片覆盖（AegisArt，见 src/ui/localArt.ts 与 public/local/README.txt）。
// 坐标系 240×240，圆心 (120, 120)：盾缘 110–114（24 瓣扇贝边）→ 雕纹带 96–110（铆钉 + 叶纹）→ 盾面（四道斜向棱脊、
// 四颗小宝石、卷草纹、虚线刻环）→ 中央凸台（r 36）→ 八角刻面主宝石。
// ---------------------------------------------------------------------------
const AC = 120;
const fx = (n: number) => n.toFixed(2);
/** 极坐标 → 坐标（角度以正上方为 0°，顺时针） */
function apt(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [AC + r * Math.cos(a), AC + r * Math.sin(a)];
}
const ap = (r: number, deg: number) => apt(r, deg).map(fx).join(' ');

const RIM_LOBES = 24;
/** 外轮廓：24 瓣扇贝边的圆盾 */
const AEGIS_OUTLINE = (() => {
  const step = 360 / RIM_LOBES;
  let d = `M${ap(110, 0)}`;
  for (let i = 0; i < RIM_LOBES; i++) d += `Q${ap(119, i * step + step / 2)} ${ap(110, (i + 1) * step)}`;
  return `${d}Z`;
})();
/** 雕纹带：铆钉（偶数瓣）与叶纹（奇数瓣） */
const RIM_RIVETS = Array.from({ length: RIM_LOBES / 2 }, (_, i) => apt(103.5, i * 30 + 7.5));
const RIM_LEAVES = Array.from({ length: RIM_LOBES / 2 }, (_, i) => ({ at: apt(103.5, i * 30 + 22.5), rot: i * 30 + 22.5 }));
/** 四道斜向棱脊（45° / 135° / 225° / 315°） */
const AEGIS_RIBS = [45, 135, 225, 315].map(
  (a) => `M${ap(44, a)}Q${ap(70, a - 10)} ${ap(94, a)}Q${ap(70, a + 10)} ${ap(44, a)}Z`,
);
const AEGIS_RIB_LINES = [45, 135, 225, 315].map((a) => `M${ap(48, a)}L${ap(90, a)}`);
/** 四颗小宝石（正上 / 右 / 下 / 左）与通向盾缘的刻线 */
const AEGIS_SMALL_GEMS = [0, 90, 180, 270].map((a) => ({ at: apt(62, a), rot: a }));
const AEGIS_CARDINAL_LINES = [0, 90, 180, 270].map((a) => `M${ap(73, a)}L${ap(93, a)}`);
/** 卷草纹：每个象限两道，以小宝石为轴左右对称 */
const AEGIS_CURLS = [0, 90, 180, 270].flatMap((q) =>
  [1, -1].map((s) => {
    const [ex, ey] = apt(53, q + s * 27);
    return {
      d: `M${ap(88, q + s * 12)}C${ap(80, q + s * 34)} ${ap(64, q + s * 9)} ${fx(ex)} ${fx(ey)}`,
      end: [ex, ey] as [number, number],
    };
  }),
);
/** 凸台周围的小珠 */
const AEGIS_BEADS = Array.from({ length: 12 }, (_, i) => apt(41, i * 30 + 15));
/** 八角刻面主宝石：外轮廓 / 台面 */
const GEM_OUTER: [number, number][] = [[111, 99], [129, 99], [136, 107], [136, 133], [129, 141], [111, 141], [104, 133], [104, 107]];
const GEM_TABLE: [number, number][] = [[115, 108], [125, 108], [128, 111.5], [128, 128.5], [125, 132], [115, 132], [112, 128.5], [112, 111.5]];
const poly = (pts: [number, number][]) => pts.map(([x, y]) => `${x} ${y}`).join(' ');
/** 盾身底色：以银灰金属为底、按该届主题着色（官方冠军盾为银色金属质感，这里只取其大意） */
const AEGIS_STEEL = '#7A818C';
const AEGIS_DARK = '#2A2E35';

export function AegisSvg({ theme, size, shine }: { theme: TiTheme; size: number; shine?: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const metal = `ti-metal-${uid}`;
  const rimEdge = `ti-edge-${uid}`;
  const field = `ti-field-${uid}`;
  const boss = `ti-boss-${uid}`;
  const gem = `ti-gem-${uid}`;
  const sheen = `ti-sheen-${uid}`;
  const clip = `ti-clip-${uid}`;
  return (
    <svg viewBox="0 0 240 240" width={size} height={size} aria-hidden focusable="false">
      <defs>
        <linearGradient id={metal} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.3" stopColor={mixHex(theme.accent, '#FFFFFF', 0.35)} />
          <stop offset="0.66" stopColor={mixHex(theme.accent, AEGIS_STEEL, 0.55)} />
          <stop offset="1" stopColor={mixHex(theme.secondary, '#000000', 0.15)} />
        </linearGradient>
        <linearGradient id={rimEdge} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="0.5" stopColor={theme.accent} />
          <stop offset="1" stopColor={theme.secondary} />
        </linearGradient>
        <radialGradient id={field} cx="0.42" cy="0.36" r="0.72">
          <stop offset="0" stopColor={mixHex(theme.primary, '#E6EAF0', 0.62)} />
          <stop offset="0.5" stopColor={mixHex(theme.primary, AEGIS_STEEL, 0.45)} />
          <stop offset="1" stopColor={mixHex(theme.secondary, AEGIS_DARK, 0.3)} />
        </radialGradient>
        <radialGradient id={boss} cx="0.38" cy="0.32" r="0.75">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.38" stopColor={mixHex(theme.accent, '#FFFFFF', 0.3)} />
          <stop offset="1" stopColor={mixHex(theme.accent, AEGIS_STEEL, 0.5)} />
        </radialGradient>
        <linearGradient id={gem} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.3" stopColor={mixHex(theme.primary, '#FFFFFF', 0.35)} />
          <stop offset="0.7" stopColor={theme.primary} />
          <stop offset="1" stopColor={mixHex(theme.primary, '#000000', 0.45)} />
        </linearGradient>
        <linearGradient id={sheen} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.75" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <clipPath id={clip}>
          <path d={AEGIS_OUTLINE} />
        </clipPath>
      </defs>

      {/* 盾缘：扇贝边金属圈 */}
      <path d={AEGIS_OUTLINE} fill={`url(#${metal})`} stroke={`url(#${rimEdge})`} strokeWidth="2.5" strokeLinejoin="round" />
      {/* 雕纹带：内外刻线 + 铆钉 + 叶纹 */}
      <circle cx={AC} cy={AC} r="108" fill="none" stroke="#FFFFFF" strokeOpacity="0.4" strokeWidth="1" />
      <circle cx={AC} cy={AC} r="98.5" fill="none" stroke={theme.secondary} strokeOpacity="0.75" strokeWidth="1.6" />
      {RIM_RIVETS.map(([x, y], i) => (
        <g key={`rv${i}`}>
          <circle cx={fx(x)} cy={fx(y)} r="2.8" fill={theme.secondary} fillOpacity="0.55" />
          <circle cx={fx(x - 0.5)} cy={fx(y - 0.5)} r="1.9" fill="#FFFFFF" fillOpacity="0.85" />
        </g>
      ))}
      {RIM_LEAVES.map(({ at: [x, y], rot }, i) => (
        <path
          key={`lf${i}`}
          d="M-6 0Q0-3.2 6 0Q0 3.2-6 0Z M-6 0H6"
          transform={`translate(${fx(x)} ${fx(y)}) rotate(${rot})`}
          fill={theme.secondary}
          fillOpacity="0.4"
          stroke={theme.secondary}
          strokeOpacity="0.6"
          strokeWidth="0.8"
        />
      ))}

      {/* 盾面 */}
      <circle cx={AC} cy={AC} r="96" fill={`url(#${field})`} />
      <circle cx={AC} cy={AC} r="77" fill="none" stroke={theme.accent} strokeOpacity="0.55" strokeWidth="1.4" strokeDasharray="1.6 4.4" strokeLinecap="round" />
      {/* 棱脊 */}
      {AEGIS_RIBS.map((d, i) => (
        <path key={`rb${i}`} d={d} fill={`url(#${metal})`} fillOpacity="0.92" stroke={theme.secondary} strokeOpacity="0.55" strokeWidth="1.2" />
      ))}
      {AEGIS_RIB_LINES.map((d, i) => (
        <path key={`rl${i}`} d={d} stroke="#FFFFFF" strokeOpacity="0.5" strokeWidth="1" />
      ))}
      {/* 卷草纹 */}
      <g fill="none" stroke={theme.accent} strokeWidth="2.2" strokeLinecap="round" strokeOpacity="0.85">
        {AEGIS_CURLS.map((c, i) => (
          <path key={`cu${i}`} d={c.d} />
        ))}
      </g>
      {AEGIS_CURLS.map((c, i) => (
        <circle key={`ce${i}`} cx={fx(c.end[0])} cy={fx(c.end[1])} r="2.4" fill={theme.accent} fillOpacity="0.9" />
      ))}
      {AEGIS_CARDINAL_LINES.map((d, i) => (
        <path key={`cl${i}`} d={d} stroke={theme.accent} strokeOpacity="0.6" strokeWidth="1.5" strokeLinecap="round" />
      ))}
      {/* 小宝石 */}
      {AEGIS_SMALL_GEMS.map(({ at: [x, y], rot }, i) => (
        <g key={`sg${i}`} transform={`translate(${fx(x)} ${fx(y)}) rotate(${rot})`}>
          <path d="M0-8L5.5 0L0 8L-5.5 0Z" fill={`url(#${gem})`} stroke="#FFFFFF" strokeOpacity="0.85" strokeWidth="1" />
          <path d="M0-8L-5.5 0L0-1.5Z" fill="#FFFFFF" fillOpacity="0.55" />
        </g>
      ))}

      {/* 中央凸台 */}
      <circle cx={AC} cy={AC} r="45.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.28" strokeWidth="1" />
      {AEGIS_BEADS.map(([x, y], i) => (
        <circle key={`bd${i}`} cx={fx(x)} cy={fx(y)} r="1.7" fill={theme.accent} />
      ))}
      <circle cx={AC} cy={AC} r="36" fill={`url(#${boss})`} stroke={theme.secondary} strokeOpacity="0.7" strokeWidth="2" />
      <circle cx={AC} cy={AC} r="30" fill="none" stroke="#FFFFFF" strokeOpacity="0.45" strokeWidth="1.2" />

      {/* 八角刻面主宝石 + 爪镶 */}
      <polygon points={poly(GEM_OUTER)} fill={`url(#${gem})`} stroke="#FFFFFF" strokeOpacity="0.9" strokeWidth="1.4" strokeLinejoin="round" />
      <g stroke="#FFFFFF" strokeOpacity="0.45" strokeWidth="0.8">
        {GEM_OUTER.map(([x, y], i) => (
          <line key={`gf${i}`} x1={x} y1={y} x2={GEM_TABLE[i][0]} y2={GEM_TABLE[i][1]} />
        ))}
      </g>
      <polygon points={poly(GEM_TABLE)} fill="#FFFFFF" fillOpacity="0.22" stroke="#FFFFFF" strokeOpacity="0.55" strokeWidth="0.8" />
      <polygon points="115,108 125,108 121,116 113,118" fill="#FFFFFF" fillOpacity="0.6" />
      {[GEM_OUTER[0], GEM_OUTER[1], GEM_OUTER[4], GEM_OUTER[5]].map(([x, y], i) => (
        <circle key={`pr${i}`} cx={x} cy={y} r="2.3" fill={`url(#${metal})`} stroke={theme.secondary} strokeOpacity="0.6" strokeWidth="0.6" />
      ))}

      {/* 盾缘内侧高光 */}
      <path d={AEGIS_OUTLINE} fill="none" stroke="#FFFFFF" strokeOpacity="0.3" strokeWidth="1.2" transform={`translate(${AC} ${AC}) scale(0.965) translate(-${AC} -${AC})`} />
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

/** 冠军盾：本地覆盖图片（public/local/aegis.*）优先，否则为原创矢量图 */
export function AegisArt({ theme, size, shine }: { theme: TiTheme; size: number; shine?: boolean }) {
  const url = localAegisUrl();
  const [bad, setBad] = useState(false);
  if (url && !bad && !isLocalArtFailed(url)) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        draggable={false}
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'contain', display: 'block' }}
        onError={() => {
          markLocalArtFailed(url);
          setBad(true);
        }}
      />
    );
  }
  return <AegisSvg theme={theme} size={size} shine={shine} />;
}

// ---------------------------------------------------------------------------
// 顶栏正中的冠军盾徽记（第十波 #7）：TI 预选回合与 TI 正赛回合显示，该届主题配色；点击显示「The International {年份}」说明
// （单机：顶栏绝对居中，≥ lg 显示；多人：顶栏中间是玩家条，徽记排在玩家条之前）
// ---------------------------------------------------------------------------
const TI_PHASE_LABEL: Record<string, string> = { ti_qualifier: 'TI 预选赛回合', ti: 'TI 正赛回合' };

export function TiAegisBadge() {
  const phase = useGameStore((s) => s.game?.phase);
  const ti = useGameStore((s) => s.game?.season?.ti);
  const over = useGameStore((s) => !!s.game?.gameOver);
  const multi = useGameStore((s) => s.mode === 'multi');
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const show = (phase === 'ti' || phase === 'ti_qualifier') && !over && typeof ti === 'number';
  useEffect(() => {
    if (!show) setOpen(false);
  }, [show]);
  if (!show) return null;
  const theme = tiThemeOf(ti);
  const label = `The International ${tiYearOf(ti)}`;
  return (
    <div
      className={
        multi
          ? 'hidden shrink-0 md:block'
          : 'pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 lg:block'
      }
    >
      <button
        ref={btnRef}
        type="button"
        className="pointer-events-auto grid cursor-pointer place-items-center rounded-full p-0.5 transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2"
        style={{ filter: `drop-shadow(0 0 6px ${rgba(theme.accent, 0.75)})`, outlineColor: theme.accent }}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <AegisArt theme={theme} size={34} />
      </button>
      {open && <TiAegisPopover anchor={btnRef} ti={ti} phase={phase ?? ''} theme={theme} label={label} onClose={() => setOpen(false)} />}
    </div>
  );
}

function TiAegisPopover({
  anchor, ti, phase, theme, label, onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  ti: number;
  phase: string;
  theme: TiTheme;
  label: string;
  onClose: () => void;
}) {
  const game = useGameStore((s) => s.game);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    // 气泡宽 w-72（288px）以按钮为中心；窄屏时夹在视口内（左右各留 8px）
    const half = Math.min(144, window.innerWidth / 2 - 8);
    if (r) setPos({ left: Math.min(Math.max(8 + half, r.left + r.width / 2), window.innerWidth - 8 - half), top: r.bottom + 8 });
    // pointerdown：iOS Safari 点按页面空白处不发 mousedown
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);
  if (!pos || typeof document === 'undefined') return null;
  const city = tiCityOf(game, ti);
  let entry: TiEntryInfo | null = null;
  try {
    entry = game ? tiEntryInfo(game, ti, phase === 'ti' ? 'main' : 'qualifier') : null;
  } catch {
    entry = null;
  }
  const entryText =
    entry?.status === 'main' ? '你的战队入围本届正赛'
      : entry?.status === 'invited' ? '你的战队已获直邀'
        : entry?.status === 'qualifier' ? `出战${entry.qualifierName ? `「${entry.qualifierName}」` : '赛区预选赛'}`
          : entry?.status === 'out' ? (phase === 'ti' ? '本届无缘正赛 · 观赛' : '本届未获参赛资格')
            : null;
  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label={label}
      className="fade-up fixed z-[60] w-72 max-w-[calc(100vw-16px)] -translate-x-1/2 overflow-hidden rounded-xl border text-sm shadow-2xl shadow-black/50"
      style={{
        left: pos.left,
        top: pos.top,
        borderColor: rgba(theme.accent, 0.55),
        background: `linear-gradient(160deg, ${rgba(theme.primary, 0.4)} 0%, ${rgba(theme.secondary, 0.97)} 60%), #0b0e14`,
      }}
    >
      <div className="flex items-center gap-3 px-3.5 py-3">
        <div className="shrink-0" style={{ filter: `drop-shadow(0 0 8px ${rgba(theme.accent, 0.7)})` }}>
          <AegisArt theme={theme} size={44} />
        </div>
        <div className="min-w-0">
          <div className="font-bold tracking-wide text-white">{label}</div>
          <div className="text-xs leading-snug text-white/70">{[city, `主题「${theme.name}」`].filter(Boolean).join(' · ')}</div>
          <div className="mt-1 text-xs font-semibold" style={{ color: theme.accent }}>
            TI{ti} · {TI_PHASE_LABEL[phase] ?? 'TI 回合'}
          </div>
        </div>
      </div>
      {entryText && <div className="border-t border-white/10 px-3.5 py-2 text-xs text-white/85">{entryText}</div>}
    </div>,
    document.body,
  );
}

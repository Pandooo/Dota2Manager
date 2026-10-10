// ============================================================================
// 英雄头像 / 英雄标签（按主属性着色的首字头像）
// 力量=红 敏捷=绿 智力=蓝 全才=紫
// ============================================================================
import type { HeroAttr, HeroInfo, Position } from '../../engine/types';
import { POSITIONS } from '../../engine/types';
import { POSITION_SHORT, heroById, heroName } from '../../engine';
import { cx } from './common';
import { safe } from './MatchShared';

export const ATTR_LABEL: Record<HeroAttr, string> = { str: '力量', agi: '敏捷', int: '智力', uni: '全才' };

const ATTR_BG: Record<HeroAttr, string> = {
  str: 'linear-gradient(135deg, #e0644b 0%, #9b2f1f 55%, #5a170e 100%)',
  agi: 'linear-gradient(135deg, #5fcf73 0%, #2b8a3e 55%, #144a20 100%)',
  int: 'linear-gradient(135deg, #64a6f2 0%, #2c66b8 55%, #123266 100%)',
  uni: 'linear-gradient(135deg, #b48af0 0%, #7448c2 55%, #3a2170 100%)',
};
const UNKNOWN_BG = 'linear-gradient(135deg, #6b7488 0%, #3a4255 100%)';

export const ATTR_TEXT: Record<HeroAttr, string> = {
  str: 'text-[#ff8a73]',
  agi: 'text-[#7fe08f]',
  int: 'text-[#8fc1ff]',
  uni: 'text-[#c9a6ff]',
};

export const ATTR_DOT: Record<HeroAttr, string> = {
  str: 'bg-[#d9553d]',
  agi: 'bg-[#4cbb62]',
  int: 'bg-[#4d8fe0]',
  uni: 'bg-[#9a6be0]',
};

const SIZE: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', string> = {
  xs: 'h-5 w-5 text-[10px] rounded',
  sm: 'h-7 w-7 text-xs rounded-md',
  md: 'h-9 w-9 text-sm rounded-md',
  lg: 'h-12 w-12 text-lg rounded-lg',
  xl: 'h-14 w-14 text-xl rounded-lg',
};

export function heroInfo(id: string): HeroInfo | undefined {
  return safe(() => heroById(id), undefined);
}

export function heroCn(id: string): string {
  return safe(() => heroName(id), id);
}

/** 适合位置（适配度 ≥ 0.6），用于提示 */
export function heroFitPositions(h: HeroInfo | undefined, min = 0.6): Position[] {
  if (!h) return [];
  return POSITIONS.filter((p) => (h.positions?.[p] ?? 0) >= min);
}

export function heroTooltip(id: string, meta?: number): string {
  const h = heroInfo(id);
  if (!h) return id;
  const fits = heroFitPositions(h).map((p) => `${POSITION_SHORT[p]}号位`).join('/');
  const parts = [`${h.cn}（${h.name}）`, ATTR_LABEL[h.attr] ?? '', fits ? `适合 ${fits}` : ''];
  if (meta !== undefined && Number.isFinite(meta)) parts.push(`版本强度 ${meta > 0 ? '+' : ''}${meta.toFixed(1)}`);
  return parts.filter(Boolean).join(' · ');
}

/** 首字头像：取中文名首字，背景色按主属性 */
export function HeroAvatar({
  heroId,
  size = 'md',
  banned,
  dim,
  className,
  title,
}: {
  heroId: string | null | undefined;
  size?: keyof typeof SIZE;
  banned?: boolean;
  dim?: boolean;
  className?: string;
  title?: string;
}) {
  const h = heroId ? heroInfo(heroId) : undefined;
  const cn = heroId ? h?.cn ?? heroCn(heroId) : '';
  const ch = cn ? Array.from(cn)[0] : '?';
  return (
    <span
      title={title ?? (heroId ? heroTooltip(heroId) : undefined)}
      className={cx(
        'relative inline-grid shrink-0 select-none place-items-center overflow-hidden font-black text-white shadow-inner ring-1 ring-black/40',
        SIZE[size],
        (banned || dim) && 'grayscale',
        dim && 'opacity-50',
        className,
      )}
      style={{ background: h ? ATTR_BG[h.attr] ?? UNKNOWN_BG : UNKNOWN_BG, textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
    >
      <span className={cx(banned && 'opacity-60')}>{ch}</span>
      {/* 高光 */}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/15 to-transparent" />
      {banned && (
        <span
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(to top right, transparent calc(50% - 1.5px), rgba(239,91,91,0.95) calc(50% - 1.5px), rgba(239,91,91,0.95) calc(50% + 1.5px), transparent calc(50% + 1.5px))',
          }}
        />
      )}
    </span>
  );
}

/** 版本强度小标签 */
export function MetaTag({ meta, className }: { meta: number | undefined; className?: string }) {
  if (meta === undefined || !Number.isFinite(meta)) return null;
  if (meta >= 1) return <span className={cx('rounded bg-gold/20 px-1 text-[10px] font-bold leading-4 text-gold', className)}>强势</span>;
  if (meta >= 0.4) return <span className={cx('rounded bg-good/15 px-1 text-[10px] leading-4 text-good', className)}>热门</span>;
  if (meta <= -1) return <span className={cx('rounded bg-panel-3 px-1 text-[10px] leading-4 text-faint', className)}>偏弱</span>;
  return null;
}

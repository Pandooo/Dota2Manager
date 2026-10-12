// ============================================================================
// 战队队徽（第十波 #4）
// - 默认：按「简称 + 品牌配色」生成的原创风格化队徽（src/ui/emblem.ts，确定性；换品牌后自动换新）。真实队标属于商标，不随仓库分发。
// - 本地覆盖：public/local/logos/{战队 id}.png|svg|webp（git 忽略，见 public/local/README.txt）存在时显示该图片；
//   文件列表在构建 / 开发服务器启动时枚举（src/ui/localArt.ts），没有文件时不发任何请求。
// - TeamTag（common.tsx）内置本组件；调用方未给出战队 id 时，只有在放了本地队标的情况下才按「简称 + 主色」在当前存档中反查战队 id。
// 另含 DotaPedia 战队页的「品牌沿革」信息行（TeamBrandHistoryRow）。只读，不修改游戏状态。
// ============================================================================
import { memo, useId, useState, type CSSProperties } from 'react';
import type { GameState, TeamBrandChange } from '../../engine/types';
import { brandColor2For, brandHistoryOf } from '../../engine/branding';
import { useGameStore } from '../../store/gameStore';
import { emblemSpec, type EmblemSpec } from '../emblem';
import { HAS_LOCAL_LOGOS, isLocalArtFailed, localLogoUrl, markLocalArtFailed } from '../localArt';

export interface TeamEmblemProps {
  tag: string;
  color: string;
  /** 战队 id（用于本地队标覆盖；缺省时按需从当前存档反查） */
  teamId?: string | null;
  /** 像素尺寸；缺省为 1.3em（随所在文字大小缩放） */
  size?: number;
  className?: string;
  /** 悬停提示（缺省无：队徽是装饰，旁边总有简称 / 队名） */
  title?: string;
}

// 规格缓存（同一简称 + 配色在一屏里常出现几十次）
const SPEC_CACHE = new Map<string, EmblemSpec>();
const SPEC_CACHE_MAX = 512;

export function teamEmblemSpec(tag: string, color: string): EmblemSpec {
  const key = `${tag}|${color}`;
  let spec = SPEC_CACHE.get(key);
  if (!spec) {
    spec = emblemSpec(tag, color, brandColor2For(tag, color));
    if (SPEC_CACHE.size >= SPEC_CACHE_MAX) SPEC_CACHE.clear();
    SPEC_CACHE.set(key, spec);
  }
  return spec;
}

export function TeamEmblem(props: TeamEmblemProps) {
  if (!props.teamId && HAS_LOCAL_LOGOS) return <TeamEmblemResolved {...props} />;
  return <TeamEmblemView {...props} />;
}

/** 未给出战队 id 且放了本地队标：按「简称 + 主色」在当前存档中反查（每个状态版本建一次索引） */
function TeamEmblemResolved(props: TeamEmblemProps) {
  const teamId = useGameStore((s) => teamIdByTagColor(s.game, s.version, props.tag, props.color));
  return <TeamEmblemView {...props} teamId={teamId} />;
}

let indexCache: { game: GameState | null; version: number; map: Map<string, string> } | null = null;

function teamIdByTagColor(game: GameState | null, version: number, tag: string, color: string): string | null {
  if (!game?.teams) return null;
  if (!indexCache || indexCache.game !== game || indexCache.version !== version) {
    const map = new Map<string, string>();
    // 未解散的战队优先（同简称同配色时）
    const teams = Object.values(game.teams).sort((a, b) => Number(!!a.disbanded) - Number(!!b.disbanded) || a.id.localeCompare(b.id));
    for (const t of teams) {
      const k = `${t.tag}|${String(t.color).toUpperCase()}`;
      if (!map.has(k)) map.set(k, t.id);
    }
    indexCache = { game, version, map };
  }
  return indexCache.map.get(`${tag}|${String(color).toUpperCase()}`) ?? null;
}

const TeamEmblemView = memo(function TeamEmblemView({ tag, color, teamId, size, className, title }: TeamEmblemProps) {
  const url = localLogoUrl(teamId, tag);
  const [bad, setBad] = useState(false);
  const box: CSSProperties = size ? { width: size, height: size } : { width: '1.3em', height: '1.3em' };
  if (url && !bad && !isLocalArtFailed(url)) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden={title ? undefined : true}
        title={title}
        draggable={false}
        decoding="async"
        className={['inline-block shrink-0 object-contain align-middle', className].filter(Boolean).join(' ')}
        style={box}
        onError={() => {
          markLocalArtFailed(url);
          setBad(true);
        }}
      />
    );
  }
  return <EmblemSvg spec={teamEmblemSpec(tag, color)} box={box} className={className} title={title} />;
});

function EmblemSvg({ spec, box, className, title }: { spec: EmblemSpec; box: CSSProperties; className?: string; title?: string }) {
  const clip = `te-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      viewBox="0 0 32 32"
      style={box}
      className={['inline-block shrink-0 align-middle', className].filter(Boolean).join(' ')}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <defs>
        <clipPath id={clip}>
          <path d={spec.outline} />
        </clipPath>
      </defs>
      <path d={spec.outline} fill={spec.fill} />
      {spec.motifPath && <path d={spec.motifPath} fill={spec.fill2} fillOpacity={0.9} clipPath={`url(#${clip})`} />}
      <path d={spec.outline} fill="none" stroke={spec.ring} strokeWidth={1.8} strokeLinejoin="round" />
      <text
        x="16"
        y={spec.textY}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={spec.fontSize}
        fontWeight={900}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill={spec.text}
        stroke={spec.text === '#FFFFFF' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.35)'}
        strokeWidth={1.1}
        paintOrder="stroke"
        letterSpacing={-0.3}
      >
        {spec.initials}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// DotaPedia：品牌沿革
// ---------------------------------------------------------------------------
/** 一条沿革的文字：「TI8 · LGD Gaming → PSG.LGD」/「TI10 · 启用新视觉（Na'Vi → NAVI）」 */
export function brandChangeText(c: TeamBrandChange): string {
  if (c.from.name !== c.to.name) return `TI${c.season} · ${c.from.name} → ${c.to.name}`;
  if (c.from.tag !== c.to.tag) return `TI${c.season} · 启用新视觉（${c.from.tag} → ${c.to.tag}）`;
  return `TI${c.season} · 启用新视觉`;
}

/**
 * 战队页信息框的「品牌沿革」行（本局中没有品牌变化时不渲染）。
 * 每条显示新品牌的队徽与变化说明，悬停可看事实说明。
 */
export function TeamBrandHistoryRow({ teamId, label = '品牌沿革' }: { teamId: string; label?: string }) {
  const game = useGameStore((s) => s.game);
  useGameStore((s) => s.version);
  const list = game ? brandHistoryOf(game, teamId) : [];
  if (!list.length) return null;
  // 与 PediaKit 的 InfoRow 同样的版式（不从 PediaKit 导入，避免 common ↔ PediaKit 的循环依赖）
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-2 border-b border-line/40 px-4 py-1.5 last:border-b-0">
      <dt className="text-mute">{label}</dt>
      <dd className="min-w-0 space-y-1 break-words text-ink">
        {list
          .slice()
          .reverse()
          .map((c, i) => (
            <div key={`${c.season}-${i}`} className="flex items-center gap-1.5" title={c.note}>
              <TeamEmblem tag={c.to.tag} color={c.to.color} teamId={teamId} />
              <span className="min-w-0">{brandChangeText(c)}</span>
            </div>
          ))}
      </dd>
    </div>
  );
}

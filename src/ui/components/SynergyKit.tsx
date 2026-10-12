// 羁绊（第十波 #5）的小组件：属性徽记、阵容页的激活羁绊条、战队词条的羁绊章节。
// 只读：数据来自 engine/synergy.ts 的纯查询（teamSynergies / synergyCatalog）；同步由引擎在阵容变化与每回合自动完成。
// 本文件在主包中（阵容页使用），羁绊图鉴整页在 PediaSynergies.tsx（百科分包）。
import type { ReactNode } from 'react';
import { useGameStore } from '../../store/gameStore';
import { SYNERGY_ATTR_LABEL, SYNERGY_KIND_LABEL, synergyCatalog, teamSynergies } from '../../engine';
import type { GameState, SynergyAttr, SynergyCatalogEntry, TeamSynergyView } from '../../engine';
import { PosBadge, cx } from './common';

/** 属性配色（与全站语义一致：灵性 info 蓝、韧性 good 绿、天赋紫、战斗力 dota 红、天梯 gold 金） */
export const SYNERGY_ATTR_COLOR: Record<SynergyAttr, string> = {
  insight: 'var(--color-info)',
  resilience: 'var(--color-good)',
  talent: 'var(--color-tier-s)',
  power: 'var(--color-dota-2)',
  mmr: 'var(--color-gold)',
};

const ATTR_GLYPH: Record<SynergyAttr, string> = { insight: '灵', resilience: '韧', talent: '赋', power: '战', mmr: '梯' };

/** 羁绊徽记：六边形 + 属性字（未解锁为「？」） */
export function SynergyEmblem({ attr, locked, size = 36, title }: { attr?: SynergyAttr; locked?: boolean; size?: number; title?: string }) {
  const color = locked || !attr ? 'var(--color-faint)' : SYNERGY_ATTR_COLOR[attr];
  const glyph = locked || !attr ? '？' : ATTR_GLYPH[attr];
  const label = title ?? (locked || !attr ? '未解锁的羁绊' : `${SYNERGY_ATTR_LABEL[attr]}羁绊`);
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className="shrink-0" role="img" aria-label={label}>
      <title>{label}</title>
      <polygon points="20,2 36,11 36,29 20,38 4,29 4,11" fill="var(--color-panel-2)" stroke={color} strokeWidth="2" />
      <polygon points="20,7 31.5,13.5 31.5,26.5 20,33 8.5,26.5 8.5,13.5" fill="none" stroke={color} strokeOpacity="0.35" strokeWidth="1" />
      <text x="20" y="25.5" textAnchor="middle" fontSize="14" fontWeight="700" fill={color} style={{ fontFamily: 'var(--font-sans)' }}>
        {glyph}
      </text>
    </svg>
  );
}

/** 「TI9 赛季初起」/「TI9 赛季第 5 回合起」 */
export function sinceText(ti: number, round: number): string {
  return round > 0 ? `TI${ti} 赛季第 ${round} 回合起` : `TI${ti} 赛季初起`;
}

/** 该战队当前是否有激活的羁绊 */
export function hasTeamSynergies(game: GameState, teamId: string | null | undefined): boolean {
  return teamSynergies(game, teamId).length > 0;
}

/** 打开 DotaPedia「羁绊图鉴」 */
export function openSynergyPedia(): void {
  useGameStore.getState().setView('pediaSynergies');
}

function memberTip(game: GameState, v: TeamSynergyView): string {
  const names = v.def.members.map((m) => game.players[m.id]?.handle ?? m.handle).join('、');
  const base = `${v.def.name}（${SYNERGY_KIND_LABEL[v.def.kind]}）\n成员：${names}\n`;
  return v.effective
    ? `${base}全队每名队员 ${v.bonusText}（永久，羁绊拆散即失效）`
    : `${base}已激活，但与本队更早的同属性羁绊不叠加（${v.bonusText} 只生效一个）`;
}

/** 单个激活羁绊的紧凑标签：徽记 + 名称 + 加成 */
export function SynergyPill({ game, view, onClick }: { game: GameState; view: TeamSynergyView; onClick?: () => void }) {
  const color = SYNERGY_ATTR_COLOR[view.def.attr];
  const body: ReactNode = (
    <>
      <SynergyEmblem attr={view.def.attr} size={20} title={`${SYNERGY_ATTR_LABEL[view.def.attr]}羁绊`} />
      <span className="truncate font-semibold text-ink">{view.def.name}</span>
      <span className={cx('shrink-0 tabular', !view.effective && 'line-through opacity-60')} style={{ color }}>
        {view.bonusText}
      </span>
      {!view.effective && <span className="shrink-0 text-[11px] text-faint">不叠加</span>}
    </>
  );
  const cls = 'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-panel-2/70 py-0.5 pl-1 pr-2 text-xs';
  const style = { borderColor: `color-mix(in srgb, ${color} 45%, transparent)` };
  return onClick ? (
    <button type="button" onClick={onClick} title={memberTip(game, view)} className={cx(cls, 'cursor-pointer hover:bg-panel-3')} style={style}>
      {body}
    </button>
  ) : (
    <span title={memberTip(game, view)} className={cls} style={style}>
      {body}
    </span>
  );
}

/**
 * 阵容页的激活羁绊条：没有激活的羁绊时，若本队已集齐某个已解锁羁绊的 4 名成员，给出「还差 1 人」的提示；否则不渲染。
 */
export function SquadSynergyStrip({ game, teamId }: { game: GameState; teamId: string }) {
  const views = teamSynergies(game, teamId);
  const near = views.length
    ? []
    : synergyCatalog(game, teamId).filter((e) => e.unlocked && e.available && !e.active && e.owned === e.def.members.length - 1);
  if (!views.length && !near.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gold/30 bg-gold/5 px-3 py-2">
      <span className="shrink-0 text-xs font-semibold tracking-wider text-gold">羁绊</span>
      {views.map((v) => (
        <SynergyPill key={v.def.id} game={game} view={v} onClick={openSynergyPedia} />
      ))}
      {near.map((e) => (
        <NearHint key={e.def.id} game={game} entry={e} teamId={teamId} />
      ))}
      <button type="button" onClick={openSynergyPedia} className="ml-auto shrink-0 cursor-pointer text-xs text-info/90 hover:text-gold hover:underline">
        羁绊图鉴 ›
      </button>
    </div>
  );
}

function NearHint({ game, entry, teamId }: { game: GameState; entry: SynergyCatalogEntry; teamId: string }) {
  // 与引擎的计数口径一致（synergy.isRegularMember）：赛事临时替补 / 野外替补不算本队成员
  const missing = entry.members.filter((m) => {
    const p = game.players[m.id];
    return !p || p.status !== 'active' || p.teamId !== teamId || !!p.tempSubUntilTournament || !!p.isWildSub;
  });
  const names = missing.map((m) => game.players[m.id]?.handle ?? m.handle).join('、');
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel-2/60 py-0.5 pl-1 pr-2 text-xs text-mute"
      title={`已解锁的羁绊「${entry.def.name}」：本队已有 ${entry.owned}/5 名成员，还差 ${names}（${entry.bonusText}）`}
    >
      <SynergyEmblem attr={entry.def.attr} size={20} />
      {entry.def.name} · 还差 <span className="text-ink">{names}</span>
    </span>
  );
}

/** 战队词条「羁绊」章节：当前激活的羁绊（成员与加成） */
export function TeamSynergyList({ game, teamId, renderPlayer }: {
  game: GameState;
  teamId: string;
  /** 选手链接（百科内用 PPlayer） */
  renderPlayer: (id: string, handle: string) => ReactNode;
}) {
  const views = teamSynergies(game, teamId);
  if (!views.length) return <div className="text-sm text-faint">当前没有激活的羁绊。</div>;
  return (
    <div className="space-y-3">
      {views.map((v) => (
        <div key={v.def.id} className="flex flex-wrap items-start gap-3">
          <SynergyEmblem attr={v.def.attr} size={34} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={openSynergyPedia} className="cursor-pointer font-semibold text-ink hover:text-gold hover:underline">
                {v.def.name}
              </button>
              <span className="text-[11px] text-mute">{SYNERGY_KIND_LABEL[v.def.kind]}</span>
              <span className={cx('text-xs tabular', !v.effective && 'line-through opacity-60')} style={{ color: SYNERGY_ATTR_COLOR[v.def.attr] }}>
                全队{v.bonusText}
              </span>
              {!v.effective && <span className="text-[11px] text-faint">（与更早的同属性羁绊不叠加）</span>}
              <span className="text-[11px] text-faint">{sinceText(v.ti, v.round)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
              {v.def.members.map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1">
                  <PosBadge pos={m.position} />
                  {renderPlayer(m.id, game.players[m.id]?.handle ?? m.handle)}
                </span>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

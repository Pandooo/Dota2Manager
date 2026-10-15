// ============================================================================
// 比赛页共用的小工具与小组件（Match* 前缀，仅比赛页使用）
// ============================================================================
import type { MouseEvent, ReactNode } from 'react';
import type { DraftState, GameRecord, GameState, Series, Team } from '../../engine/types';
import { CONFIG } from '../../engine';
import { cx } from './common';
import { showTouchTip } from './TouchTip';
import { isCoarsePointer } from '../mobile';

export type Side = 'A' | 'B';
export type Faction = 'radiant' | 'dire';

export const otherSide = (s: Side): Side => (s === 'A' ? 'B' : 'A');

/** 引擎函数可能尚未实现或抛错：统一兜底，绝不让页面崩溃 */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export const pct = (v: number, digits = 0) => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(digits)}%`;

export function fmtClock(minute: number, second = 0): string {
  const m = Math.max(0, Math.floor(minute));
  const s = Math.max(0, Math.min(59, Math.floor(second)));
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 比赛时长（分钟，可带小数）→ mm:ss */
export function fmtDuration(min: number): string {
  if (!Number.isFinite(min)) return '--:--';
  const total = Math.round(min * 60);
  return fmtClock(Math.floor(total / 60), total % 60);
}

export function fmtGoldK(v: number): string {
  const a = Math.abs(v);
  if (a < 1000) return `${Math.round(a)}`;
  return `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
}

export const FACTION_LABEL: Record<Faction, string> = { radiant: '天辉', dire: '夜魇' };
export const FACTION_TEXT: Record<Faction, string> = { radiant: 'text-radiant', dire: 'text-dire' };
export const FACTION_HEX: Record<Faction, string> = { radiant: '#63c24f', dire: '#d9473a' };

/**
 * 本局天辉方预测（与 engine/match.simulateGame 的约定一致：系列赛第 1/3/5 局 A 方为天辉）。
 * 仅用于 BP 阶段展示；对局生成后一律以 GameRecord.radiant 为准。
 */
export function predictedRadiant(gameIndex: number): Side {
  return (gameIndex ?? 0) % 2 === 0 ? 'A' : 'B';
}

export function factionOf(radiant: Side | undefined, side: Side): Faction | null {
  if (!radiant) return null;
  return radiant === side ? 'radiant' : 'dire';
}

/** 一局的胜者战队 id */
export function gameWinnerId(rec: GameRecord): string {
  return rec.winner === 'A' ? rec.teamA : rec.teamB;
}

/** 系列赛比分（以 seriesTeamA 为 A 方），按已记录的局数 */
export function seriesScore(games: GameRecord[] | undefined, seriesTeamA: string | null): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const g of games ?? []) {
    if (!g) continue;
    if (gameWinnerId(g) === seriesTeamA) a++;
    else b++;
  }
  return { a, b };
}

/** 系列赛是否已分出结果（Bo2 打满 2 局即结束） */
export function seriesDecided(bestOf: number, a: number, b: number): boolean {
  if (bestOf === 2) return a + b >= 2;
  const need = Math.ceil(bestOf / 2);
  return a >= need || b >= need;
}

/** 纸面实力占比（与引擎 strengthShare 同公式） */
export function strengthShare(rA: number, rB: number): number {
  const g = CONFIG.match.gamma;
  if (!(rA > 0) && !(rB > 0)) return 0.5;
  if (!(rA > 0)) return 0;
  if (!(rB > 0)) return 1;
  // 归一化防溢出
  const m = Math.max(rA, rB);
  const a = Math.pow(rA / m, g);
  const b = Math.pow(rB / m, g);
  return a / (a + b);
}

/**
 * BP 中 A/B（先手/后手）对应的战队。引擎约定 draft 的 A = 系列赛 teamA；
 * 若已有 pick 绑定了选手，则以选手所属战队校正（防止引擎按局交换先手）。
 */
export function draftTeams(game: GameState, draft: DraftState | null, series: Series): { A: string; B: string } {
  const sa = series.teamA ?? '';
  const sb = series.teamB ?? '';
  if (draft) {
    for (const act of draft.actions) {
      if (act.type !== 'pick' || !act.playerId) continue;
      const tid = game.players[act.playerId]?.teamId;
      if (!tid) continue;
      if ((act.side === 'A' && tid === sb) || (act.side === 'B' && tid === sa)) return { A: sb, B: sa };
      if ((act.side === 'A' && tid === sa) || (act.side === 'B' && tid === sb)) return { A: sa, B: sb };
    }
  }
  return { A: sa, B: sb };
}

export function teamOrStub(game: GameState, id: string | null | undefined): Team {
  const t = id ? game.teams[id] : undefined;
  if (t) return t;
  return {
    id: id ?? 'tbd',
    name: '待定',
    tag: 'TBD',
    region: 'EU',
    color: '#5b6579',
    honor: 0,
    gold: 0,
    isPlayer: false,
    playerIds: [],
    lineup: { C: null, M: null, O: null, SS: null, HS: null },
    coachId: null,
    points: 0,
  };
}

/** 小标签：我方 */
export function MineBadge({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center whitespace-nowrap rounded border border-gold/50 bg-gold/15 px-1.5 text-[10px] font-bold leading-4 text-gold', className)}>
      我方
    </span>
  );
}

export function FactionBadge({ faction, className }: { faction: Faction | null; className?: string }) {
  if (!faction) return null;
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded border px-1.5 text-[10px] font-bold leading-4',
        faction === 'radiant' ? 'border-radiant/50 bg-radiant/15 text-radiant' : 'border-dire/50 bg-dire/15 text-dire',
        className,
      )}
    >
      {FACTION_LABEL[faction]}
    </span>
  );
}

/**
 * 触屏点按显示说明（docs/UI.md「手机适配 · 触屏说明」）：桌面仍靠悬停 title；触屏没有悬停，点按时在元素旁显示同一段文字。
 * 用于只靠 title 说明的小标签 / 英雄头像（错位、状态 ▲▼、招牌英雄、禁用英雄等）。返回值直接展开到元素上。
 */
export function tapTip(text: string | undefined): { title?: string; onClick?: (e: MouseEvent<HTMLElement>) => void } {
  if (!text) return {};
  return {
    title: text,
    onClick: (e) => {
      if (!isCoarsePointer()) return;
      e.stopPropagation();
      showTouchTip(e.currentTarget, text);
    },
  };
}

/** 左右对比条（A 左 B 右） */
export function CompareRow({
  label,
  a,
  b,
  fmt = (v: number) => v.toFixed(0),
  colorA = 'bg-info',
  colorB = 'bg-dire',
  hint,
}: {
  label: ReactNode;
  a: number;
  b: number;
  fmt?: (v: number) => string;
  colorA?: string;
  colorB?: string;
  hint?: string;
}) {
  const total = Math.max(1e-9, Math.abs(a) + Math.abs(b));
  const wa = (Math.abs(a) / total) * 100;
  const aBetter = a > b;
  const bBetter = b > a;
  return (
    <div title={hint}>
      <div className="flex items-baseline justify-between text-xs">
        <span className={cx('tabular font-semibold', aBetter ? 'text-ink' : 'text-mute')}>{fmt(a)}</span>
        <span className="text-[11px] text-mute">{label}</span>
        <span className={cx('tabular font-semibold', bBetter ? 'text-ink' : 'text-mute')}>{fmt(b)}</span>
      </div>
      <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-panel-3">
        <div className={cx('h-full transition-all duration-500', colorA)} style={{ width: `${wa}%` }} />
        <div className="h-full w-0.5 bg-bg" />
        <div className={cx('h-full flex-1 transition-all duration-500', colorB)} />
      </div>
    </div>
  );
}

// 训练页 · 成长曲线：按选手的小多图（内联 SVG），数据来自 history.squadProgress（每回合结束快照），
// 虚线标出赛季分界；悬停显示该回合数值。
import { useRef, useState, type PointerEvent } from 'react';
import type { GameState, Player, SquadProgressPoint } from '../../engine';
import { POSITIONS, teamPlayers } from '../../engine';
import { Card, EmptyState, PlayerLink, PosBadge, cx } from './common';
import { safe } from './SquadShared';
import { recordWhen } from './TrainingShared';

type Metric = 'power' | 'mmr' | 'insight';
const METRICS: Metric[] = ['power', 'mmr', 'insight'];
const METRIC_INFO: Record<Metric, { label: string; digits: number; flatPad: number }> = {
  power: { label: '战斗力', digits: 1, flatPad: 1 },
  mmr: { label: '天梯', digits: 0, flatPad: 100 },
  insight: { label: '灵性', digits: 1, flatPad: 1 },
};

const fmt = (v: number, digits: number) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const signed = (v: number, digits: number) => (v > 0 ? '+' : '') + fmt(v, digits);

interface Entry {
  id: string;
  handle: string;
  player: Player | null;
  onTeam: boolean;
  points: SquadProgressPoint[];
}

export default function TrainingGrowth({ game }: { game: GameState }) {
  const [metric, setMetric] = useState<Metric>('power');
  const [showFormer, setShowFormer] = useState(false);
  const prog = game.history?.squadProgress ?? {};
  const me = game.settings.playerTeamId;
  const team = game.teams[me];

  // 现役：首发按位置，其后替补
  const roster = safe(() => teamPlayers(game, me), [] as Player[]).filter((p) => !p.isWildSub && !p.tempSubUntilTournament);
  const starters = POSITIONS.map((pos) => team?.lineup?.[pos]).filter(Boolean) as string[];
  const order = (p: Player) => {
    const i = starters.indexOf(p.id);
    return i >= 0 ? i : 10 + POSITIONS.indexOf(p.position);
  };
  const current: Entry[] = roster
    .slice()
    .sort((a, b) => order(a) - order(b))
    .map((p) => ({ id: p.id, handle: p.handle, player: p, onTeam: true, points: prog[p.id] ?? [] }));
  const currentIds = new Set(current.map((e) => e.id));
  // 已被清理出存档的退役选手：从训练记录里找回 ID（handle）
  const knownHandles = new Map<string, string>();
  for (const r of game.history?.training ?? []) for (const g of r?.gains ?? []) knownHandles.set(g.playerId, g.handle);
  const former: Entry[] = Object.keys(prog)
    .filter((id) => !currentIds.has(id) && Array.isArray(prog[id]) && prog[id].length > 0)
    .map((id) => {
      const p = game.players[id] ?? null;
      const pts = prog[id];
      return { id, handle: p?.handle ?? knownHandles.get(id) ?? id, player: p, onTeam: false, points: pts };
    })
    .sort((a, b) => {
      const la = a.points[a.points.length - 1];
      const lb = b.points[b.points.length - 1];
      return lb.season - la.season || lb.round - la.round;
    });
  const entries = showFormer ? [...current, ...former] : current;
  const hasData = entries.some((e) => e.points.length > 0);

  return (
    <Card
      title="成长曲线"
      subtitle="每回合结束时的选手基础属性快照（不含临时状态，各图纵轴独立）· 虚线为赛季分界 · 悬停查看数值"
      actions={
        <div className="flex items-center gap-2 text-xs">
          <div className="flex overflow-hidden rounded-md border border-line">
            {METRICS.map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={cx(
                  'cursor-pointer px-2.5 py-1 transition-colors',
                  metric === m ? 'bg-dota/20 text-ink' : 'bg-panel-2/50 text-mute hover:text-ink',
                )}
              >
                {METRIC_INFO[m].label}
              </button>
            ))}
          </div>
          {former.length > 0 && (
            <label className="flex cursor-pointer items-center gap-1 text-mute">
              <input type="checkbox" checked={showFormer} onChange={(e) => setShowFormer(e.target.checked)} className="accent-[#c23c2a]" />
              已离队（{former.length}）
            </label>
          )}
        </div>
      }
    >
      {!hasData ? (
        <EmptyState text="还没有成长快照：每个回合结束时自动记录一次，推进回合后即可看到曲线。" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map((e) => (
            <PlayerCurve key={e.id} game={game} entry={e} metric={metric} />
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 单名选手曲线
// ---------------------------------------------------------------------------
const W = 320;
const H = 132;
const PAD = { l: 36, r: 10, t: 16, b: 10 };

function PlayerCurve({ game, entry, metric }: { game: GameState; entry: Entry; metric: Metric }) {
  const info = METRIC_INFO[metric];
  const pts = entry.points;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const vals = pts.map((p) => p[metric]);
  const last = vals[vals.length - 1];
  const thisSeason = pts.filter((p) => p.season === game.season.ti);
  const seasonDelta = entry.onTeam && thisSeason.length > 0 ? last - thisSeason[0][metric] : NaN;
  const totalDelta = vals.length > 1 ? last - vals[0] : NaN;

  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo < 1e-6) {
    lo -= info.flatPad;
    hi += info.flatPad;
  } else {
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
  }
  const n = pts.length;
  const x = (i: number) => (n <= 1 ? (PAD.l + W - PAD.r) / 2 : PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  // 赛季分界：每个赛季第一个点
  const seasonStarts: { i: number; season: number }[] = [];
  pts.forEach((p, i) => {
    if (i === 0 || p.season !== pts[i - 1].season) seasonStarts.push({ i, season: p.season });
  });

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * W;
    const t = n <= 1 ? 0 : Math.round(((vx - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, t)));
  };

  const hp = hover !== null ? pts[hover] : null;
  const color = entry.onTeam ? 'var(--color-gold)' : 'var(--color-mute)';
  const grid = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];

  return (
    <div className={cx('rounded-lg border bg-panel-2/40 p-2.5', entry.onTeam ? 'border-line' : 'border-line/60 opacity-80')}>
      <div className="mb-1 flex items-center gap-1.5 text-sm">
        {entry.player ? <PosBadge pos={entry.player.position} /> : null}
        {entry.player ? <PlayerLink player={entry.player} /> : <span className="text-mute">{entry.handle}</span>}
        {!entry.onTeam && <span className="text-[10px] text-faint">已离队</span>}
        <span className="ml-auto text-right">
          <span className="font-semibold tabular text-ink">{n ? fmt(last, info.digits) : '—'}</span>
        </span>
      </div>
      <div className="mb-1 flex gap-3 text-[11px] text-faint">
        <span title="本赛季首个快照 → 最新（含训练、赛事、版本、事件等全部因素）">
          本赛季{' '}
          <span className={cx('tabular', seasonDelta > 0 ? 'text-good' : seasonDelta < 0 ? 'text-bad' : 'text-faint')}>
            {Number.isFinite(seasonDelta) ? signed(seasonDelta, info.digits) : '—'}
          </span>
        </span>
        <span title="最早快照 → 最新">
          累计{' '}
          <span className={cx('tabular', totalDelta > 0 ? 'text-good' : totalDelta < 0 ? 'text-bad' : 'text-faint')}>
            {Number.isFinite(totalDelta) ? signed(totalDelta, info.digits) : '—'}
          </span>
        </span>
        <span className="ml-auto">{n} 个回合</span>
      </div>
      {n === 0 ? (
        <div className="grid h-[100px] place-items-center rounded border border-dashed border-line text-xs text-faint">暂无快照（推进回合后生成）</div>
      ) : (
        <div className="relative">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full touch-none select-none"
            role="img"
            aria-label={`${entry.handle} ${info.label}成长曲线`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {grid.map((g, i) => (
              <g key={i}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--color-line)" strokeWidth={0.6} />
                <text x={PAD.l - 4} y={y(g) + 3} textAnchor="end" fontSize={8.5} fill="var(--color-faint)">
                  {fmt(g, metric === 'mmr' ? 0 : 1)}
                </text>
              </g>
            ))}
            {seasonStarts.map((s) => (
              <g key={`${s.season}-${s.i}`}>
                {s.i > 0 && (
                  <line
                    x1={(x(s.i) + x(s.i - 1)) / 2}
                    x2={(x(s.i) + x(s.i - 1)) / 2}
                    y1={PAD.t - 4}
                    y2={H - PAD.b}
                    stroke="var(--color-mute)"
                    strokeDasharray="3 3"
                    strokeWidth={0.8}
                  />
                )}
                <text
                  x={s.i > 0 ? (x(s.i) + x(s.i - 1)) / 2 + 3 : PAD.l + 1}
                  y={PAD.t - 6}
                  fontSize={8.5}
                  fill="var(--color-mute)"
                >
                  TI{s.season}
                </text>
              </g>
            ))}
            <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {n === 1 && <circle cx={x(0)} cy={y(vals[0])} r={3.5} fill={color} />}
            {n > 1 && hover === null && <circle cx={x(n - 1)} cy={y(last)} r={3.5} fill={color} stroke="var(--color-panel)" strokeWidth={1.5} />}
            {hp && hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.t - 4} y2={H - PAD.b} stroke="var(--color-ink)" strokeOpacity={0.35} strokeWidth={0.8} />
                <circle cx={x(hover)} cy={y(vals[hover])} r={4} fill={color} stroke="var(--color-panel)" strokeWidth={1.5} />
              </g>
            )}
          </svg>
          {hp && hover !== null && (
            <div
              className="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-md border border-line bg-panel/95 px-2 py-1 text-[11px] shadow-lg"
              style={x(hover) > W / 2 ? { right: `${((W - x(hover)) / W) * 100 + 2}%` } : { left: `${(x(hover) / W) * 100 + 2}%` }}
            >
              <div className="text-faint">{recordWhen(game, hp.season, hp.round)}</div>
              <div className="text-ink">
                {info.label} <b className="tabular">{fmt(vals[hover], info.digits)}</b>
                {hover > 0 && (
                  <span className={cx('ml-1.5 tabular', vals[hover] - vals[hover - 1] >= 0 ? 'text-good' : 'text-bad')}>
                    {signed(vals[hover] - vals[hover - 1], info.digits)}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

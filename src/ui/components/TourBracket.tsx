// ============================================================================
// 赛事中心：小组积分表 / 淘汰赛对阵图 / 系列赛方块
// ============================================================================
import { useState } from 'react';
import type { GameState, GroupStanding, Series, Stage, Tournament } from '../../engine/types';
import { CONFIG } from '../../engine';
import { Badge, cx } from './common';
import { teamInfo, TeamName } from './TourShared';

// ---------------------------------------------------------------------------
// 系列赛方块
// ---------------------------------------------------------------------------
export function SeriesBox({
  game,
  series,
  onOpen,
  nextSeriesId,
  header = 'label',
  className,
}: {
  game: GameState;
  series: Series;
  onOpen?: (s: Series) => void;
  nextSeriesId?: string | null;
  /** 方块顶部：label=系列赛名称+Bo；bo=仅 Bo；none=不显示 */
  header?: 'label' | 'bo' | 'none';
  className?: string;
}) {
  const me = game.settings.playerTeamId;
  const res = series.result;
  const pending = !res;
  const isNext = !!nextSeriesId && series.id === nextSeriesId;
  const mine = series.teamA === me || series.teamB === me;
  const clickable = !!res && !!onOpen;

  const row = (teamId: string | null, score: number | undefined, side: 'A' | 'B') => {
    const info = teamInfo(game, teamId);
    const won = !!res && res.winnerId === teamId && !!teamId;
    const lost = !!res && !!teamId && res.loserId === teamId;
    return (
      <div
        className={cx(
          'flex items-center gap-1.5 px-2 py-1 text-xs',
          side === 'A' && 'border-b border-line/60',
          info.isPlayer && 'bg-gold/10',
        )}
      >
        <span className="h-3.5 w-1 shrink-0 rounded-sm" style={{ background: teamId ? info.color : 'transparent' }} />
        <span
          className={cx(
            'min-w-0 flex-1 truncate',
            !teamId && 'italic text-faint',
            won && 'font-bold text-ink',
            lost && 'text-faint',
            !res && teamId && 'text-ink',
            info.isPlayer && 'text-gold',
          )}
          title={teamId ? info.name : '等待上一场结果'}
        >
          {teamId ? info.tag : '待定'}
        </span>
        <span className={cx('w-4 shrink-0 text-right tabular', won ? 'font-bold text-ink' : 'text-mute')}>
          {score ?? (pending ? '–' : 0)}
        </span>
      </div>
    );
  };

  return (
    <div
      onClick={clickable ? () => onOpen?.(series) : undefined}
      title={clickable ? '点击查看对局详情' : pending ? (series.teamA && series.teamB ? '未开赛' : '等待对手确定') : undefined}
      className={cx(
        'w-44 shrink-0 overflow-hidden rounded-md border bg-panel-2 transition-colors',
        clickable && 'cursor-pointer hover:border-mute',
        isNext ? 'glow border-gold/70' : mine ? 'border-gold/40' : 'border-line',
        pending && !isNext && 'opacity-60',
        className,
      )}
    >
      {header !== 'none' && (
        <div className="flex items-center justify-between gap-1 bg-panel-3/50 px-2 py-0.5 text-[10px] text-faint">
          <span className="truncate" title={series.label}>
            {header === 'label' ? series.label : `Bo${series.bestOf}`}
          </span>
          <span className="shrink-0">
            {isNext ? <span className="font-semibold text-gold">下一场</span> : header === 'label' ? `Bo${series.bestOf}` : ''}
          </span>
        </div>
      )}
      {row(series.teamA, res?.scoreA, 'A')}
      {row(series.teamB, res?.scoreB, 'B')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 淘汰赛对阵图
// ---------------------------------------------------------------------------
type Section = 'upper' | 'lower' | 'final';

function sectionOf(s: Series): Section {
  const l = s.label || '';
  if (/败者|lower|LB/i.test(l)) return 'lower';
  if (/总决赛|grand/i.test(l)) return 'final';
  if (/季军|三四名|3rd/i.test(l)) return 'final';
  return 'upper';
}

function stripNumbering(label: string): string {
  let s = (label || '').trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s
      .replace(/\s*[#＃]\s*\d+$/, '')
      .replace(/\s*第\s*\d+\s*场$/, '')
      .replace(/\s*[（(]\s*\d+\s*[)）]$/, '')
      .trim();
    if (s === before) break;
  }
  return s;
}

interface Column {
  title: string;
  series: Series[];
}

/** 淘汰赛列：按系列赛名称（如「胜者组半决赛」）分列，列顺序取该列最小轮次 */
function bracketColumns(list: Series[]): Column[] {
  const map = new Map<string, { series: Series[]; minRound: number; order: number }>();
  list.forEach((s, i) => {
    const key = stripNumbering(s.label) || `第${s.round}轮`;
    const r = Number.isFinite(s.round) ? s.round : 0;
    const cur = map.get(key);
    if (cur) {
      cur.series.push(s);
      cur.minRound = Math.min(cur.minRound, r);
    } else {
      map.set(key, { series: [s], minRound: r, order: i });
    }
  });
  return Array.from(map.entries())
    .sort((a, b) => a[1].minRound - b[1].minRound || a[1].order - b[1].order)
    .map(([title, v]) => ({ title, series: v.series }));
}

/** 小组赛轮次分组 */
function groupByRound(list: Series[]): Series[][] {
  const map = new Map<number, Series[]>();
  for (const s of list) {
    const r = Number.isFinite(s.round) ? s.round : 0;
    if (!map.has(r)) map.set(r, []);
    map.get(r)!.push(s);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

function BracketSection({
  game,
  title,
  titleClass,
  columns,
  onOpen,
  nextSeriesId,
}: {
  game: GameState;
  title?: string;
  titleClass?: string;
  columns: Column[];
  onOpen: (s: Series) => void;
  nextSeriesId?: string | null;
}) {
  if (columns.length === 0) return null;
  return (
    <div>
      {title && <div className={cx('mb-2 text-xs font-semibold tracking-wider', titleClass ?? 'text-mute')}>{title}</div>}
      <div className="flex items-stretch gap-6 overflow-x-auto pb-2">
        {columns.map((col) => (
          <div key={col.title} className="flex shrink-0 flex-col">
            <div className="mb-1.5 w-44 truncate text-center text-[11px] text-faint" title={col.title}>
              {col.title}
            </div>
            <div className="flex flex-1 flex-col justify-around gap-3">
              {col.series.map((s) => (
                <SeriesBox key={s.id} game={game} series={s} onOpen={onOpen} nextSeriesId={nextSeriesId} header="bo" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BracketView({
  game,
  stage,
  seriesList,
  onOpen,
  nextSeriesId,
}: {
  game: GameState;
  stage: Stage;
  seriesList: Series[];
  onOpen: (s: Series) => void;
  nextSeriesId?: string | null;
}) {
  if (seriesList.length === 0) {
    return <div className="py-8 text-center text-sm text-mute">该阶段对阵尚未生成（等待上一阶段结束）</div>;
  }
  const upper = seriesList.filter((s) => sectionOf(s) === 'upper');
  const lower = seriesList.filter((s) => sectionOf(s) === 'lower');
  const final = seriesList.filter((s) => sectionOf(s) === 'final');
  const isDe = stage.format === 'de' || lower.length > 0;
  return (
    <div className="space-y-5">
      <BracketSection
        game={game}
        title={isDe ? '胜者组' : undefined}
        titleClass="text-good"
        columns={bracketColumns(upper)}
        onOpen={onOpen}
        nextSeriesId={nextSeriesId}
      />
      {lower.length > 0 && (
        <BracketSection game={game} title="败者组" titleClass="text-dota-2" columns={bracketColumns(lower)} onOpen={onOpen} nextSeriesId={nextSeriesId} />
      )}
      {final.length > 0 && (
        <BracketSection game={game} title="决赛" titleClass="text-gold" columns={bracketColumns(final)} onOpen={onOpen} nextSeriesId={nextSeriesId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 小组赛
// ---------------------------------------------------------------------------
function emptyStanding(teamId: string): GroupStanding {
  return { teamId, wins: 0, draws: 0, losses: 0, gameWins: 0, gameLosses: 0 };
}

/** 由系列赛结果现算积分（引擎未提供 standings 时兜底） */
export function computeStandings(teamIds: string[], seriesList: Series[]): GroupStanding[] {
  const map = new Map<string, GroupStanding>();
  for (const id of teamIds) map.set(id, emptyStanding(id));
  for (const s of seriesList) {
    const r = s.result;
    if (!r || !s.teamA || !s.teamB) continue;
    const a = map.get(s.teamA) ?? emptyStanding(s.teamA);
    const b = map.get(s.teamB) ?? emptyStanding(s.teamB);
    map.set(a.teamId, a);
    map.set(b.teamId, b);
    a.gameWins += r.scoreA;
    a.gameLosses += r.scoreB;
    b.gameWins += r.scoreB;
    b.gameLosses += r.scoreA;
    if (r.scoreA === r.scoreB) {
      a.draws++;
      b.draws++;
    } else if (r.winnerId === s.teamA) {
      a.wins++;
      b.losses++;
    } else {
      b.wins++;
      a.losses++;
    }
  }
  return Array.from(map.values());
}

const PTS_WIN = CONFIG.tournament.groupPointsWin ?? 2;
const PTS_DRAW = CONFIG.tournament.groupPointsDraw ?? 1;
const groupPoints = (r: GroupStanding) => r.wins * PTS_WIN + r.draws * PTS_DRAW;

/** 与引擎展示排序一致：积分 → 小局净胜 → 小局胜 */
function sortStandings(rows: GroupStanding[]): GroupStanding[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort(
      (x, y) =>
        groupPoints(y.r) - groupPoints(x.r) ||
        y.r.gameWins - y.r.gameLosses - (x.r.gameWins - x.r.gameLosses) ||
        y.r.gameWins - x.r.gameWins ||
        x.i - y.i,
    )
    .map((x) => x.r);
}

type Mark = 'upper' | 'lower' | 'advance' | 'out' | null;

const MARK_CLASS: Record<Exclude<Mark, null>, string> = {
  upper: 'bg-gold',
  lower: 'bg-info',
  advance: 'bg-good',
  out: 'bg-bad/60',
};
const MARK_LABEL: Record<Exclude<Mark, null>, string> = {
  upper: '晋级胜者组',
  lower: '进入败者组',
  advance: '晋级',
  out: '淘汰',
};

/** 小组出线规则：TI 赛制每组前半进胜者组、后半进败者组；其他赛制前 advanceCount 名晋级 */
function groupRule(t: Tournament, stage: Stage): { adv: number; upper: number } {
  const adv = Math.max(0, stage.advanceCount ?? 0);
  const isTi = t.format === 'ti' && stage.type === 'groups';
  const upper = isTi && adv >= 2 && adv % 2 === 0 ? adv / 2 : adv;
  return { adv, upper };
}

function GroupCard({
  game,
  t,
  stage,
  name,
  teamIds,
  standings,
  engineOrdered,
  seriesList,
  onOpen,
  nextSeriesId,
}: {
  game: GameState;
  t: Tournament;
  stage: Stage;
  name: string;
  teamIds: string[];
  standings: GroupStanding[];
  /** standings 来自引擎（已排序，保持其顺序以与出线结果一致） */
  engineOrdered: boolean;
  seriesList: Series[];
  onOpen: (s: Series) => void;
  nextSeriesId?: string | null;
}) {
  const me = game.settings.playerTeamId;
  // 默认收起（小组赛场次很多）；玩家的下一场已在赛事中心顶部单独展示
  const [showMatches, setShowMatches] = useState(false);
  // standings 可能缺队伍：补齐
  const have = new Set(standings.map((s) => s.teamId));
  const full = standings.concat(teamIds.filter((id) => !have.has(id)).map(emptyStanding));
  const rows = engineOrdered ? full : sortStandings(full);
  const played = seriesList.filter((s) => s.result).length;
  const advanced = stage.done && stage.advancedTeamIds ? new Set(stage.advancedTeamIds) : null;
  const { adv, upper } = groupRule(t, stage);

  const markOf = (pos: number, teamId: string): Mark => {
    let m: Mark = null;
    if (adv > 0) m = pos < upper ? (upper < adv ? 'upper' : 'advance') : pos < adv ? 'lower' : 'out';
    if (advanced && adv > 0) {
      if (!advanced.has(teamId)) m = 'out';
      else if (m === 'out' || m === null) m = 'advance';
    }
    return m;
  };

  const rounds = groupByRound(seriesList);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel-2/40">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="text-sm font-semibold">{/组$|联赛|小组/.test(name) ? name : `${name} 组`}</div>
        <div className="text-[11px] text-faint">
          已赛 {played}/{seriesList.length}
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th className="w-8">#</th>
            <th>战队</th>
            <th className="num" title="系列赛 胜-平-负">胜-平-负</th>
            <th className="num" title="小局 胜-负">小局</th>
            <th className="num" title="小局净胜">净胜</th>
            <th className="num" title={`积分：胜 ${PTS_WIN} / 平 ${PTS_DRAW}`}>积分</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const m = markOf(i, r.teamId);
            const isMe = r.teamId === me;
            const diff = r.gameWins - r.gameLosses;
            return (
              <tr key={r.teamId} className={cx(isMe && 'bg-gold/10', m === 'out' && stage.done && 'opacity-60')}>
                <td className="relative">
                  {m && <span className={cx('absolute bottom-1 left-0 top-1 w-1 rounded-r', MARK_CLASS[m])} title={MARK_LABEL[m]} />}
                  <span className="tabular text-mute">{i + 1}</span>
                </td>
                <td className="max-w-44">
                  <TeamName game={game} teamId={r.teamId} mode="name" />
                </td>
                <td className="num">
                  {r.wins}-{r.draws}-{r.losses}
                </td>
                <td className="num text-mute">
                  {r.gameWins}-{r.gameLosses}
                </td>
                <td className={cx('num', diff > 0 ? 'text-good' : diff < 0 ? 'text-bad' : 'text-faint')}>
                  {diff > 0 ? '+' : ''}
                  {diff}
                </td>
                <td className="num font-semibold">{groupPoints(r)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {seriesList.length > 0 && (
        <div className="border-t border-line">
          <button
            className="w-full cursor-pointer px-3 py-1.5 text-left text-xs text-mute hover:text-ink"
            onClick={() => setShowMatches((v) => !v)}
          >
            {showMatches ? '▾ 收起比赛' : `▸ 查看比赛（${seriesList.length} 场）`}
          </button>
          {showMatches && (
            <div className="space-y-2 px-3 pb-3">
              {rounds.map((col, k) => (
                <div key={k}>
                  <div className="mb-1 text-[10px] text-faint">第 {k + 1} 轮</div>
                  <div className="flex flex-wrap gap-2">
                    {col.map((s) => (
                      <SeriesBox key={s.id} game={game} series={s} onOpen={onOpen} nextSeriesId={nextSeriesId} header="none" className="w-36" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function GroupsView({
  game,
  t,
  stage,
  seriesList,
  onOpen,
  nextSeriesId,
}: {
  game: GameState;
  t: Tournament;
  stage: Stage;
  seriesList: Series[];
  onOpen: (s: Series) => void;
  nextSeriesId?: string | null;
}) {
  const groups =
    stage.groups && stage.groups.length > 0
      ? stage.groups.map((g) => {
          const ids = new Set(g.teamIds);
          const gs = seriesList.filter(
            (s) => (s.teamA || s.teamB) && (s.teamA ? ids.has(s.teamA) : true) && (s.teamB ? ids.has(s.teamB) : true),
          );
          const fromEngine = !!g.standings && g.standings.length > 0;
          const st = fromEngine ? g.standings : computeStandings(g.teamIds, gs);
          return { name: g.name, teamIds: g.teamIds, standings: st, series: gs, engineOrdered: fromEngine };
        })
      : [
          {
            name: stage.name,
            teamIds: stage.teamIds,
            standings: computeStandings(stage.teamIds, seriesList),
            series: seriesList,
            engineOrdered: false,
          },
        ];

  if (groups.every((g) => g.teamIds.length === 0)) {
    return <div className="py-8 text-center text-sm text-mute">分组尚未确定（等待上一阶段结束）</div>;
  }

  const { adv, upper } = groupRule(t, stage);
  return (
    <div className="space-y-3">
      <div className={cx('grid gap-3', groups.length > 1 && 'xl:grid-cols-2')}>
        {groups.map((g) => (
          <GroupCard
            key={g.name}
            game={game}
            t={t}
            stage={stage}
            name={g.name}
            teamIds={g.teamIds}
            standings={g.standings}
            engineOrdered={g.engineOrdered}
            seriesList={g.series}
            onOpen={onOpen}
            nextSeriesId={nextSeriesId}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-mute">
        {adv > 0 && upper < adv ? (
          <>
            <Legend cls={MARK_CLASS.upper} text={`前 ${upper} 名 → 胜者组`} />
            <Legend cls={MARK_CLASS.lower} text={`${upper + 1}-${adv} 名 → 败者组`} />
            <Legend cls={MARK_CLASS.out} text="淘汰" />
          </>
        ) : adv > 0 ? (
          <>
            <Legend cls={MARK_CLASS.advance} text={`${groups.length > 1 ? '每组' : ''}前 ${adv} 名晋级`} />
            <Legend cls={MARK_CLASS.out} text="淘汰" />
          </>
        ) : (
          <span>循环赛积分即最终排名</span>
        )}
        <span className="text-faint">
          排序：积分（胜 {PTS_WIN} / 平 {PTS_DRAW}）→ 小局净胜 → 相互战绩
        </span>
        {stage.done && <Badge className="bg-panel-3 text-faint">本阶段已结束</Badge>}
      </div>
    </div>
  );
}

function Legend({ cls, text }: { cls: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx('inline-block h-3 w-1 rounded', cls)} />
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 阶段视图（自动选择小组/对阵图）
// ---------------------------------------------------------------------------
export function StageView({
  game,
  t,
  stage,
  onOpen,
  nextSeriesId,
}: {
  game: GameState;
  t: Tournament;
  stage: Stage;
  onOpen: (s: Series) => void;
  nextSeriesId?: string | null;
}) {
  const seriesList = (stage.seriesIds ?? []).map((id) => t.series?.[id]).filter((s): s is Series => !!s);
  if (stage.type === 'groups') {
    return <GroupsView game={game} t={t} stage={stage} seriesList={seriesList} onOpen={onOpen} nextSeriesId={nextSeriesId} />;
  }
  return <BracketView game={game} stage={stage} seriesList={seriesList} onOpen={onOpen} nextSeriesId={nextSeriesId} />;
}

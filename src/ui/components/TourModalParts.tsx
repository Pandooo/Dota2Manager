// ============================================================================
// 总览赛事卡片（TournamentCard）的展示部件：当前阶段的本方状态（小组积分 / 淘汰赛位置）与本赛事战绩。
// 完整的分组表与对阵图仍在赛事中心（TourBracket），这里只放与本方相关的精简信息。
// ============================================================================
import type { GameState, GroupStanding, Series, Stage, Tournament } from '../../engine/types';
import { CONFIG, formatRank } from '../../engine';
import { Badge, cx } from './common';
import { computeStandings } from './TourBracket';
import { TeamName, rankClass } from './TourShared';
import { mySeriesResults } from './TourModalLogic';

const STAGE_FORMAT_LABEL: Record<Stage['format'], string> = { se: '单败淘汰', de: '双败淘汰', rr: '循环赛' };

/** 本方当前所在阶段：下一场 / 进行中比赛所在阶段 > 本方所在的未结束阶段 > 本方参加过的最后一个阶段 */
export function myStageOf(t: Tournament, me: string, focus: Series | null | undefined): Stage | null {
  const stages = t.stages ?? [];
  if (focus) {
    const st = stages.find((x) => x.id === focus.stageId);
    if (st) return st;
  }
  const mine = stages.filter(
    (st) =>
      (st.teamIds ?? []).includes(me) ||
      (st.seriesIds ?? []).some((id) => {
        const s = t.series?.[id];
        return !!s && (s.teamA === me || s.teamB === me);
      }),
  );
  return mine.find((st) => !st.done) ?? mine[mine.length - 1] ?? null;
}

/** 阶段说明：「小组赛 · 循环赛」「淘汰赛 · 双败淘汰」「封闭预选 · 单败淘汰」 */
export function stageText(stage: Stage): string {
  const kind = stage.type === 'groups' ? '' : STAGE_FORMAT_LABEL[stage.format] ?? '';
  const pre = stage.type === 'qualifier' && !/预选/.test(stage.name) ? '封闭预选 · ' : '';
  return `${pre}${stage.name}${kind && !stage.name.includes(kind) ? ` · ${kind}` : ''}`;
}

type Side = 'upper' | 'lower' | 'final';

/** 系列赛在对阵图中的位置（与赛事中心对阵图的分区规则一致） */
export function bracketSide(label: string): Side {
  const l = label || '';
  if (/败者|lower|LB/i.test(l)) return 'lower';
  if (/总决赛|grand|季军|三四名|3rd/i.test(l)) return 'final';
  return 'upper';
}

const SIDE_LABEL: Record<Side, string> = { upper: '胜者组', lower: '败者组', final: '决赛' };

/** 淘汰赛中本场的胜负后果（小组赛 / 循环赛为空） */
export function seriesStakes(s: Series, stage: Stage | null): string {
  if (!stage || stage.type === 'groups' || stage.format === 'rr') return '';
  const lp = s.loserPlacement;
  if (lp && lp[0] === 2 && lp[1] === 2) return '冠军之战：胜者夺冠，负者获得亚军';
  if (s.loserTo) return '失利将掉入败者组，仍有机会';
  if (lp) return `失利即淘汰（获得${formatRank(lp[0], lp[1])}）`;
  if (stage.format === 'se' || bracketSide(s.label) === 'lower') return '失利即淘汰';
  return '';
}

function myScoreOf(s: Series, me: string): { my: number; opp: number; oppId: string | null } {
  const r = s.result;
  const mineA = s.teamA === me;
  return {
    my: r ? (mineA ? r.scoreA : r.scoreB) : 0,
    opp: r ? (mineA ? r.scoreB : r.scoreA) : 0,
    oppId: mineA ? s.teamB : s.teamA,
  };
}

function outcomeOf(s: Series, me: string): 'win' | 'lose' | 'draw' {
  const { my, opp } = myScoreOf(s, me);
  if (my === opp) return 'draw';
  return s.result?.winnerId === me ? 'win' : 'lose';
}

const OUTCOME_CHIP: Record<'win' | 'lose' | 'draw', { text: string; cls: string }> = {
  win: { text: '胜', cls: 'bg-good/15 text-good border border-good/40' },
  lose: { text: '负', cls: 'bg-bad/15 text-bad border border-bad/40' },
  draw: { text: '平', cls: 'bg-info/15 text-info border border-info/40' },
};

// ---------------------------------------------------------------------------
// 小组赛：本方所在小组的精简积分表
// ---------------------------------------------------------------------------
const PTS_WIN = CONFIG.tournament.groupPointsWin ?? 2;
const PTS_DRAW = CONFIG.tournament.groupPointsDraw ?? 1;
const pointsOf = (r: GroupStanding) => r.wins * PTS_WIN + r.draws * PTS_DRAW;

type Zone = 'upper' | 'lower' | 'advance' | 'out' | null;
const ZONE_BAR: Record<Exclude<Zone, null>, string> = { upper: 'bg-gold', lower: 'bg-info', advance: 'bg-good', out: 'bg-bad/60' };
const ZONE_TEXT: Record<Exclude<Zone, null>, string> = { upper: '胜者组出线区', lower: '败者组出线区', advance: '出线区', out: '淘汰区' };

function GroupStatus({ game, t, stage, me }: { game: GameState; t: Tournament; stage: Stage; me: string }) {
  const groups = stage.groups?.length ? stage.groups : [{ name: stage.name, teamIds: stage.teamIds ?? [], standings: [] as GroupStanding[] }];
  const g = groups.find((x) => x.teamIds.includes(me));
  if (!g) return <div className="text-xs text-faint">分组尚未确定。</div>;
  const ids = new Set(g.teamIds);
  const list = (stage.seriesIds ?? [])
    .map((id) => t.series?.[id])
    .filter((s): s is Series => !!s && !!s.teamA && !!s.teamB && ids.has(s.teamA) && ids.has(s.teamB));
  // 引擎积分表已按出线顺序排好；缺失时由赛果现算（积分 → 小局净胜 → 小局胜）
  let rows: GroupStanding[];
  if (g.standings?.length) {
    const have = new Set(g.standings.map((r) => r.teamId));
    rows = g.standings.concat(
      g.teamIds.filter((id) => !have.has(id)).map((teamId) => ({ teamId, wins: 0, draws: 0, losses: 0, gameWins: 0, gameLosses: 0 })),
    );
  } else {
    rows = computeStandings(g.teamIds, list)
      .map((r, i) => ({ r, i }))
      .sort(
        (a, b) =>
          pointsOf(b.r) - pointsOf(a.r) ||
          b.r.gameWins - b.r.gameLosses - (a.r.gameWins - a.r.gameLosses) ||
          b.r.gameWins - a.r.gameWins ||
          a.i - b.i,
      )
      .map((x) => x.r);
  }
  const adv = Math.max(0, stage.advanceCount ?? 0);
  // 与赛事中心分组表（TourBracket.groupRule）一致：TI 赛制的小组赛每组前半进胜者组、后半进败者组
  const upper = t.format === 'ti' && stage.type === 'groups' && adv >= 2 && adv % 2 === 0 ? adv / 2 : adv;
  const advanced = stage.done && stage.advancedTeamIds ? new Set(stage.advancedTeamIds) : null;
  const zoneOf = (pos: number, teamId: string): Zone => {
    if (adv <= 0) return null;
    let z: Zone = pos < upper ? (upper < adv ? 'upper' : 'advance') : pos < adv ? 'lower' : 'out';
    if (advanced) {
      if (!advanced.has(teamId)) z = 'out';
      else if (z === 'out') z = 'advance';
    }
    return z;
  };
  const myPos = rows.findIndex((r) => r.teamId === me);
  const myRow = myPos >= 0 ? rows[myPos] : null;
  // 本方尚未出赛时名次只是初始顺序，不提示出线区 / 淘汰区
  const myZone = myRow && (stage.done || myRow.wins + myRow.draws + myRow.losses > 0) ? zoneOf(myPos, me) : null;
  const played = list.filter((s) => s.result).length;
  const groupName = /组$|联赛|小组/.test(g.name) ? g.name : `${g.name} 组`;

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="text-mute">
          {groupName}
          {myPos >= 0 && (
            <>
              {' '}· 你{stage.done ? '最终' : '暂列'}第 <b className="tabular text-ink">{myPos + 1}</b> 名
              {myZone && <span className={cx('ml-1', myZone === 'out' ? 'text-bad' : myZone === 'lower' ? 'text-info' : 'text-good')}>（{ZONE_TEXT[myZone]}）</span>}
            </>
          )}
        </span>
        <span className="text-[11px] text-faint">
          已赛 {played}/{list.length}
          {adv > 0 ? (upper < adv ? ` · 前 ${upper} 名进胜者组，${upper + 1}-${adv} 名进败者组` : ` · 前 ${adv} 名出线`) : ''}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto rounded-md border border-line">
        <table className="tbl text-xs">
          <thead>
            <tr>
              <th className="w-7">#</th>
              <th>战队</th>
              <th className="num" title="系列赛 胜-平-负">胜-平-负</th>
              <th className="num" title="小局 胜-负">小局</th>
              <th className="num" title={`积分：胜 ${PTS_WIN} / 平 ${PTS_DRAW}`}>积分</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const z = zoneOf(i, r.teamId);
              return (
                <tr key={r.teamId} className={cx(r.teamId === me && 'bg-gold/10')}>
                  <td className="relative">
                    {z && <span className={cx('absolute bottom-1 left-0 top-1 w-1 rounded-r', ZONE_BAR[z])} title={ZONE_TEXT[z]} />}
                    <span className="tabular text-mute">{i + 1}</span>
                  </td>
                  <td className="max-w-40">
                    <TeamName game={game} teamId={r.teamId} />
                  </td>
                  <td className="num">
                    {r.wins}-{r.draws}-{r.losses}
                  </td>
                  <td className="num text-mute">
                    {r.gameWins}-{r.gameLosses}
                  </td>
                  <td className="num font-semibold">{pointsOf(r)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 淘汰赛 / 预选：本方在本阶段的晋级路线与下一场的胜负后果
// ---------------------------------------------------------------------------
function BracketStatus({
  game, t, stage, me, next, eliminated,
}: { game: GameState; t: Tournament; stage: Stage; me: string; next: Series | null; eliminated: boolean }) {
  const mine = (stage.seriesIds ?? [])
    .map((id) => t.series?.[id])
    .filter((s): s is Series => !!s && (s.teamA === me || s.teamB === me) && (!!s.result || s.id === next?.id))
    .sort((a, b) => a.round - b.round);
  // 淘汰本方的那场（掉入败者组的失利不算）
  const knockout = mine.filter((s) => s.result && outcomeOf(s, me) === 'lose' && !s.loserTo).pop();
  const placement = t.placements?.find((p) => p.teamId === me);
  const stakes = next ? seriesStakes(next, stage) : '';

  return (
    <div className="space-y-1.5 text-xs">
      <div className="text-mute">
        {next ? (
          <>
            {stage.format === 'de' ? (
              <>
                当前位于 <b className={cx(bracketSide(next.label) === 'lower' ? 'text-info' : 'text-gold')}>{SIDE_LABEL[bracketSide(next.label)]}</b>
              </>
            ) : (
              <>
                本轮 <b className="text-gold">{next.label}</b>
              </>
            )}
            {stakes && <span className="ml-1">· {stakes}</span>}
          </>
        ) : placement ? (
          <span>
            最终名次 <b className={rankClass(placement.rankFrom)}>{formatRank(placement.rankFrom, placement.rankTo)}</b>
            {knockout && placement.rankFrom > 2 && <span className="ml-1 text-faint">（止步「{knockout.label}」）</span>}
          </span>
        ) : eliminated && knockout ? (
          <span className="text-bad">已在「{knockout.label}」被淘汰</span>
        ) : stage.done ? (
          <span>本阶段已结束</span>
        ) : (
          <span>等待下一轮对阵确定</span>
        )}
      </div>
      {mine.length === 0 ? (
        <div className="text-faint">本阶段尚未出赛。</div>
      ) : (
        <div className="divide-y divide-line/60 rounded-md border border-line">
          {mine.map((s) => {
            const { my, opp, oppId } = myScoreOf(s, me);
            const res = s.result ? outcomeOf(s, me) : null;
            return (
              <div key={s.id} className={cx('flex items-center gap-2 px-2.5 py-1.5', s.id === next?.id && 'bg-gold/10')}>
                <span className="w-28 shrink-0 truncate text-faint" title={s.label}>
                  {s.label}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-faint">vs </span>
                  <TeamName game={game} teamId={oppId} />
                </span>
                {res ? (
                  <>
                    <span className="tabular font-semibold">
                      {my}:{opp}
                    </span>
                    <Badge className={OUTCOME_CHIP[res].cls}>{OUTCOME_CHIP[res].text}</Badge>
                  </>
                ) : (
                  <Badge className="bg-gold/15 text-gold border border-gold/40">下一场 · Bo{s.bestOf}</Badge>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 当前阶段的本方状态（小组积分表或淘汰赛路线） */
export function StageStatus({
  game, t, stage, me, next, eliminated,
}: { game: GameState; t: Tournament; stage: Stage | null; me: string; next: Series | null; eliminated: boolean }) {
  if (!stage) return <div className="text-xs text-faint">赛事阶段尚未生成。</div>;
  return stage.type === 'groups' || stage.format === 'rr' ? (
    <GroupStatus game={game} t={t} stage={stage} me={me} />
  ) : (
    <BracketStatus game={game} t={t} stage={stage} me={me} next={next} eliminated={eliminated} />
  );
}

// ---------------------------------------------------------------------------
// 本赛事战绩（最近在前）
// ---------------------------------------------------------------------------
const RESULTS_MAX = 6;

export function MyResults({ game, t, me, onOpen }: { game: GameState; t: Tournament; me: string; onOpen: (s: Series) => void }) {
  const all = mySeriesResults(t, me);
  if (all.length === 0) return <div className="text-xs text-faint">本赛事尚未出赛。</div>;
  const count = { win: 0, lose: 0, draw: 0 };
  for (const s of all) count[outcomeOf(s, me)]++;
  const list = all.slice().reverse().slice(0, RESULTS_MAX);
  const stageName = (s: Series) => t.stages?.find((st) => st.id === s.stageId)?.name ?? '';
  return (
    <div className="text-xs">
      <div className="mb-1.5 text-mute">
        系列赛 <span className="tabular text-good">{count.win} 胜</span>
        {count.draw > 0 && <span className="tabular text-info"> {count.draw} 平</span>}
        <span className="tabular text-bad"> {count.lose} 负</span>
        {all.length > list.length && <span className="ml-1 text-faint">（显示最近 {list.length} 场）</span>}
      </div>
      <div className="divide-y divide-line/60 rounded-md border border-line">
        {list.map((s) => {
          const { my, opp, oppId } = myScoreOf(s, me);
          const res = outcomeOf(s, me);
          const forfeit = !!s.result?.forfeit;
          const canOpen = !!s.result?.games?.length;
          return (
            <button
              key={s.id}
              type="button"
              disabled={!canOpen}
              onClick={() => canOpen && onOpen(s)}
              title={canOpen ? '查看逐局 BP 与数据' : forfeit ? '弃权判负，没有对局记录' : undefined}
              className={cx('flex w-full items-center gap-2 px-2.5 py-1.5 text-left', canOpen ? 'cursor-pointer hover:bg-panel-2' : 'cursor-default')}
            >
              <span className="w-28 shrink-0 truncate text-faint" title={`${stageName(s)} · ${s.label}`}>
                {s.label}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-faint">vs </span>
                <span className="text-ink">{(oppId && game.teams[oppId]?.tag) || '—'}</span>
                {forfeit && <span className="ml-1 text-bad">（弃权）</span>}
              </span>
              <span className="tabular font-semibold">
                {my}:{opp}
              </span>
              <Badge className={OUTCOME_CHIP[res].cls}>{OUTCOME_CHIP[res].text}</Badge>
            </button>
          );
        })}
      </div>
    </div>
  );
}

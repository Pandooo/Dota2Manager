// 游戏结束：类似《文明》的生涯总结（生涯期满 / 解散 / 全员假赛禁赛 / 破产）。
// 数据全部来自引擎 legacy.computeLegacyReport（纯计算，不修改游戏状态）。多人模式：已出局的座位也能看到自己的总结
// （onSpectate = 返回观战），终局时额外对比全部人类俱乐部。
import { useMemo, type ReactNode } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, computeAllLegacyReports, computeLegacyReport, formatGold, TOURNAMENT_TIER_LABEL,
  type GameOverReason, type LegacyBoardRow, type LegacyReport, type LegacyTimelineRow,
} from '../../engine';
import { Badge, Button, Card, EmptyState, PlayerLink, PosBadge, TableScroll, TeamTag, TierBadge, cx } from '../components/common';
import MusicControl from '../components/MusicControl';
import { DIFFICULTY_LABEL, MiniTitle, Sparkline, TourTierBadge, downloadText, safe, saveFileName } from '../components/ShellKit';
import type { Position } from '../../engine';

// ---------------------------------------------------------------------------
// 结局主题
// ---------------------------------------------------------------------------

interface EndingTheme {
  kicker: string;
  heading: string;
  sub: (r: LegacyReport, endTi: number) => string;
  banner: string;
  glow: string;
  accent: string;
  ring: string;
}

const THEMES: Record<GameOverReason, EndingTheme> = {
  completed: {
    kicker: 'Career Complete',
    heading: '生涯落幕',
    sub: (r) => `${r.teamName} 的 ${r.seasonsPlayed} 个赛季到此画上句号。`,
    banner: 'bg-gradient-to-br from-[#2b2210] via-panel to-bg',
    glow: 'rgba(229,178,77,0.28)',
    accent: 'text-gold',
    ring: 'border-gold',
  },
  disbanded: {
    kicker: 'Club Disbanded',
    heading: '战队解散',
    sub: (r, endTi) => `荣誉跌破 0，${r.teamName} 在 TI${endTi} 赛季被迫解散。`,
    banner: 'bg-gradient-to-br from-[#2a1416] via-panel to-bg',
    glow: 'rgba(239,91,91,0.25)',
    accent: 'text-bad',
    ring: 'border-bad/70',
  },
  bankrupt: {
    kicker: 'Bankrupt',
    heading: '俱乐部破产',
    sub: (r, endTi) => `资金链断裂，${r.teamName} 在 TI${endTi} 赛季宣告破产。`,
    banner: 'bg-gradient-to-br from-[#2a1d0c] via-panel to-bg',
    glow: 'rgba(255,159,26,0.24)',
    accent: 'text-tier-ss',
    ring: 'border-tier-ss/70',
  },
  banned: {
    kicker: 'Banned For Life',
    heading: '永久除名',
    sub: (r) => `全员假赛东窗事发，${r.teamName} 与全体队员被永久禁赛。`,
    banner: 'bg-gradient-to-br from-[#1a0b14] via-[#0d0a10] to-bg',
    glow: 'rgba(169,40,80,0.30)',
    accent: 'text-[#ff5c8a]',
    ring: 'border-[#ff5c8a]/70',
  },
};

const TITLE_STYLE: Record<string, string> = {
  immortal: 'ssr-text',
  triple: 'ssr-text',
  double_streak: 'text-gold',
  double: 'text-gold',
  single: 'text-gold',
  runner_king: 'text-tier-ss',
  evergreen: 'text-tier-s',
  uncrowned: 'text-tier-a',
  contender: 'text-info',
  unknown: 'text-mute',
};

const GRADE_STYLE: Record<string, string> = {
  'S+': 'ssr-text', S: 'text-gold', A: 'text-tier-ss', B: 'text-tier-a', C: 'text-tier-b', D: 'text-mute',
};

const ENDING_LABEL: Record<GameOverReason, string> = { completed: '生涯期满', disbanded: '解散', banned: '假赛除名', bankrupt: '破产' };

const tiList = (list: readonly number[]) => (list.length ? list.map((t) => `TI${t}`).join(' · ') : '—');

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function GameOver({ onSpectate }: { onSpectate?: () => void } = {}) {
  const game = useGame();
  const version = useGameStore((s) => s.version);
  const quit = useGameStore((s) => s.quitToMenu);
  const exportJson = useGameStore((s) => s.exportJson);
  const toast = useGameStore((s) => s.toast);

  const me = game.settings.playerTeamId;
  const mp = !!game.multiplayer;
  // 多人：终局时排行榜与对比表纳入全部人类俱乐部（中途出局的座位观看时其他玩家仍在比赛，只看自己的总结）
  const final = !!game.gameOver;
  const humans = useMemo(
    () => (mp && final ? (game.multiplayer?.order ?? Object.keys(game.multiplayer?.seats ?? {})).filter((id) => !!game.teams[id]) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [game, version, mp, final],
  );
  const report = useMemo(
    () => safe(() => computeLegacyReport(game, me, humans), null as LegacyReport | null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [game, version, me, humans],
  );
  const all = useMemo(
    () => (mp && final ? safe(() => computeAllLegacyReports(game), [] as LegacyReport[]) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [game, version, mp, final],
  );

  const doExport = () => {
    const json = exportJson();
    if (!json) {
      toast('导出失败：没有进行中的游戏', false);
      return;
    }
    downloadText(json, saveFileName(game.teams[me]?.tag));
    toast('存档已导出');
  };

  if (!report) {
    return (
      <div className="grid h-full place-items-center">
        <EmptyState text="生涯总结生成失败">
          <Button variant="secondary" onClick={quit}>返回主菜单</Button>
        </EmptyState>
      </div>
    );
  }

  const ending = report.ending;
  const theme = THEMES[ending] ?? THEMES.completed;
  const s = report.stats;
  const spectatingAvailable = !!onSpectate && !game.gameOver;

  const tiles: { label: string; value: ReactNode; hint?: string; cls?: string }[] = [
    { label: 'TI 冠军', value: s.tiTitles.length, hint: s.tiTitles.length ? tiList(s.tiTitles) : '目标：至少 1 座', cls: s.tiTitles.length ? 'text-gold' : undefined },
    { label: 'TI 亚军', value: s.tiRunnerUp.length, hint: s.tiRunnerUp.length ? tiList(s.tiRunnerUp) : `参加 TI ${s.tiAppearances} 次` },
    { label: 'TI 前八', value: s.tiTitles.length + s.tiRunnerUp.length + s.tiTop4.length + s.tiTop8.length, hint: `其中前四 ${s.tiTitles.length + s.tiRunnerUp.length + s.tiTop4.length} 次` },
    { label: 'Major / 顶级赛事', value: `${s.majors} / ${s.premiers}`, hint: s.minors ? `另有 ${s.minors} 个其他冠军` : undefined },
    { label: '荣誉峰值', value: s.honorPeak ?? '—', hint: `战力前三赛季 ${s.topSeasons} 个` },
    { label: '执教赛季', value: report.seasonsPlayed, hint: report.seasonsPlayed ? `TI${report.startTi} → TI${report.endTi}` : undefined },
  ];

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      {/* ---------- 横幅 ---------- */}
      <div className={cx('relative overflow-hidden border-b border-line', theme.banner)}>
        <div
          className="pointer-events-none absolute -right-24 -top-32 h-[28rem] w-[28rem] rounded-full"
          style={{ background: `radial-gradient(circle, ${theme.glow}, transparent 65%)` }}
        />
        {ending === 'banned' && (
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.07]"
            style={{ backgroundImage: 'repeating-linear-gradient(135deg, #ff5c8a 0 2px, transparent 2px 22px)' }}
          />
        )}
        {ending === 'bankrupt' && (
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.05]"
            style={{ backgroundImage: 'repeating-linear-gradient(0deg, #ff9f1a 0 1px, transparent 1px 26px)' }}
          />
        )}
        {/* 手机：背景音乐按钮在横幅右上角（随页面滚走；App 在手机上不显示固定的浮动按钮） */}
        <div className="absolute right-3 top-3 z-10 sm:hidden">
          <MusicControl floating="inline" />
        </div>
        {/* 手机：顶部让出右上角的背景音乐按钮（pt-14）；文字列至少 16rem，放不下评级圆章时圆章换到上方居中（order-first），
            不再与文字并排把文字挤成一字一行 */}
        <div className="relative mx-auto flex max-w-6xl flex-wrap items-center gap-6 px-4 pb-8 pt-14 sm:gap-8 sm:px-6 sm:py-10">
          <div className="min-w-[16rem] flex-1">
            <div className={cx('text-xs font-semibold uppercase tracking-[0.4em]', theme.accent)}>{theme.kicker}</div>
            <h1 className="mt-2 text-4xl font-black tracking-wide sm:text-5xl">{theme.heading}</h1>
            <div className="mt-2 text-sm text-mute">{theme.sub(report, report.endTi)}</div>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <TeamTag color={report.color} tag={report.tag || '—'} />
              <span className="font-semibold">{report.teamName}</span>
              {report.managerName && <span className="text-mute">经理 {report.managerName}</span>}
              <span className="text-mute">难度 {DIFFICULTY_LABEL[game.settings.difficulty] ?? game.settings.difficulty}</span>
              <span className="text-mute">TI{game.settings.startTi} → TI{game.settings.endTi}</span>
            </div>

            <div className="mt-5 rounded-lg border border-line bg-panel/70 px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-xs tracking-[0.3em] text-faint">称号</span>
                <span className={cx('text-2xl font-black', TITLE_STYLE[report.title.id] ?? 'text-ink')}>{report.title.name}</span>
                {ending === 'banned' && <Badge className="bg-[#ff5c8a]/15 text-[#ff8fb0]">污点</Badge>}
              </div>
              <div className="mt-1 text-sm text-ink/80">{report.title.desc}</div>
              {report.match && (
                <div className="mt-2 text-sm">
                  <span className="text-mute">最接近的历史俱乐部：</span>
                  <span className="font-semibold text-ink">{report.match.line}</span>
                  {/* 无冠俱乐部的一句话已含 highlight，不重复显示 */}
                  {!report.match.line.includes(report.match.club.highlight) && (
                    <span className="ml-2 text-xs text-faint">{report.match.club.highlight}</span>
                  )}
                </div>
              )}
            </div>

            <div className={cx('mt-4 max-w-3xl space-y-1 text-sm leading-relaxed', ending === 'banned' ? 'text-[#ffc2d4]' : 'text-ink/85')}>
              {report.epilogue.map((line, i) => (
                <p key={i} className={cx(ending === 'banned' && i === 0 && 'font-semibold')}>{line}</p>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {spectatingAvailable && (
                <Button variant="primary" onClick={onSpectate}>
                  继续观战
                </Button>
              )}
              {(!mp || !!game.gameOver) && (
                <Button variant="gold" onClick={doExport}>
                  ⇩ 导出存档
                </Button>
              )}
              <Button variant="secondary" onClick={quit}>
                返回主菜单
              </Button>
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-center max-sm:order-first max-sm:w-full">
            <div className={cx('relative grid h-32 w-32 place-items-center rounded-full border-4 bg-panel/80 shadow-2xl sm:h-40 sm:w-40', theme.ring, ending === 'completed' && s.tiTitles.length > 0 && 'glow')}>
              <div className="text-center">
                <div className={cx('text-5xl font-black italic', GRADE_STYLE[report.grade] ?? 'text-ink')}>{report.grade}</div>
                <div className="mt-1 text-lg font-bold tabular text-ink">{report.score.total}</div>
                <div className="text-[10px] tracking-[0.3em] text-faint">传奇值</div>
              </div>
              {ending === 'banned' && (
                <div className="absolute -right-3 top-2 rotate-12 rounded border-2 border-[#ff5c8a] bg-bg/90 px-2 py-0.5 text-sm font-black tracking-widest text-[#ff5c8a]">
                  禁赛
                </div>
              )}
              {ending === 'bankrupt' && (
                <div className="absolute -right-3 top-2 rotate-12 rounded border-2 border-tier-ss bg-bg/90 px-2 py-0.5 text-sm font-black tracking-widest text-tier-ss">
                  破产
                </div>
              )}
            </div>
            <div className="mt-3 text-center text-sm">
              <span className="text-mute">历史排行 </span>
              <span className="font-bold tabular text-ink">第 {report.rank}</span>
              <span className="text-mute"> / {report.boardSize}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-faint">与 {report.boardSize - 1 - Math.max(0, humans.length - 1)} 家真实俱乐部同台</div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        {/* ---------- 数据 ---------- */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl border border-line bg-panel/90 px-4 py-3">
              <div className="text-[11px] tracking-wider text-mute">{t.label}</div>
              <div className={cx('mt-1 text-2xl font-bold tabular', t.cls)}>{t.value}</div>
              {t.hint && <div className="mt-0.5 truncate text-[11px] text-faint" title={t.hint}>{t.hint}</div>}
            </div>
          ))}
        </div>

        {mp && all.length > 1 && <HumanComparison reports={all} me={me} />}

        {/* 单列也写 minmax(0,1fr)：隐式 auto 列会被排行榜表格撑到 700px 以上，整页横向滚动 */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <Leaderboard report={report} />
            <Timeline rows={report.timeline} />
          </div>
          <div className="space-y-4">
            <ScoreCard report={report} />
            <MomentsCard report={report} />
            <BestPlayers report={report} />
            <Card title="生涯走势">
              <MiniTitle right={<span className="text-xs tabular text-ink">峰值 {s.honorPeak ?? '—'}</span>}>荣誉</MiniTitle>
              <Sparkline values={report.honorCurve} color="var(--color-gold)" baseline={0} baselineLabel="解散线" />
              <MiniTitle className="mt-4" right={<span className="text-xs tabular text-gold">{report.goldCurve.length ? formatGold(Math.max(...report.goldCurve)) : '—'}</span>}>
                资金
              </MiniTitle>
              <Sparkline values={report.goldCurve} color="var(--color-good)" baseline={0} />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function Leaderboard({ report }: { report: LegacyReport }) {
  const max = Math.max(5, CONFIG.legacy.leaderboardRows);
  const rows = report.board;
  const selfIdx = rows.findIndex((r) => r.kind === 'self');
  const shown: (LegacyBoardRow | null)[] = rows.slice(0, max);
  if (selfIdx >= max) shown.push(null, rows[selfIdx]);
  const rankOf = (r: LegacyBoardRow) => rows.indexOf(r) + 1;
  return (
    <Card title="历史排行榜" subtitle="真实俱乐部截至 TI15（2026）的 TI 成绩与 Valve Major 冠军，与你的俱乐部按同一口径计算传奇值">
      {/* 手机：横向滑动，名次与俱乐部两列固定在左侧（年份区间不显示，固定列更窄） */}
      <TableScroll className="-mx-4 -my-4">
        <table className="tbl">
          <thead>
            <tr>
              <th className={cx('num', STICKY_RANK, 'max-sm:z-[3]!')}>#</th>
              <th className={cx(STICKY_CLUB, 'max-sm:z-[3]!')}>俱乐部</th>
              <th>称号</th>
              <th>TI 冠军</th>
              <th>TI 亚军</th>
              <th className="num" title="TI 第 3–4 名次数（不含冠亚军）">季殿军</th>
              <th className="num">Major</th>
              <th className="num">传奇值</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) =>
              r === null ? (
                <tr key={`gap-${i}`}>
                  <td colSpan={8} className="text-center text-faint">⋯</td>
                </tr>
              ) : (
                <tr
                  key={r.key}
                  className={cx(r.kind === 'self' && 'bg-gold/10 ring-1 ring-inset ring-gold/50', r.kind === 'human' && 'bg-info/5')}
                  title={r.highlight}
                >
                  <td className={cx('num', STICKY_RANK, stickyRowBg(r.kind), r.kind === 'self' ? 'font-bold text-gold' : 'text-mute')}>{rankOf(r)}</td>
                  <td className={cx(STICKY_CLUB, stickyRowBg(r.kind))}>
                    <div className="flex items-center gap-2">
                      <span className={cx('font-semibold', r.kind === 'self' ? 'text-gold' : r.kind === 'human' ? 'text-info' : 'text-ink')}>{r.name}</span>
                      {r.kind === 'self' && <Badge className="bg-gold/20 text-gold">你</Badge>}
                      {r.kind === 'human' && <Badge className="bg-info/15 text-info">玩家</Badge>}
                      <span className="text-[11px] text-faint max-sm:hidden">{r.span}</span>
                    </div>
                  </td>
                  <td className={cx('whitespace-nowrap text-xs', TITLE_STYLE[r.title.id] ?? 'text-mute')}>{r.title.name}</td>
                  <td className={cx('whitespace-nowrap text-xs', r.tiTitles.length ? 'text-gold' : 'text-faint')}>{tiList(r.tiTitles)}</td>
                  <td className={cx('whitespace-nowrap text-xs', r.tiRunnerUp.length ? 'text-ink' : 'text-faint')}>{tiList(r.tiRunnerUp)}</td>
                  <td className="num">{r.tiTop4 || <span className="text-faint">—</span>}</td>
                  <td className="num">{r.majors || <span className="text-faint">—</span>}</td>
                  <td className={cx('num font-semibold', r.kind === 'self' && 'text-gold')}>{r.score}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </TableScroll>
    </Card>
  );
}

/**
 * 手机（< sm）历史排行榜：名次列（w-10）与俱乐部列固定在左侧。固定格要实色底（遮住滑过的列），本人 / 玩家行的底色按行色混合；
 * 表头格的层级要加 !（index.css 的 .tbl th { z-index: 1 } 不在 @layer 里，优先于工具类）
 */
const STICKY_RANK = 'max-sm:sticky max-sm:left-0 max-sm:z-[2] max-sm:w-10 max-sm:min-w-10';
const STICKY_CLUB = 'max-sm:sticky max-sm:left-10 max-sm:z-[2] max-sm:shadow-[1px_0_0_var(--color-line)]';
function stickyRowBg(kind: LegacyBoardRow['kind']): string {
  if (kind === 'self') return 'max-sm:bg-[color-mix(in_srgb,var(--color-gold)_10%,var(--color-panel))]';
  if (kind === 'human') return 'max-sm:bg-[color-mix(in_srgb,var(--color-info)_5%,var(--color-panel))]';
  return 'max-sm:bg-panel';
}

function tiCellClass(r: LegacyTimelineRow): string {
  if (!r.tiRank) return 'text-faint';
  if (r.tiRank[0] === 1 && r.tiRank[1] === 1) return 'font-bold text-gold';
  if (r.tiRank[0] === 2) return 'font-semibold text-tier-ss';
  if (r.tiRank[0] <= 4) return 'text-tier-s';
  if (r.tiRank[0] <= 8) return 'text-ink';
  return 'text-mute';
}

function Timeline({ rows }: { rows: LegacyTimelineRow[] }) {
  return (
    <Card title="赛季时间线" subtitle="每届 TI 的成绩、本季冠军与赛季末实力排名">
      {rows.length === 0 ? (
        <EmptyState text="还没有完成任何一个赛季（生涯在首个赛季内结束）。" />
      ) : (
        <ol className="relative space-y-3 border-l border-line pl-5">
          {rows.map((r) => {
            const won = !!r.tiRank && r.tiRank[0] === 1 && r.tiRank[1] === 1;
            return (
              <li key={r.ti} className="relative">
                <span
                  className={cx(
                    'absolute -left-[27px] top-1 grid h-3.5 w-3.5 place-items-center rounded-full border-2',
                    won ? 'border-gold bg-gold' : r.ending === 'banned' ? 'border-[#ff5c8a] bg-[#ff5c8a]/40'
                      : r.ending === 'bankrupt' ? 'border-tier-ss bg-tier-ss/40' : r.ending ? 'border-bad bg-bad/40' : 'border-line bg-panel-3',
                  )}
                />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="font-semibold">TI{r.ti}</span>
                  <span className="text-[11px] text-faint">{r.year}</span>
                  <span className={cx('text-sm', tiCellClass(r))}>{r.tiLabel}</span>
                  {r.partial && (
                    <Badge className={r.ending === 'banned' ? 'bg-[#ff5c8a]/15 text-[#ff8fb0]' : r.ending === 'bankrupt' ? 'bg-tier-ss/15 text-tier-ss' : r.ending ? 'bg-bad/15 text-bad' : 'bg-panel-3 text-mute'}>
                      {r.ending ? `赛季中${ENDING_LABEL[r.ending]}` : '赛季未完成'}
                    </Badge>
                  )}
                  <span className="ml-auto text-xs text-mute tabular">
                    实力 #{r.strengthRank}/{r.strengthTeams}
                    {r.finalRank ? ` · 积分榜 #${r.finalRank}` : ''} · 荣誉 {r.honorEnd}
                  </span>
                </div>
                {r.titles.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {r.titles.map((t, i) => (
                      <span key={i} className="inline-flex items-center gap-1 rounded border border-line bg-panel-2/60 px-1.5 py-0.5 text-xs" title={TOURNAMENT_TIER_LABEL[t.tier]}>
                        <TourTierBadge tier={t.tier} />
                        {t.name}
                      </span>
                    ))}
                  </div>
                )}
                {r.tiChampion && !won && <div className="mt-0.5 text-[11px] text-faint">本届冠军：{r.tiChampion}</div>}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function ScoreCard({ report }: { report: LegacyReport }) {
  const sc = report.score;
  return (
    <Card title="传奇值构成" subtitle="成就 + 赛季实力 + 声望（实力分以成就为上限）">
      {sc.parts.length === 0 ? (
        <div className="text-sm text-mute">没有可计入的成就。</div>
      ) : (
        <div className="space-y-1">
          {sc.parts.map((p) => (
            <div key={p.label} className="flex items-center justify-between text-sm">
              <span className="text-mute">{p.label}</span>
              <span className={cx('tabular', p.value < 0 ? 'text-bad' : 'text-ink')}>{p.value > 0 ? `+${p.value}` : p.value}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between border-t border-line pt-2">
        <span className="text-sm font-semibold">合计</span>
        <span className="text-lg font-bold tabular text-gold">{sc.total}</span>
      </div>
      {sc.strengthRaw > sc.strength && (
        <div className="mt-1 text-[11px] text-faint">赛季实力原始 {sc.strengthRaw} 分，按成就封顶计入 {sc.strength} 分</div>
      )}
    </Card>
  );
}

function MomentsCard({ report }: { report: LegacyReport }) {
  const list = report.moments;
  return (
    <Card title="关键时刻" subtitle={list.length ? `共 ${list.length} 条` : undefined}>
      {list.length === 0 ? (
        <div className="text-sm text-mute">这段生涯还没有留下高光时刻。</div>
      ) : (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {list.map((m, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span className="shrink-0 rounded bg-panel-3 px-1.5 py-0.5 text-[11px] font-semibold text-mute">TI{m.ti}</span>
              <span className={cx(m.text.includes('不朽盾') && 'text-gold', m.text.includes('假赛') && 'text-[#ff8fb0]')}>{m.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BestPlayers({ report }: { report: LegacyReport }) {
  const game = useGame();
  const list = report.bestPlayers;
  return (
    <Card title="最佳选手" subtitle="效力赛季、巅峰评分与随队冠军">
      {list.length === 0 ? (
        <div className="text-sm text-mute">暂无记录</div>
      ) : (
        <div className="space-y-1.5">
          {list.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2.5 py-1.5 text-sm">
              <span className="shrink-0 whitespace-nowrap"><PosBadge pos={p.position as Position} /></span>
              {/* 名字过长时按钮本身截断（截断加在外层 span 上时，按钮是原子行内盒，只会被硬裁掉、没有省略号） */}
              <span className="min-w-0">
                {game.players[p.id] ? (
                  <PlayerLink player={{ id: p.id, handle: p.handle }} className="block max-w-full truncate text-left" />
                ) : (
                  <span className="block truncate font-medium">{p.handle}</span>
                )}
              </span>
              <span className="shrink-0"><TierBadge tier={p.tier} /></span>
              {p.status === 'banned' && <Badge className="shrink-0 whitespace-nowrap bg-[#ff5c8a]/15 text-[#ff8fb0]">禁赛</Badge>}
              {p.status === 'retired' && <Badge className="shrink-0 whitespace-nowrap bg-panel-3 text-mute">已退役</Badge>}
              <span className="ml-auto shrink-0 text-right text-[11px] leading-tight text-mute">
                {p.seasons} 季 · 评分 {Math.round(p.peakRating)}
                {(p.titles > 0 || p.tiTitles > 0) && (
                  <span className="block text-gold">
                    {p.tiTitles > 0 ? `TI 冠军 ×${p.tiTitles}` : ''}
                    {p.tiTitles > 0 && p.titles - p.tiTitles > 0 ? ' · ' : ''}
                    {p.titles - p.tiTitles > 0 ? `其他冠军 ×${p.titles - p.tiTitles}` : ''}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function HumanComparison({ reports, me }: { reports: LegacyReport[]; me: string }) {
  return (
    <Card title="玩家对比" subtitle="本局全部人类俱乐部的生涯总结">
      <TableScroll className="-mx-4 -my-4">
        <table className="tbl">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>玩家</th>
              <th>俱乐部</th>
              <th>结局</th>
              <th>称号</th>
              <th>TI 冠军</th>
              <th className="num">Major</th>
              <th className="num">历史排行</th>
              <th className="num">传奇值</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r, i) => (
              <tr key={r.teamId} className={cx(r.teamId === me && 'bg-gold/10 ring-1 ring-inset ring-gold/50')}>
                <td className="num text-mute">{i + 1}</td>
                <td className="font-semibold">{r.managerName || '—'}</td>
                <td>
                  <span className="inline-flex items-center gap-2">
                    <TeamTag color={r.color} tag={r.tag || '—'} />
                    <span className="text-xs text-mute">{r.teamName}</span>
                  </span>
                </td>
                <td className={cx('text-xs', r.ending === 'banned' ? 'text-[#ff8fb0]' : r.ending === 'bankrupt' ? 'text-tier-ss' : r.ending === 'disbanded' ? 'text-bad' : 'text-good')}>
                  {ENDING_LABEL[r.ending]}
                </td>
                <td className={cx('text-xs', TITLE_STYLE[r.title.id] ?? 'text-mute')}>{r.title.name}</td>
                <td className={cx('text-xs', r.stats.tiTitles.length ? 'text-gold' : 'text-faint')}>{tiList(r.stats.tiTitles)}</td>
                <td className="num">{r.stats.majors || <span className="text-faint">—</span>}</td>
                <td className="num">{r.rank}/{r.boardSize}</td>
                <td className="num font-semibold">{r.score.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Card>
  );
}

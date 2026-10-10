// 新秀选秀（转会中心标签页）：本届选秀（抽签结果 + 选秀板）、我的新秀（保留 / 赛季初免费放弃）、
// 抽签概率表与新秀池等级分布、往届选秀。选秀在每个赛季初自动举行，所有战队按顺位自动挑选。
// 另导出 RookieDraftPopupBody 供 PopupHost 展示「选秀结果」弹窗。
import { useState } from 'react';
import { useCall, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, TIERS, ageOf, draftedRookieReleaseBlock, draftedRookiesOf, effectiveAttr, effectivePower, formatGold,
  lotteryOddsTable, nextRookieSsrChance, playerTier, rookieDraftHistory, rookieDraftRecord, rookieTierProbabilities,
  rosterOverflowNotice,
  type GameState, type Player, type RookieDraftPick, type RookieDraftRecord, type Tier,
} from '../../engine';
import { Badge, Button, Card, EmptyState, Gold, PlayerLink, PosBadge, TeamLink, TierBadge, cx } from '../components/common';
import { ConfirmButton } from '../components/ConfirmPopover';
import { ScreenHeader } from '../layout/HubKit';
import { AttrNum, Banner, Meter, TableWrap, num, safe } from '../components/MarketKit';

function pct(v: number, digits = 1): string {
  return `${(num(v) * 100).toFixed(digits)}%`;
}

const TIER_BAR: Record<Tier, string> = {
  C: 'bg-tier-c',
  B: 'bg-tier-b',
  A: 'bg-tier-a',
  S: 'bg-tier-s',
  SS: 'bg-tier-ss',
  SSR: 'bg-gradient-to-r from-[#ffd54a] to-[#ff4d6d]',
};

function teamLabel(g: GameState, id: string) {
  const t = g.teams[id];
  if (!t) return <span className="text-mute">{id}</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: t.color }} />
      <TeamLink teamId={id} name={t.name} className="truncate" />
    </span>
  );
}

/** 选中的新秀（选手已被清理时用记录里的快照）；没有选手的顺位只出现在旧存档中 */
function PickPlayer({ g, pk }: { g: GameState; pk: RookieDraftPick }) {
  if (!pk.playerId) return <span className="text-faint">未选人</span>;
  const p = g.players[pk.playerId];
  // 选秀之后又离开了选中他的战队（休赛期转会潮 / AI 阵容整理 / 解约 / 转会）：标出现状，避免选秀板与自由市场对不上
  const now = !pk.released && p && p.status === 'active' && p.teamId !== pk.teamId ? (p.teamId ? g.teams[p.teamId] : null) : undefined;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {p ? <PlayerLink player={p} /> : <span className="font-medium">{pk.handle ?? pk.playerId}</span>}
      {pk.isReal && <Badge className="bg-gold/15 text-gold" title="真实选手（未来的职业选手）">★真实</Badge>}
      {pk.released && <Badge className="bg-panel-3 text-faint" title="被所属战队放弃（玩家赛季初免费放弃，或 AI 战队选秀后整理阵容），进入自由市场">已放弃</Badge>}
      {now !== undefined && (
        now
          ? <Badge className="bg-panel-3 text-faint" title={`选秀后已转投 ${now.name}`}>→ {now.tag}</Badge>
          : <Badge className="bg-panel-3 text-faint" title="选秀后已离开选中他的战队，目前是自由选手">已离队</Badge>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 选秀板（按轮次）
// ---------------------------------------------------------------------------
function DraftBoard({ g, rec, me, maxH }: { g: GameState; rec: RookieDraftRecord; me: string; maxH?: string }) {
  const [round, setRound] = useState(1);
  const rounds = Math.max(1, rec.rounds);
  const cur = Math.min(round, rounds);
  const picks = rec.picks.filter((p) => p.round === cur);
  return (
    <div>
      {rounds > 1 && (
        <div className="flex gap-1 border-b border-line px-3 pt-2">
          {Array.from({ length: rounds }, (_, i) => i + 1).map((r) => (
            <button
              key={r}
              onClick={() => setRound(r)}
              className={cx(
                '-mb-px cursor-pointer border-b-2 px-3 py-1.5 text-sm',
                r === cur ? 'border-dota text-ink' : 'border-transparent text-mute hover:text-ink',
              )}
            >
              第 {r} 轮
              <span className="ml-1 text-[11px] text-faint">{rec.picks.filter((p) => p.round === r && p.playerId).length} 人</span>
            </button>
          ))}
        </div>
      )}
      {picks.length === 0 ? (
        <EmptyState text="本轮没有顺位（新秀池已被选空）" />
      ) : (
        <TableWrap maxH={maxH}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="num">顺位</th>
                <th>战队</th>
                <th>新秀</th>
                <th>等级</th>
                <th>位置</th>
                <th className="num">年龄</th>
                <th className="num">战力</th>
                <th className="num">天赋</th>
                <th className="num">工资/回合</th>
                <th className="num">合同</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((pk) => (
                <tr key={pk.pick} className={cx(pk.teamId === me && 'bg-dota/10')}>
                  <td className="num">
                    <span className="font-semibold">{pk.pick}</span>
                    {pk.lottery && <span className="ml-1 text-[10px] text-gold" title="抽签产生的顺位">签</span>}
                  </td>
                  <td className="max-w-[180px]">{teamLabel(g, pk.teamId)}</td>
                  <td><PickPlayer g={g} pk={pk} /></td>
                  <td>{pk.tier ? <TierBadge tier={pk.tier} /> : <span className="text-faint">—</span>}</td>
                  <td>{pk.position ? <PosBadge pos={pk.position} /> : <span className="text-faint">—</span>}</td>
                  <td className="num">{pk.age ?? '—'}</td>
                  <td className="num">{pk.power != null ? <AttrNum value={pk.power} digits={1} /> : '—'}</td>
                  <td className="num">{pk.talent != null ? <AttrNum value={pk.talent} /> : '—'}</td>
                  <td className="num">{pk.salary != null ? <Gold value={pk.salary} /> : '—'}</td>
                  <td className="num text-xs text-mute">{pk.contractUntil ? `TI${pk.contractUntil}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 抽签结果
// ---------------------------------------------------------------------------
function LotteryTable({ g, rec, me, compact }: { g: GameState; rec: RookieDraftRecord; me: string; compact?: boolean }) {
  if (!rec.lottery.length) return <EmptyState text="本届没有举行抽签" />;
  const rows = rec.lottery.slice().sort((a, b) => a.finalPick - b.finalPick);
  return (
    <TableWrap>
      <table className="tbl">
        <thead>
          <tr>
            <th className="num">顺位</th>
            <th>战队</th>
            <th className="num" title={rec.firstSeason ? '首个赛季按初始实力 + 荣誉排名' : '上赛季最终排名'}>
              {rec.firstSeason ? '初始排名' : '上季排名'}
            </th>
            <th className="num">签前顺位</th>
            <th className="num">状元签概率</th>
            {!compact && <th className="num">前 {rec.lotteryPicks} 概率</th>}
            <th className="num">变化</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const move = e.seed - e.finalPick;
            return (
              <tr key={e.teamId} className={cx(e.teamId === me && 'bg-dota/10', e.won && 'font-semibold')}>
                <td className="num">
                  {e.finalPick}
                  {e.won && <span className="ml-1 text-[10px] text-gold">中签</span>}
                </td>
                <td className="max-w-[180px]">{teamLabel(g, e.teamId)}</td>
                <td className="num text-mute">{e.standing}</td>
                <td className="num text-mute">{e.seed}</td>
                <td className="num">{pct(e.oddsFirst)}</td>
                {!compact && <td className="num">{pct(e.oddsTop)}</td>}
                <td className={cx('num text-xs', move > 0 ? 'text-good' : move < 0 ? 'text-bad' : 'text-faint')}>
                  {move > 0 ? `↑${move}` : move < 0 ? `↓${-move}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
export default function RookieDraft() {
  const g = useGame();
  const call = useCall();
  const setView = useGameStore((s) => s.setView);
  const me = g.settings.playerTeamId;
  const team = g.teams[me];
  const ti = g.season.ti;
  const rec = safe(() => rookieDraftRecord(g, ti), null);
  const history = safe(() => rookieDraftHistory(g), [] as RookieDraftRecord[]);
  const past = history.filter((r) => r.ti !== ti);
  const [histTi, setHistTi] = useState<number | null>(null);

  const mine: Player[] = safe(() => draftedRookiesOf(g, me, ti), []);
  const myPicks = rec ? rec.picks.filter((p) => p.teamId === me) : [];
  const preseason = g.phase === 'preseason';
  // 抽签概率表按当前联赛规模（参加抽签的战队数 ≤ 未解散战队数）
  const teamCount = Object.values(g.teams ?? {}).filter((t) => t && !t.disbanded).length;
  const odds = safe(() => lotteryOddsTable(teamCount), [] as ReturnType<typeof lotteryOddsTable>);
  const probs = safe(() => rookieTierProbabilities(), null as Record<Tier, number> | null);
  const threshold = Math.max(1, num(CONFIG.draft.ssrPityThreshold, 100));
  const pity = Math.max(0, num(g.rookieDraft?.ssrPity));
  const ssrNext = safe(() => nextRookieSsrChance(pity), 0);
  const first = rec?.picks.find((p) => p.playerId);
  const made = rec ? rec.picks.filter((p) => p.playerId).length : 0;
  const released = rec ? rec.picks.filter((p) => p.playerId && p.released).length : 0;
  const overflowNote = safe<string | null>(() => rosterOverflowNotice(g, me), null);

  const histRec = histTi != null ? past.find((r) => r.ti === histTi) ?? null : past[0] ?? null;

  if (!team) {
    return (
      <>
        <ScreenHeader title="新秀选秀" />
        <EmptyState text="找不到你的战队数据。">
          <Button onClick={() => setView('dashboard')}>返回总览</Button>
        </EmptyState>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="新秀选秀"
        subtitle={`TI${ti} 赛季 · 每个赛季初自动举行（${CONFIG.draft.rounds} 轮）· 所有战队按顺位自动挑选，选中的新秀全部入队，首发与替补由你安排`}
        nav={<Button size="sm" variant="ghost" onClick={() => setView('squad')}>查看阵容</Button>}
      />

      {!rec && (
        <Banner tone="info" title="本赛季的新秀选秀尚未举行">
          选秀在每个赛季初（TI 结算之后、新赛季开始之前）自动举行。{past.length ? '可在下方查看往届选秀。' : '下个赛季初将举行第一届选秀。'}
        </Banner>
      )}

      {rec && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-gold/40 bg-gradient-to-br from-gold/15 to-panel-2/60 px-3 py-2">
            <div className="text-[11px] tracking-wider text-faint">状元</div>
            <div className="mt-0.5 flex items-center gap-2 text-base font-bold">
              {first ? (
                <>
                  {first.tier && <TierBadge tier={first.tier} />}
                  <PickPlayer g={g} pk={first} />
                </>
              ) : (
                <span className="text-mute">—</span>
              )}
            </div>
            {first && <div className="truncate text-xs text-mute">{teamLabel(g, first.teamId)}</div>}
          </div>
          <div className="rounded-lg border border-line bg-panel-2/60 px-3 py-2">
            <div className="text-[11px] tracking-wider text-faint">新秀池</div>
            <div className="mt-0.5 text-lg font-semibold tabular">{rec.realCount + rec.generatedCount} 人</div>
            <div className="text-xs text-faint">
              真实新秀 {rec.realCount} · 程序生成 {rec.generatedCount}{rec.ssrCount ? ` · SSR ${rec.ssrCount}` : ''}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-panel-2/60 px-3 py-2">
            <div className="text-[11px] tracking-wider text-faint">选中 / 落选</div>
            <div className="mt-0.5 text-lg font-semibold tabular">
              {made} <span className="text-faint">/</span> {rec.undrafted.length}
            </div>
            <div className="text-xs text-faint">
              {released ? `其中 ${released} 人被所属战队放弃 · ` : ''}落选新秀已进入自由市场
            </div>
          </div>
          <div className="rounded-lg border border-line bg-panel-2/60 px-3 py-2">
            <div className="text-[11px] tracking-wider text-faint">我的顺位</div>
            <div className="mt-0.5 text-lg font-semibold tabular">
              {myPicks.length ? myPicks.map((p) => p.pick).join(' · ') : '—'}
            </div>
            <div className="text-xs text-faint">
              {myPicks.length ? `选中 ${myPicks.filter((p) => p.playerId).length} 人` : '本届没有顺位'}
            </div>
          </div>
        </div>
      )}

      {overflowNote && (
        <Banner
          tone="info"
          title="阵容超出常规上限"
          actions={<Button size="sm" onClick={() => setView('squad')}>安排首发与替补</Button>}
        >
          {overflowNote}。这不影响推进；不需要的新秀{preseason ? '可在开始赛季前免费放弃' : '可在阵容页解约'}。
        </Banner>
      )}

      {/* 我的新秀 */}
      <Card
        title="我的新秀"
        subtitle={
          preseason
            ? '新秀全部入队，首发与替补由你在阵容页安排；赛季初可保留或免费放弃（放弃后进入自由市场，无解约补偿、不扣荣誉）'
            : '赛季已开始：新秀已正式入队（如需离队请在阵容页走正常解约）'
        }
        bodyClassName="p-0"
      >
        {mine.length === 0 ? (
          <EmptyState
            text={
              rec
                ? myPicks.some((p) => p.released)
                  ? '本届选中的新秀均已放弃。'
                  : '本届选秀没有为你选中新秀。'
                : '本赛季尚无选秀记录。'
            }
          />
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="num">顺位</th>
                  <th>新秀</th>
                  <th>位置</th>
                  <th className="num">年龄</th>
                  <th>等级</th>
                  <th className="num">战力</th>
                  <th className="num">天赋</th>
                  <th className="num">灵性</th>
                  <th className="num">工资/回合</th>
                  <th className="num">合同</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mine.map((p) => {
                  const block = safe(() => draftedRookieReleaseBlock(g, p), '暂不可放弃');
                  const starter = Object.values(team.lineup ?? {}).includes(p.id);
                  return (
                    <tr key={p.id}>
                      <td className="num">
                        <span className="font-semibold">{p.draft?.pick ?? '—'}</span>
                        <span className="ml-1 text-[10px] text-faint">第{p.draft?.round ?? '?'}轮</span>
                      </td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <PlayerLink player={p} />
                          {p.isReal && <Badge className="bg-gold/15 text-gold">★真实新秀</Badge>}
                          {starter && <Badge className="bg-good/15 text-good">首发</Badge>}
                        </div>
                      </td>
                      <td><PosBadge pos={p.position} /></td>
                      <td className="num">{safe(() => ageOf(g, p), 0)}</td>
                      <td><TierBadge tier={playerTier(p)} /></td>
                      <td className="num font-semibold"><AttrNum value={effectivePower(p)} digits={1} /></td>
                      <td className="num"><AttrNum value={effectiveAttr(p, 'talent')} /></td>
                      <td className="num"><AttrNum value={effectiveAttr(p, 'insight')} /></td>
                      <td className="num"><Gold value={num(p.salary)} /></td>
                      <td className="num text-xs text-mute">TI{p.contractUntil}</td>
                      <td className="text-right">
                        <ConfirmButton
                          size="xs"
                          variant="ghost"
                          disabled={!!block}
                          title={block ?? `放弃 ${p.handle}（无费用，进入自由市场）`}
                          confirm={{
                            title: `放弃新秀 ${p.handle}？`,
                            danger: true,
                            confirmLabel: '放弃',
                            cancelLabel: '保留',
                            message: (
                              <>
                                第 {p.draft?.pick ?? '?'} 顺位 · {safe(() => ageOf(g, p), 0)} 岁 · 战力 {effectivePower(p).toFixed(1)} · 天赋{' '}
                                {Math.round(effectiveAttr(p, 'talent'))}。放弃后离队成为自由选手（其他战队可能签下他），无解约补偿、不扣荣誉，不可撤销。
                                {p.isReal && <span className="mt-1 block text-gold">这是一名真实新秀，日后往往成长为职业强者。</span>}
                              </>
                            ),
                          }}
                          onConfirm={() => void call('releaseDraftedRookie', p.id)}
                        >
                          放弃
                        </ConfirmButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {rec && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <Card
            title={`TI${rec.ti} 选秀板`}
            subtitle={`首轮前 ${rec.lotteryPicks} 顺位由抽签决定，其余按${rec.firstSeason ? '初始排名' : '上赛季排名'}倒序；第 2 轮起按排名倒序`}
            bodyClassName="p-0"
          >
            <DraftBoard g={g} rec={rec} me={me} maxH="max-h-[560px]" />
          </Card>
          <Card
            title="选秀抽签结果"
            subtitle={`${rec.firstSeason ? '初始排名' : '上赛季排名'}最差的 ${rec.lottery.length} 支战队参加`}
            bodyClassName="p-0"
          >
            <LotteryTable g={g} rec={rec} me={me} />
          </Card>
        </div>
      )}

      {rec && rec.undrafted.length > 0 && (
        <Card title="落选新秀" subtitle="未被选中的新秀已成为自由选手，可在转会市场签约">
          <div className="flex flex-wrap gap-1.5">
            {rec.undrafted.map((id) => {
              const p = g.players[id];
              if (!p || p.status !== 'active') return null;
              const signed = p.teamId ? g.teams[p.teamId] : null;
              return (
                <span key={id} className="inline-flex items-center gap-1 rounded border border-line bg-panel-2/50 px-1.5 py-0.5 text-xs">
                  <TierBadge tier={playerTier(p)} />
                  <PlayerLink player={p} />
                  <span className="text-faint">{p.position}</span>
                  {p.isReal && <span className="text-gold">★</span>}
                  {signed && <span className="text-faint">→ {signed.tag}</span>}
                </span>
              );
            })}
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="抽签概率表" subtitle={`按排名倒序的前 ${odds.length} 支战队参加，抽出首轮前 ${CONFIG.draft.lotteryPicks} 顺位`} bodyClassName="p-0">
          {odds.length === 0 ? (
            <EmptyState text="未配置抽签" />
          ) : (
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="num">排名倒数</th>
                    <th className="num">状元签</th>
                    <th className="num">前 {CONFIG.draft.lotteryPicks} 顺位</th>
                    <th className="num">最差顺位</th>
                  </tr>
                </thead>
                <tbody>
                  {odds.map((o) => {
                    let worst = o.seed;
                    o.dist.forEach((v, i) => {
                      if (v > 1e-9) worst = Math.max(worst, i + 1);
                    });
                    return (
                      <tr key={o.seed}>
                        <td className="num">第 {o.seed}</td>
                        <td className="num">
                          <span className="inline-flex items-center gap-2">
                            <Meter value={o.oddsFirst} max={odds[0]?.oddsFirst || 1} className="w-16" />
                            {pct(o.oddsFirst)}
                          </span>
                        </td>
                        <td className="num">{pct(o.oddsTop)}</td>
                        <td className="num text-mute">第 {worst}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="新秀池等级分布" subtitle="程序生成新秀的等级概率；真实新秀保留数据中的等级">
          {!probs ? (
            <EmptyState text="概率数据暂不可用" />
          ) : (
            <div className="space-y-2.5">
              {TIERS.slice().reverse().map((t) => (
                <div key={t} className="flex items-center gap-2.5">
                  <span className="w-9 shrink-0"><TierBadge tier={t} /></span>
                  <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-panel-3">
                    <div className={cx('h-full rounded-full', TIER_BAR[t])} style={{ width: `${Math.max(1.5, probs[t] * 100)}%` }} />
                  </div>
                  <span className="w-14 shrink-0 text-right text-sm font-semibold tabular">{pct(probs[t])}</span>
                </div>
              ))}
              <div className="mt-3 rounded-lg border border-line bg-panel-2/50 p-3">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="text-mute">SSR 保底进度 <span className="text-faint">（每 {threshold} 名新秀至少 1 名 SSR，跨赛季）</span></span>
                  <span className="tabular">
                    <span className="font-semibold text-ink">{pity}</span>
                    <span className="text-faint"> / {threshold}</span>
                  </span>
                </div>
                <Meter value={pity} max={threshold - 1 || 1} color={threshold - pity <= 10 ? 'bg-gold' : 'bg-tier-s'} />
                <div className="mt-1.5 text-[11px] leading-relaxed text-faint">
                  SSR 采用伪随机分布：连续未出现时概率逐个递增（下一名程序生成新秀为 SSR 的概率 {pct(ssrNext, 2)}）。
                  真实新秀也计入保底计数，任何 SSR 新秀出现即清零。
                </div>
              </div>
              <div className="text-[11px] leading-relaxed text-faint">
                新秀薪资表：第 1 顺位约 {formatGold(Math.round(CONFIG.draft.salaryTop))}/回合，按顺位递减至约 {formatGold(Math.round(CONFIG.draft.salaryBottom))}/回合（随年代经济指数缩放）；
                新秀合同首轮 {CONFIG.draft.contractSeasonsByRound[0] ?? 3} 个赛季、之后 {CONFIG.draft.contractSeasonsByRound[1] ?? 2} 个赛季。
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* 往届选秀 */}
      <Card
        title="往届选秀"
        subtitle={past.length ? `共 ${past.length} 届` : undefined}
        actions={
          past.length > 0 ? (
            <select
              className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs"
              value={histRec?.ti ?? ''}
              onChange={(e) => setHistTi(Number(e.target.value))}
            >
              {past.map((r) => (
                <option key={r.ti} value={r.ti}>
                  TI{r.ti} 选秀
                </option>
              ))}
            </select>
          ) : undefined
        }
        bodyClassName="p-0"
      >
        {!histRec ? (
          <EmptyState text="暂无往届选秀记录。" />
        ) : (
          <div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line px-4 py-2 text-xs text-mute">
              {past.slice(0, 8).map((r) => {
                const fp = r.picks.find((p) => p.playerId);
                return (
                  <button
                    key={r.ti}
                    onClick={() => setHistTi(r.ti)}
                    className={cx('cursor-pointer hover:text-ink', r.ti === histRec.ti && 'text-ink')}
                  >
                    TI{r.ti} 状元：<span className="font-medium">{fp?.handle ?? '—'}</span>
                    <span className="text-faint">（{fp ? g.teams[fp.teamId]?.tag ?? fp.teamId : '—'}）</span>
                  </button>
                );
              })}
            </div>
            <DraftBoard key={histRec.ti} g={g} rec={histRec} me={me} maxH="max-h-[420px]" />
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 选秀结果弹窗（PopupHost）
// ---------------------------------------------------------------------------
export function RookieDraftPopupBody({ game, ti }: { game: GameState; ti: number }) {
  const rec = safe(() => rookieDraftRecord(game, ti), null);
  const me = game.settings.playerTeamId;
  if (!rec) return <EmptyState text={`TI${ti} 选秀记录缺失`} />;
  const myPicks = rec.picks.filter((p) => p.teamId === me);
  const myLottery = rec.lottery.find((e) => e.teamId === me);
  const overflowNote = safe<string | null>(() => rosterOverflowNotice(game, me), null);
  const top = rec.picks.filter((p) => p.playerId).slice(0, Math.max(rec.lotteryPicks, 5));
  return (
    <div className="space-y-4">
      <div className="text-xs leading-relaxed text-mute">
        TI{ti} 赛季新秀选秀已自动完成：新秀池 {rec.realCount + rec.generatedCount} 人（真实新秀 {rec.realCount} 人），共 {rec.rounds} 轮。
        首轮前 {rec.lotteryPicks} 顺位由{rec.firstSeason ? '初始排名' : '上赛季排名'}最差的 {rec.lottery.length} 支战队抽签决定。
      </div>

      <div>
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-mute">我的选秀</div>
        {myPicks.length === 0 ? (
          <div className="rounded-lg border border-line bg-panel-2/40 px-3 py-2 text-sm text-mute">本届没有你的顺位。</div>
        ) : (
          <div className="space-y-1.5">
            {myLottery && (
              <div className="text-xs text-mute">
                抽签：签前第 {myLottery.seed} 顺位（状元签概率 {pct(myLottery.oddsFirst)}）→ 最终首轮第 {myLottery.finalPick} 顺位
                {myLottery.won ? <span className="ml-1 text-gold">（中签！）</span> : null}
              </div>
            )}
            {myPicks.map((pk) => {
              const p = pk.playerId ? game.players[pk.playerId] : undefined;
              return (
                <div key={pk.pick} className="flex flex-wrap items-center gap-2 rounded-lg border border-dota/30 bg-dota/10 px-3 py-2 text-sm">
                  <span className="shrink-0 whitespace-nowrap text-xs text-mute">第 {pk.round} 轮 · 第 {pk.pick} 顺位</span>
                  {pk.playerId ? (
                    <>
                      {pk.tier && <TierBadge tier={pk.tier} />}
                      {p ? <PlayerLink player={p} /> : <span className="font-medium">{pk.handle}</span>}
                      {pk.position && <PosBadge pos={pk.position} />}
                      {pk.isReal && <Badge className="bg-gold/15 text-gold">★真实新秀</Badge>}
                      <span className="ml-auto text-xs text-mute">
                        {pk.age ?? '?'} 岁 · 战力 {pk.power ?? '?'} · 天赋 {pk.talent ?? '?'} · <Gold value={num(pk.salary)} />/回合 · 至 TI{pk.contractUntil}
                      </span>
                    </>
                  ) : (
                    <span className="text-mute">未选人</span>
                  )}
                </div>
              );
            })}
            <div className="text-[11px] text-faint">
              选中的新秀全部入队，首发与替补由你在阵容页安排；不需要的新秀可在开始赛季前于「转会 › 新秀选秀」免费放弃。
            </div>
            {overflowNote && <div className="text-[11px] text-gold">{overflowNote}（不影响推进）。</div>}
          </div>
        )}
      </div>

      <div>
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-mute">抽签结果</div>
        <LotteryTable g={game} rec={rec} me={me} compact />
      </div>

      <div>
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-mute">前 {top.length} 顺位</div>
        <div className="space-y-1">
          {top.map((pk) => (
            <div key={pk.pick} className={cx('flex items-center gap-2 rounded-md px-2 py-1 text-sm', pk.teamId === me ? 'bg-dota/10' : 'bg-panel-2/40')}>
              <span className="w-8 shrink-0 text-right font-semibold tabular">{pk.pick}</span>
              {pk.tier && <TierBadge tier={pk.tier} />}
              <PickPlayer g={game} pk={pk} />
              {pk.position && <PosBadge pos={pk.position} />}
              <span className="ml-auto truncate text-xs text-mute">{teamLabel(game, pk.teamId)}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-mute">全部顺位</div>
        <div className="rounded-lg border border-line">
          <DraftBoard g={game} rec={rec} me={me} maxH="max-h-[260px]" />
        </div>
      </div>
    </div>
  );
}

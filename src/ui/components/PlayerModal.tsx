// 选手详情弹窗（全局）：useGameStore.selectedPlayerId 不为空时打开，openPlayer(null) 关闭
import { useState, type ReactNode } from 'react';
import { useGameStore } from '../../store/gameStore';
import {
  CONFIG, POSITIONS, POSITION_LABEL, ageOf, effectiveAttr, effectivePower, formatGold, heroById, heroName,
  isTransferWindowOpen, ladderMult, marketValue, overallRating, playerRating, playerTier, playerWillingness,
  rosterSigningBlock, rosterSigningNote, suggestedFee,
  activeListing, listingBidOutlook, listingDurationLabel, listingListedAtLabel, listingOffers, listingProgress, listingRoundStatus, raiseSalaryPreview,
  talkSuccessChance, talkedThisRound,
  SALARY_MOOD_LABEL, playerMoodSummary, renewalAsk, draftedRookieReleaseBlock,
  developmentOutlook, GROWTH_OUTLOOK_HINT, ROLE_FIT_LABEL, roleFit, roleFitFactor,
} from '../../engine';
import type { GameState, GrowthOutlook, OverallMood, Player, RoleFit, SalaryMood, Team } from '../../engine';
import {
  AttrRow, Badge, Button, EmptyState, Gold, Modal, PosBadge, RegionBadge, StatBar, TeamLink, TeamTag, TierBadge, cx,
} from './common';
import ErrorBoundary from './ErrorBoundary';
import {
  Chip, Flag, MOD_ATTR_LABEL, countryName, fmt1, modifierDuration, modifierPositive,
  modifierText, pct, safe, tierProgress, type ChipTone,
} from './SquadShared';
import { ConfirmButton } from './ConfirmPopover';
import { roundFee } from './MarketKit';
import { PediaEntryButton } from './PediaKit';

const WINDOW_LOCKED = '转会窗口已锁定（TI 预选与正赛阶段）';

/** 薪资满意度 / 整体情绪的标签色（只展示定性情绪，不显示预期薪资数值） */
const SALARY_MOOD_TONE: Record<SalaryMood, ChipTone> = { satisfied: 'good', mild: 'gold', strong: 'bad' };
const OVERALL_MOOD_TONE: Record<OverallMood, ChipTone> = { content: 'good', steady: 'info', wavering: 'gold', leaving: 'bad' };
/** 成长趋势（赛季自主成长，第九波）：只展示定性标签，不显示隐藏的潜力上限 */
const GROWTH_OUTLOOK_TONE: Record<GrowthOutlook, ChipTone> = { 仍有成长空间: 'good', 接近巅峰: 'gold', 已过巅峰: 'mute' };
const GROWTH_OUTLOOK_SHORT: Record<GrowthOutlook, string> = {
  仍有成长空间: '赛季初的自主训练仍能明显进步',
  接近巅峰: '接近自身上限，以保持水平为主',
  已过巅峰: '难再进步，能力将随年龄下滑',
};

export default function PlayerModal() {
  const id = useGameStore((s) => s.selectedPlayerId);
  const openPlayer = useGameStore((s) => s.openPlayer);
  if (!id) return null;
  return <PlayerModalInner key={id} id={id} onClose={() => openPlayer(null)} />;
}

function PlayerModalInner({ id, onClose }: { id: string; onClose: () => void }) {
  const game = useGameStore((s) => s.game);
  useGameStore((s) => s.version);
  const p = game?.players[id];

  if (!game || !p) {
    return (
      <Modal
        open
        onClose={onClose}
        title="选手详情"
        width="max-w-md"
        footer={game?.pedia?.players?.[id] ? <PediaEntryButton kind="player" id={id} /> : undefined}
      >
        <EmptyState text="该选手已不在数据库中（可能是已离队的野外替补）。" />
      </Modal>
    );
  }

  const tier = safe(() => playerTier(p), 'C' as const);
  const ownTeam = p.teamId ? game.teams[p.teamId] : undefined;
  const starterPos = ownTeam ? POSITIONS.find((pos) => ownTeam.lineup?.[pos] === p.id) : undefined;
  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-5xl"
      title={
        <div className="flex flex-wrap items-center gap-2">
          <Flag cc={p.nationality} className="text-lg" />
          <span className="text-lg font-bold tracking-wide">{p.handle}</span>
          <TierBadge tier={tier} />
          <PosBadge pos={p.position} full alt={p.altPositions} />
          {p.status === 'banned' && <Chip tone="bad">永久禁赛</Chip>}
          {p.status === 'retired' && <Chip>已退役</Chip>}
          {p.isRookie && <Chip tone="info">新秀</Chip>}
          {p.draft && (
            <Chip title={`TI${p.draft.ti} 新秀选秀第 ${p.draft.round} 轮第 ${p.draft.pick} 顺位，被 ${game.teams[p.draft.teamId]?.name ?? p.draft.teamId} 选中`}>
              TI{p.draft.ti} 选秀 · 第 {p.draft.pick} 顺位
            </Chip>
          )}
          {p.tempSubUntilTournament && <Chip tone="info">临时替补</Chip>}
          {p.status === 'active' && ownTeam && (
            starterPos ? (
              <Chip tone="gold" title={`${ownTeam.name} 首发：${POSITION_LABEL[starterPos]}`}>
                首发{starterPos !== p.position ? `·${POSITION_LABEL[starterPos].slice(0, 3)}（${ROLE_FIT_LABEL[roleFit(p, starterPos)]}）` : ''}
              </Chip>
            ) : !p.tempSubUntilTournament ? (
              <Chip title={`${ownTeam.name} 替补`}>替补</Chip>
            ) : null
          )}
        </div>
      }
      footer={
        <>
          <PediaEntryButton kind="player" id={p.id} className="mr-auto" />
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <ErrorBoundary>
        <PlayerDetail game={game} p={p} onClose={onClose} />
      </ErrorBoundary>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 主体
// ---------------------------------------------------------------------------
function PlayerDetail({ game, p, onClose }: { game: GameState; p: Player; onClose: () => void }) {
  const myTeamId = game.settings.playerTeamId;
  const team: Team | undefined = p.teamId ? game.teams[p.teamId] : undefined;
  const age = ageOf(game, p);
  const effMmr = safe(() => effectiveAttr(p, 'mmr'), p.mmr);
  const tier = safe(() => playerTier(p), 'C' as const);
  const prog = tierProgress(effMmr);
  const effPower = safe(() => effectivePower(p), p.power);
  const value = safe(() => marketValue(game, p), 0);
  const winRate = p.stats?.matches ? p.stats.wins / p.stats.matches : NaN;
  const mods = p.modifiers ?? [];
  const yearsLeft = p.contractUntil - game.season.ti + 1;
  const loyalty = safe(() => effectiveAttr(p, 'loyalty'), p.loyalty);
  const outlook = p.status === 'active' ? safe<GrowthOutlook | null>(() => developmentOutlook(game, p), null) : null;
  // 因签证等原因无法参加的（未结束）赛事
  const blocked = (p.unavailableTournamentIds ?? [])
    .map((tid) => game.tournaments[tid])
    .filter((t): t is NonNullable<typeof t> => !!t && t.status !== 'finished');
  const statusCount = mods.length + blocked.length;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* ---------- 左列 ---------- */}
        <div className="space-y-4">
          <Panel title="基本资料">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Info label="真名">{p.name || <span className="text-faint">未公开</span>}</Info>
              <Info label="国籍">
                <span className="inline-flex items-center gap-1.5">
                  <Flag cc={p.nationality} />
                  <span>{countryName(p.nationality)}</span>
                  <RegionBadge region={p.region} />
                </span>
              </Info>
              <Info label="年龄">
                {age} 岁 <span className="text-xs text-faint">（{p.birthYear} 年生）</span>
              </Info>
              <Info label="战队">
                {team ? (
                  <span className="inline-flex items-center gap-1.5">
                    <TeamTag color={team.color} tag={team.tag} />
                    <TeamLink teamId={team.id} name={team.name} className="text-mute" />
                    {team.id === myTeamId && <Chip tone="gold">本队</Chip>}
                  </span>
                ) : p.status === 'active' ? (
                  <span className="text-info">自由选手</span>
                ) : (
                  <span className="text-faint">
                    无
                    {p.lastTeamId && game.teams[p.lastTeamId] && (
                      <>
                        （前东家 <TeamLink teamId={p.lastTeamId} name={game.teams[p.lastTeamId].name} />）
                      </>
                    )}
                  </span>
                )}
              </Info>
              <Info label="位置" wrap>
                <PosBadge pos={p.position} full alt={p.altPositions} />
              </Info>
              <Info label="身份">
                <span className="inline-flex flex-wrap gap-1">
                  <Badge>{p.isReal ? '真实选手' : '程序生成'}</Badge>
                  {team && <Badge>TI{p.joinedSeason} 加盟</Badge>}
                </span>
              </Info>
            </div>
          </Panel>

          <Panel title="天梯">
            <div className="flex items-center gap-4">
              <div className="flex flex-col items-center gap-1">
                <TierBadge tier={tier} size="lg" />
                <span className="text-[11px] text-faint">×{safe(() => ladderMult(tier), 1).toFixed(2)}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-2xl font-bold tabular">{Math.round(effMmr)}</span>
                  {Math.round(effMmr) !== Math.round(p.mmr) && <span className="text-xs text-faint">基础 {Math.round(p.mmr)}</span>}
                  <span className="ml-auto text-xs text-mute">
                    {prog.next ? (
                      <>
                        距 <span className="font-semibold text-ink">{prog.next}</span> 还差 <span className="tabular text-gold">{prog.need}</span> 分
                      </>
                    ) : (
                      <span className="ssr-text font-semibold">已达最高等级</span>
                    )}
                  </span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-panel-3">
                  <div className="h-full rounded-full bg-gradient-to-r from-dota to-gold" style={{ width: `${prog.pct * 100}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-faint tabular">
                  <span>{prog.from}</span>
                  <span>天梯倍数 ×{safe(() => ladderMult(tier), 1).toFixed(2)}（同战力下的评分倍率）</span>
                  <span>{prog.to}</span>
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="属性">
            <div className="space-y-1.5">
              <AttrRow label="基础战力" value={p.power} digits={1} />
              <AttrRow label="有效战力" value={effPower} digits={1} />
              <AttrRow label="天赋" value={safe(() => effectiveAttr(p, 'talent'), p.talent)} digits={1} />
              <AttrRow label="韧性" value={safe(() => effectiveAttr(p, 'resilience'), p.resilience)} digits={1} />
              <AttrRow label="灵性" value={safe(() => effectiveAttr(p, 'insight'), p.insight)} digits={1} />
              <AttrRow label="归属感" value={loyalty} digits={1} />
              {outlook && (
                <div className="flex items-center gap-2 text-xs" title={GROWTH_OUTLOOK_HINT[outlook]}>
                  <span className="w-14 shrink-0 text-mute">潜力</span>
                  <Chip tone={GROWTH_OUTLOOK_TONE[outlook]}>{outlook}</Chip>
                  <span className="min-w-0 flex-1 truncate text-faint">{GROWTH_OUTLOOK_SHORT[outlook]}</span>
                </div>
              )}
            </div>
            {loyalty < CONFIG.loyalty.leaveThreshold && p.status === 'active' && p.teamId && (
              <div className="mt-2 rounded border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-[#ffb4b4]">
                归属感低于 {CONFIG.loyalty.leaveThreshold}：每回合可能主动申请离队，或被其他战队挖角。
              </div>
            )}
            <div className="mt-3 grid grid-cols-5 gap-1.5">
              {POSITIONS.map((pos) => {
                const r = safe(() => playerRating(p, pos), 0);
                const fit = safe(() => roleFit(p, pos), 'off' as RoleFit);
                const own = fit === 'main';
                const near = fit === 'alt' || fit === 'swap';
                return (
                  <div
                    key={pos}
                    className={cx(
                      'rounded border px-1.5 py-1 text-center',
                      own ? 'border-gold/50 bg-gold/10' : near ? 'border-info/40 bg-info/5' : 'border-line bg-panel-3/40',
                    )}
                    title={own ? '本位置评分' : `打 ${POSITION_LABEL[pos]}：${ROLE_FIT_LABEL[fit]} ×${roleFitFactor(fit)}`}
                  >
                    <div className="text-[10px] text-faint">{POSITION_LABEL[pos].slice(0, 3)}</div>
                    <div className={cx('text-sm font-semibold tabular', own ? 'text-gold' : near ? 'text-info' : 'text-mute')}>{r.toFixed(1)}</div>
                    {!own && <div className="text-[9px] leading-3 text-faint">{fit === 'alt' ? '副位置' : fit === 'swap' ? '4/5 互换' : '非本位'}</div>}
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>

        {/* ---------- 右列 ---------- */}
        <div className="space-y-4">
          <Panel title={`当前状态${statusCount ? `（${statusCount}）` : ''}`}>
            {blocked.length > 0 && (
              <div className="mb-2 space-y-1">
                {blocked.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 rounded border border-bad/40 bg-bad/10 px-2 py-1 text-xs text-[#ffb4b4]">
                    <Chip tone="bad">签证受限</Chip>
                    <span className="min-w-0 flex-1 truncate">无法参加「{t.name}」</span>
                    <span className="shrink-0 text-faint">第 {t.roundIndex} 回合</span>
                  </div>
                ))}
              </div>
            )}
            {mods.length === 0 ? (
              blocked.length === 0 && <div className="py-2 text-center text-xs text-faint">无临时或永久修正，状态平稳</div>
            ) : (
              <ul className="divide-y divide-line/60">
                {mods.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', modifierPositive(m) ? 'bg-good' : 'bg-bad')} />
                    <span className="min-w-0 flex-1 truncate">{m.source}</span>
                    <span className="text-xs text-mute">{MOD_ATTR_LABEL[m.attr] ?? m.attr}</span>
                    <span className={cx('w-14 text-right font-semibold tabular', modifierPositive(m) ? 'text-good' : 'text-bad')}>
                      {modifierText(m)}
                    </span>
                    <span className="w-20 text-right text-xs text-faint">{modifierDuration(m)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="招牌英雄">
            {(p.signatureHeroes ?? []).length === 0 ? (
              <div className="py-1 text-xs text-faint">暂无</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {p.signatureHeroes.map((h) => (
                  <span
                    key={h}
                    title={safe(() => heroById(h)?.name, undefined) ?? h}
                    className="rounded-md border border-line bg-panel-3/60 px-2 py-0.5 text-xs"
                  >
                    {safe(() => heroName(h), h)}
                  </span>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="职业生涯">
            <div className="grid grid-cols-3 gap-2">
              <Mini label="出场局数" value={p.stats?.matches ?? 0} />
              <Mini label="胜场" value={p.stats?.wins ?? 0} />
              <Mini label="胜率" value={Number.isFinite(winRate) ? pct(winRate, 1) : '—'} />
              <Mini label="赛事冠军" value={p.stats?.titles ?? 0} tone={(p.stats?.titles ?? 0) > 0 ? 'text-gold' : undefined} />
              <Mini label="TI 冠军" value={p.stats?.tiTitles ?? 0} tone={(p.stats?.tiTitles ?? 0) > 0 ? 'ssr-text' : undefined} />
              <Mini label="MVP" value={p.stats?.mvp ?? 0} />
            </div>
          </Panel>

          <Panel title="合同与身价">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Info label="工资">
                {p.teamId ? (
                  <>
                    <Gold value={p.salary || 0} /> <span className="text-xs text-faint">/回合</span>
                  </>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </Info>
              <Info label="合同">
                {p.teamId ? (
                  p.tempSubUntilTournament ? (
                    <span className="text-info">仅效力 {game.tournaments[p.tempSubUntilTournament]?.name ?? '本项赛事'}</span>
                  ) : (
                    <span className={cx(yearsLeft <= 1 && 'text-gold')}>
                      至 TI{p.contractUntil}
                      <span className="ml-1 text-xs text-faint">（{yearsLeft <= 1 ? '本赛季到期' : `剩 ${yearsLeft} 个赛季`}）</span>
                    </span>
                  )
                ) : (
                  <span className="text-faint">无</span>
                )}
              </Info>
              <Info label="身价">
                <Gold value={value} />
              </Info>
              <Info label="综合评分">
                <span className="font-semibold text-gold tabular">{fmt1(safe(() => overallRating(p), 0))}</span>
              </Info>
            </div>
          </Panel>
        </div>
      </div>

      <ActionPanel game={game} p={p} team={team} onClose={onClose} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 经理操作
// ---------------------------------------------------------------------------
function ActionPanel({ game, p, team, onClose }: { game: GameState; p: Player; team: Team | undefined; onClose: () => void }) {
  const myTeamId = game.settings.playerTeamId;
  const myTeam = game.teams[myTeamId];
  const setView = useGameStore((s) => s.setView);

  if (p.status === 'retired') {
    const coach = Object.values(game.coaches).find((c) => c.formerPlayerId === p.id);
    return (
      <Panel title="状态">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-mute">
          <span>
            {p.handle} 已挂靴退役。
            {coach && (
              <>
                {' '}现已转型为 <span className="font-semibold text-ink">{coach.tier} 级教练「{coach.name}」</span>
                {coach.teamId ? `，执教 ${game.teams[coach.teamId]?.name ?? '某战队'}` : '，目前在教练市场待签'}。
              </>
            )}
          </span>
          {coach && !coach.teamId && (
            <Button
              size="sm"
              onClick={() => {
                setView('coach');
                onClose();
              }}
            >
              前往教练市场
            </Button>
          )}
        </div>
      </Panel>
    );
  }
  if (p.status === 'banned') {
    return (
      <Panel title="状态">
        <div className="text-sm text-[#ffb4b4]">{p.handle} 已被永久禁赛，无法签约或上场。</div>
      </Panel>
    );
  }
  if (!myTeam) return null;
  if (p.teamId === myTeamId) {
    const temp = !!p.tempSubUntilTournament;
    return (
      <>
        <OwnActions game={game} p={p} myTeam={myTeam} />
        {!temp && p.status === 'active' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <LoyaltyPanel game={game} p={p} />
            <ListingPanel game={game} p={p} windowOpen={safe(() => isTransferWindowOpen(game), true)} />
          </div>
        )}
      </>
    );
  }
  if (p.teamId && team) return <BidActions game={game} p={p} seller={team} myTeam={myTeam} />;
  if (p.teamId) {
    // 数据不一致：选手挂在不存在的战队上，既不能签约也不能报价
    return (
      <Panel title="状态">
        <div className="text-sm text-mute">该选手的所属战队数据缺失，暂时无法进行转会操作。</div>
      </Panel>
    );
  }
  return <FreeAgentActions game={game} p={p} myTeam={myTeam} onClose={onClose} />;
}

/** 本队选手：设为首发 / 续约 / 解约 */
function OwnActions({ game, p, myTeam }: { game: GameState; p: Player; myTeam: Team }) {
  const call = useGameStore((s) => s.call);
  const setView = useGameStore((s) => s.setView);
  const windowOpen = safe(() => isTransferWindowOpen(game), true);
  const ti = game.season.ti;
  const [minS, maxS] = CONFIG.economy.contractSeasons;
  const currentStarter = myTeam.lineup?.[p.position] ?? null;
  const isStarterHere = currentStarter === p.id;
  const occupant = currentStarter && currentStarter !== p.id ? game.players[currentStarter] : undefined;
  const loyalty = safe(() => effectiveAttr(p, 'loyalty'), p.loyalty);
  const remaining = Math.max(1, p.contractUntil - ti + 1);
  // 本届选秀选中的新秀：赛季初可免费放弃（引擎 releasePlayer 同样转为免费放弃）
  const freeRookie = !!p.draft && safe(() => draftedRookieReleaseBlock(game, p) === null, false);
  const comp = freeRookie ? 0 : Math.round(Math.max(0, p.salary || 0) * CONFIG.market.releaseCompRoundsPerSeason * remaining);
  const offers = (game.transferOffers ?? []).filter((o) => o.playerId === p.id && o.status === 'pending');
  const temp = !!p.tempSubUntilTournament;
  // 续约：默认满足选手要价（≥ 隐藏的预期薪资）；也可尝试维持现薪（低于他的心理预期会被拒绝）
  const ask = safe(() => renewalAsk(game, p), 0);
  const current = Math.max(0, p.salary || 0);
  const canKeepPay = !temp && current > 0 && current < ask;
  const [keepPay, setKeepPay] = useState(false);
  const offerKeep = keepPay && canKeepPay;

  const renewOptions: number[] = [];
  for (let n = minS; n <= maxS; n++) renewOptions.push(n);

  return (
    <Panel title="经理操作">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="space-y-1">
          <div className="text-[11px] text-faint">阵容</div>
          <Button
            size="sm"
            variant="primary"
            disabled={isStarterHere}
            title={
              isStarterHere
                ? `已是${POSITION_LABEL[p.position]}首发`
                : occupant
                  ? `替换当前首发 ${occupant.handle}（${occupant.handle} 转为替补或与其互换位置）`
                  : `设为${POSITION_LABEL[p.position]}首发`
            }
            onClick={() => void call('setPlayerAsStarter', p.id)}
          >
            {isStarterHere ? '✓ 本位置首发' : `设为首发（${POSITION_LABEL[p.position]}）`}
          </Button>
        </div>

        <div className="space-y-1">
          <div className="text-[11px] text-faint">
            续约{!temp && ask > 0 && <>（选手要价 <Gold value={ask} />/回合）</>}
            {loyalty < CONFIG.market.renewRefuseLoyalty && <span className="ml-1 text-bad">归属感偏低，可能拒绝</span>}
          </div>
          {canKeepPay && (
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-faint">报价</span>
              <Button
                size="xs"
                variant={offerKeep ? 'secondary' : 'gold'}
                title="满足选手的续约要价"
                onClick={() => setKeepPay(false)}
              >
                满足要价
              </Button>
              <Button
                size="xs"
                variant={offerKeep ? 'gold' : 'secondary'}
                title={`维持现薪 ${formatGold(current)}/回合：若低于他的心理预期，他会拒绝续约（可改为满足要价再谈）`}
                onClick={() => setKeepPay(true)}
              >
                维持现薪
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {renewOptions.map((n) => {
              const until = Math.min(Math.max(p.contractUntil, ti - 1) + n, ti + maxS);
              const noGain = until <= p.contractUntil;
              const pay = offerKeep ? current : ask;
              const reason = temp
                ? '临时替补无法续约'
                : noGain
                  ? `合同已达最长期限（TI${p.contractUntil}）`
                  : `续约后合同至 TI${until}，工资 ${formatGold(pay)}/回合${offerKeep ? '（维持现薪，可能被拒绝）' : ''}`;
              return (
                <Button
                  key={n}
                  size="sm"
                  disabled={temp || noGain}
                  title={reason}
                  onClick={() => void call('renewContract', p.id, n, offerKeep ? current : null)}
                >
                  续约 {n} 赛季
                </Button>
              );
            })}
          </div>
        </div>

        {freeRookie ? (
          <div className="space-y-1">
            <div className="text-[11px] text-faint">本届选秀新秀 · 赛季初免费放弃（无补偿、不扣荣誉）</div>
            <ConfirmButton
              size="sm"
              variant="danger"
              title="赛季初可免费放弃本届选秀中选中的新秀，他将以自由选手身份寻找新东家"
              confirm={{
                title: `放弃新秀 ${p.handle}？`,
                message: '他将进入自由市场（无费用、不扣荣誉），其他战队可能签下他。本操作不可撤销。',
                confirmLabel: '确认放弃',
                danger: true,
              }}
              onConfirm={() => void call('releaseDraftedRookie', p.id)}
            >
              放弃新秀
            </ConfirmButton>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="text-[11px] text-faint">
              解约补偿约 <Gold value={comp} />，荣誉 {CONFIG.honor.transfer.releasePenalty}
            </div>
            <ConfirmButton
              size="sm"
              variant="danger"
              disabled={temp || !windowOpen}
              title={temp ? '临时替补会在赛事结束后自动离队' : !windowOpen ? WINDOW_LOCKED : `解约：支付剩余合同补偿 ${formatGold(comp)}，选手成为自由身`}
              confirm={{
                title: `与 ${p.handle} 解约？`,
                message: (
                  <>
                    支付剩余合同补偿 <Gold value={comp} className="text-ink" />
                    {CONFIG.honor.transfer.releasePenalty ? `，荣誉 ${CONFIG.honor.transfer.releasePenalty}（合同已到期不扣）` : ''}；解约后选手成为自由选手。
                  </>
                ),
                confirmLabel: '确认解约',
                danger: true,
              }}
              onConfirm={() => void call('releasePlayer', p.id)}
            >
              解约
            </ConfirmButton>
          </div>
        )}
      </div>

      {offers.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-xs">
          <span className="text-gold">有 {offers.length} 份针对 {p.handle} 的报价待处理：</span>
          {offers.map((o) => (
            <span key={o.id} className="text-ink">
              {game.teams[o.fromTeamId]?.name ?? '未知战队'} <Gold value={o.fee} />
            </span>
          ))}
          <Button size="xs" variant="gold" className="ml-auto" onClick={() => { useGameStore.getState().openPlayer(null); setView('market'); }}>
            去处理
          </Button>
        </div>
      )}
    </Panel>
  );
}

/** 本队选手：归属感管理（加薪 / 一对一谈心） */
function LoyaltyPanel({ game, p }: { game: GameState; p: Player }) {
  const call = useGameStore((s) => s.call);
  const loyalty = safe(() => effectiveAttr(p, 'loyalty'), p.loyalty);
  const talked = safe(() => talkedThisRound(game, p.id), false);
  const chance = safe(() => talkSuccessChance(game), NaN);
  const raised = p.lastRaiseSeason === game.season.ti;
  const low = loyalty < CONFIG.loyalty.leaveThreshold;
  const T = CONFIG.squadOps.talk;
  const mood = safe(() => playerMoodSummary(game, p), null);

  return (
    <Panel title="归属感管理">
      <div className="mb-3 flex items-center gap-3 text-xs">
        <span className="shrink-0 text-faint">当前归属感</span>
        <StatBar value={loyalty} className="flex-1" color={low ? 'bg-bad' : undefined} />
        <span className={cx('w-10 shrink-0 text-right text-sm font-semibold tabular', low ? 'text-bad' : 'text-ink')}>{fmt1(loyalty)}</span>
      </div>

      {mood && (
        <div className="mb-3 rounded-md border border-line/70 bg-panel-3/30 px-2.5 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <span className="text-faint">薪资满意度</span>
              <Chip tone={SALARY_MOOD_TONE[mood.salary]} title="选手对自身薪水的感受：期望随俱乐部荣誉、自身等级与近期冠军/MVP 上升">
                {mood.salaryLabel}
              </Chip>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="text-faint">整体情绪</span>
              <Chip tone={OVERALL_MOOD_TONE[mood.overall]}>{mood.overallLabel}</Chip>
            </span>
          </div>
          {mood.notes.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-mute">
              {mood.notes.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mb-1 flex items-center justify-between text-[11px] text-faint">
        <span title="工资永久上调，缩小与他心理预期的差距；对薪资越不满，加薪越能打动他">加薪（工资永久上调，缓解薪资不满）</span>
        <span className={cx(raised && 'text-gold')}>{raised ? `TI${game.season.ti} 已加薪` : '每赛季限一次'}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {CONFIG.squadOps.raisePcts.map((rp) => {
          const pv = safe(() => raiseSalaryPreview(game, p.id, rp), null);
          const allowed = !!pv?.allowed;
          const reason = pv?.reason || '无法加薪';
          return (
            <div key={rp} className={cx('rounded-md border px-2 py-1.5', allowed ? 'border-line bg-panel-3/40' : 'border-line/60 bg-panel-3/20 opacity-70')}>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-bold text-gold">+{rp}%</span>
                <span className="text-[11px] text-good tabular">归属 +{fmt1(pv?.loyaltyGain ?? 0)}</span>
              </div>
              <div className="mt-0.5 truncate text-[11px] text-mute">
                工资 <Gold value={pv?.newSalary ?? 0} />
                <span className="text-faint">/回合</span>
              </div>
              {pv && (
                <div className="mt-0.5 truncate text-[11px]" title="加薪后的薪资满意度（定性）">
                  <span className="text-faint">满意度 → </span>
                  <span className={cx(pv.moodAfter === 'satisfied' ? 'text-good' : pv.moodAfter === 'mild' ? 'text-gold' : 'text-bad')}>
                    {SALARY_MOOD_LABEL[pv.moodAfter]}
                  </span>
                </div>
              )}
              <Button
                size="xs"
                variant="gold"
                className="mt-1 w-full"
                disabled={!allowed}
                title={allowed ? `工资 ${formatGold(p.salary || 0)} → ${formatGold(pv?.newSalary ?? 0)}/回合，归属感约 +${fmt1(pv?.loyaltyGain ?? 0)}` : reason}
                onClick={() => void call('raiseSalary', p.id, rp)}
              >
                加薪 {rp}%
              </Button>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button
          size="sm"
          variant="primary"
          disabled={talked}
          title={talked ? '本回合已经和他谈过心了，下回合再聊' : `免费；成功率 ${pct(chance)}，成功时归属感 +${T.successGain[0]}~${T.successGain[1]}（越高收益越小）`}
          // 谈心已进行但未成功：引擎 talkWithPlayer 转为 ok=false，提示条按「未成功」样式显示
          onClick={() => void call('talkWithPlayer', p.id)}
        >
          {talked ? '✓ 本回合已谈心' : '一对一谈心'}
        </Button>
        <span className="text-xs text-mute">
          成功率 <span className="font-semibold text-ink tabular">{pct(chance)}</span>
          <span className="text-faint">（教练灵性与俱乐部荣誉越高越容易）</span>
        </span>
      </div>
      <div className="mt-2 text-[11px] leading-relaxed text-faint">
        谈心免费、每回合一次：失败通常没有影响，但归属感低于 {T.failPenaltyBelow} 时会再降 {Math.abs(T.failPenalty)}。
        归属感越接近 100，各项操作的提升越小。全队团建可在「阵容」页安排。
      </div>
    </Panel>
  );
}

/** 本队选手：挂牌转会（设置标价挂牌 / 挂牌状态与报价 / 撤销挂牌） */
function ListingPanel({ game, p, windowOpen }: { game: GameState; p: Player; windowOpen: boolean }) {
  const call = useGameStore((s) => s.call);
  const S = CONFIG.squadOps;
  const listing = safe(() => activeListing(game, p), null);
  const value = safe(() => marketValue(game, p), 0);
  const [mult, setMult] = useState(1);
  const price = roundFee(value * mult);
  const outlook = safe(() => listingBidOutlook(game, p.id, listing ? undefined : price), null);
  const offers = safe(() => listingOffers(game, p.id), []);
  // 本回合结束时：是否计时 / 是否可能收到新报价（与引擎 processTransferListings 同一判定）
  const status = safe(() => listingRoundStatus(game), { counts: windowOpen, bids: windowOpen, note: '' });
  const durationLabel = safe(() => listingDurationLabel(), '一整个赛季');
  const rule = (
    <div className="mt-2 text-[11px] leading-relaxed text-faint">
      挂牌期为{durationLabel}：每个常规赛回合结束时计一次（赛季初与 TI 阶段转会锁定期间不计时），在下赛季的同一时间点到期。
      其他俱乐部可能在回合结束时报价：标价越低、选手越抢手，越容易收到报价；前 {S.listingFreshRolls} 次报价机会之后，标价高于身价的挂牌挂得越久，报价意愿越低（撤牌后不久重新挂牌，次数继续累计）。
      报价出现在「转会市场 → 我的挂牌 / 收到的报价」；常规赛最后一回合结束后转会窗口锁定，未处理的报价作废。
      <span className="text-gold">若整个挂牌期都没有收到任何报价，到期自动解约成为自由选手（不支付解约补偿、不扣荣誉）；收到过报价（含普通求购报价）但未成交，则挂牌期满后挂牌结束、选手留队。</span>
    </div>
  );

  if (listing) {
    const ratio = value > 0 ? listing.askingPrice / value : NaN;
    const prog = safe(() => listingProgress(listing), { roundsLeft: listing.roundsLeft, totalRounds: listing.roundsLeft, bidRolls: 0 });
    const left = prog.roundsLeft;
    const noBidThisRound = !status.bids;
    // 收到过报价：到期不会自动解约（挂牌结束、选手留队）
    const safeAtExpiry = !!listing.hadBids;
    return (
      <Panel title={<span className="flex items-center gap-2">挂牌转会 <Chip tone="gold">挂牌中</Chip></span>}>
        <div className="grid grid-cols-3 gap-2 text-sm">
          <Info label="标价">
            <Gold value={listing.askingPrice} />
            {Number.isFinite(ratio) && <span className="ml-1 text-[11px] text-faint">{Math.round(ratio * 100)}%</span>}
          </Info>
          <Info label="剩余挂牌期">
            {left > 0 ? (
              <span
                className={cx('font-semibold tabular', left <= 1 && !safeAtExpiry ? 'text-bad' : 'text-ink')}
                title={
                  `挂牌期 ${prog.totalRounds} 个转会回合（TI 锁定期间暂停）` +
                  (safeAtExpiry ? '。已收到过报价：挂牌期满后挂牌结束、选手留队' : '。整个挂牌期没有收到任何报价将自动解约（无补偿）')
                }
              >
                {left} / {prog.totalRounds} 回合
              </span>
            ) : (
              <span className="font-semibold text-bad" title="挂牌期已满：处理完待定报价后挂牌结束、选手留队">
                已到期
              </span>
            )}
          </Info>
          <Info label="每回合报价概率">
            <span
              className="tabular"
              title={
                noBidThisRound
                  ? status.note || '本回合结束时不会收到新报价'
                  : outlook && outlook.stale < 1
                    ? `挂牌较久且标价高于身价，俱乐部报价意愿下降（× ${outlook.stale.toFixed(2)}）`
                    : undefined
              }
            >
              {left > 0 && outlook && !noBidThisRound ? pct(outlook.chance) : '—'}
            </span>
            {left > 0 && outlook && outlook.stale < 1 && outlook.interested > 0 && !noBidThisRound && (
              <span className="ml-1 text-[10px] text-gold">挂牌较久</span>
            )}
          </Info>
        </div>
        <div className="mt-1 text-[11px] text-faint">
          {safe(() => listingListedAtLabel(listing), `TI${listing.season} 挂牌`)}
          {safeAtExpiry && left > 0 && <span className="ml-1 text-good">· 已收到过报价·到期不解约</span>}
          {status.note && <span className="ml-1 text-info">· {status.note}</span>}
        </div>

        <div className="mt-3 space-y-1.5">
          <div className="text-[11px] text-faint">收到的报价（{offers.length}）</div>
          {offers.length === 0 ? (
            <div className="rounded border border-line/60 px-2 py-1.5 text-xs text-faint">暂无报价</div>
          ) : (
            offers.map((o) => {
              const buyer = game.teams[o.fromTeamId];
              return (
                <div key={o.id} className="flex flex-wrap items-center gap-2 rounded border border-gold/40 bg-gold/10 px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    {buyer ? <TeamLink teamId={buyer.id} name={buyer.name} className="font-medium" /> : '未知战队'}
                    <span className="ml-2"><Gold value={o.fee} className="font-semibold" /></span>
                    <span className="ml-1 text-faint">· 新工资 {formatGold(o.salary)}</span>
                  </span>
                  <ConfirmButton
                    size="xs"
                    variant="gold"
                    disabled={!windowOpen}
                    title={windowOpen ? '接受报价，选手转出' : WINDOW_LOCKED}
                    confirm={{
                      title: `出售 ${p.handle}？`,
                      message: (
                        <>
                          以 <Gold value={o.fee} className="font-semibold text-ink" /> 出售给 {buyer?.name ?? '对方战队'}，新工资 {formatGold(o.salary)}/回合。
                        </>
                      ),
                      confirmLabel: '确认出售',
                    }}
                    onConfirm={() => void call('respondToOffer', o.id, true)}
                  >
                    接受
                  </ConfirmButton>
                  <Button size="xs" variant="danger" onClick={() => void call('respondToOffer', o.id, false)}>
                    拒绝
                  </Button>
                </div>
              );
            })
          )}
        </div>

        <div className="mt-3">
          <Button size="sm" onClick={() => void call('unlistPlayer', p.id)} title="从转会名单撤下，选手继续留队">
            撤销挂牌
          </Button>
        </div>
        {rule}
      </Panel>
    );
  }

  const [minM, maxM] = S.listingPriceRange;
  const reason = !windowOpen ? WINDOW_LOCKED : !(price > 0) ? '身价数据异常，无法挂牌' : '';
  return (
    <Panel title="挂牌转会">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-[11px] text-faint">
          标价（身价 <Gold value={value} /> 的 {Math.round(mult * 100)}%）
        </span>
        <Gold value={price} className="text-base font-semibold" />
      </div>
      <input
        type="range"
        min={minM}
        max={maxM}
        step={0.05}
        value={mult}
        onChange={(e) => setMult(Number(e.target.value) || 1)}
        className="mt-1 w-full cursor-pointer accent-[var(--color-gold)]"
        aria-label="挂牌标价（身价倍数）"
      />
      <div className="flex justify-between text-[10px] text-faint tabular">
        <span>{Math.round(minM * 100)}%</span>
        <span>100%</span>
        <span>{Math.round(maxM * 100)}%</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {[0.8, 1, 1.2, 1.5].map((m) => (
          <Button key={m} size="xs" variant={Math.abs(mult - m) < 0.001 ? 'primary' : 'secondary'} onClick={() => setMult(m)}>
            ×{m}
          </Button>
        ))}
      </div>
      <div className="mt-2 text-xs text-mute">
        预计每回合收到报价概率 <span className="font-semibold text-ink tabular">{outlook ? pct(outlook.chance) : '—'}</span>
        <span className="text-faint">（有意向且负担得起的俱乐部 {outlook?.interested ?? 0} 家）</span>
        {outlook && outlook.stale < 1 && outlook.interested > 0 && (
          <span
            className="ml-1 text-[10px] text-gold"
            title={`近期撤过牌：此前挂牌已经历的报价机会继续累计，标价高于身价时报价意愿下降（× ${outlook.stale.toFixed(2)}）`}
          >
            挂牌较久
          </span>
        )}
      </div>
      <div className="mt-2">
        <Button
          size="sm"
          variant="gold"
          disabled={!!reason}
          title={reason || `以 ${formatGold(price)} 挂牌，挂牌期为${durationLabel}`}
          onClick={() => void call('listPlayerForTransfer', p.id, price)}
        >
          挂牌出售
        </Button>
      </div>
      {rule}
    </Panel>
  );
}

/** 其他战队选手：报价求购 */
function BidActions({ game, p, seller, myTeam }: { game: GameState; p: Player; seller: Team; myTeam: Team }) {
  const call = useGameStore((s) => s.call);
  const value = safe(() => marketValue(game, p), 0);
  const suggested = safe(() => suggestedFee(game, p.id), Math.round(value * CONFIG.market.suggestedFeeBase));
  const [fee, setFee] = useState<number>(suggested || value);
  const windowOpen = safe(() => isTransferWindowOpen(game), false);
  // 只有达到绝对上限才不能报价；超出常规上限只做提示
  const rosterBlock = safe<string | null>(() => rosterSigningBlock(game, myTeam.id), null);
  const overNote = safe<string | null>(() => rosterSigningNote(game, myTeam.id), null);
  const will = safe(() => playerWillingness(game, p.id, myTeam.id), NaN);
  const step = CONFIG.market.feeRounding;
  const wild = !!p.tempSubUntilTournament || !!p.isWildSub;

  const reason = !windowOpen
    ? WINDOW_LOCKED
    : seller.disbanded
      ? '原战队已解散'
      : wild
        ? '临时替补无法转会'
        : !(fee > 0)
          ? '请输入有效的报价金额'
          : myTeam.gold < fee
            ? `金币不足（账上 ${formatGold(myTeam.gold)}）`
            : rosterBlock ?? '';

  const setRounded = (v: number) => setFee(Math.max(0, Math.round(v / step) * step));

  return (
    <Panel title={`向 ${seller.name} 报价求购`}>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Info label="身价">
            <Gold value={value} />
          </Info>
          <Info label="建议报价">
            <Gold value={suggested} />
          </Info>
          <Info label="我方资金">
            <Gold value={myTeam.gold} />
          </Info>
          <Info label="加盟意愿">
            <WillBar value={will} />
          </Info>
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={0}
              step={step}
              value={Number.isFinite(fee) ? fee : 0}
              onChange={(e) => setFee(Math.max(0, Number(e.target.value) || 0))}
              className="w-36 rounded-md border border-line bg-panel-2 px-2 py-1 text-sm tabular text-ink [color-scheme:dark] focus:border-dota focus:outline-none"
              aria-label="报价金额"
            />
            <span className="text-xs text-mute">≈ {formatGold(fee)}</span>
            <Button
              variant="gold"
              size="sm"
              disabled={!!reason}
              title={reason || `出价 ${formatGold(fee)} 求购 ${p.handle}${overNote ? `\n${overNote}` : ''}`}
              onClick={() => void call('bidForPlayer', p.id, fee)}
            >
              发出报价
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" onClick={() => setRounded(value)}>身价</Button>
            <Button size="xs" onClick={() => setRounded(suggested)}>建议价</Button>
            <Button size="xs" onClick={() => setRounded(suggested * 1.2)}>建议价 ×1.2</Button>
            <Button size="xs" onClick={() => setRounded(fee * 0.9)}>−10%</Button>
            <Button size="xs" onClick={() => setRounded(fee * 1.1)}>+10%</Button>
          </div>
          <div className="text-[11px] leading-relaxed text-faint">
            报价越高于身价、选手在原队越不重要、归属感越低，对方越可能放人；之后还需选手本人愿意加盟。同一回合内重复谈判结果相同。
          </div>
          {!reason && overNote && <div className="text-[11px] leading-relaxed text-gold">{overNote}。</div>}
        </div>
      </div>
    </Panel>
  );
}

/** 自由选手：签约 */
function FreeAgentActions({ game, p, myTeam, onClose }: { game: GameState; p: Player; myTeam: Team; onClose: () => void }) {
  const call = useGameStore((s) => s.call);
  const setView = useGameStore((s) => s.setView);
  const tempCand = (game.tempSubCandidates ?? []).includes(p.id) || !!p.isWildSub;

  if (tempCand) {
    return (
      <Panel title="签约">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-mute">
          <span>野外替补候选，只能在赛事前通过「临时招募」雇佣，仅效力一项赛事。</span>
          <Button size="sm" onClick={() => { setView('market'); onClose(); }}>
            前往转会市场
          </Button>
        </div>
      </Panel>
    );
  }

  const value = safe(() => marketValue(game, p), 0);
  const step = CONFIG.market.feeRounding;
  const fee = value > 0 ? Math.max(step, Math.round((value * CONFIG.economy.signingFeeRatio) / step) * step) : 0;
  const will = safe(() => playerWillingness(game, p.id, myTeam.id), NaN);
  const windowOpen = safe(() => isTransferWindowOpen(game), false);
  // 只有达到绝对上限才不能签约；超出常规上限只做提示
  const rosterBlock = safe<string | null>(() => rosterSigningBlock(game, myTeam.id), null);
  const overNote = safe<string | null>(() => rosterSigningNote(game, myTeam.id), null);
  const reason = !windowOpen
    ? WINDOW_LOCKED
    : rosterBlock
      ? rosterBlock
      : myTeam.gold < fee
        ? `金币不足（签字费约 ${formatGold(fee)}）`
        : '';

  return (
    <Panel title="签约自由选手">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Info label="签字费（约）">
          <Gold value={fee} />
        </Info>
        <Info label="身价">
          <Gold value={value} />
        </Info>
        <Info label="我方资金">
          <Gold value={myTeam.gold} />
        </Info>
        <div className="min-w-48 flex-1">
          <Info label="加盟意愿">
            <WillBar value={will} />
          </Info>
        </div>
        <Button
          variant="gold"
          disabled={!!reason}
          title={reason || `支付约 ${formatGold(fee)} 签字费签下 ${p.handle}${overNote ? `\n${overNote}` : ''}`}
          onClick={() => void call('signFreeAgent', p.id)}
        >
          签约
        </Button>
      </div>
      <div className="mt-2 text-[11px] text-faint">
        意愿取决于俱乐部荣誉与选手等级期待；按意愿概率决定是否接受，同一回合内重复邀约结果相同。签下高等级选手可提升荣誉。
      </div>
      {!reason && overNote && <div className="mt-1 text-[11px] text-gold">{overNote}。</div>}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------
function Panel({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel-2/40">
      <div className="border-b border-line/70 px-3 py-1.5 text-xs font-semibold tracking-wide text-mute">{title}</div>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** wrap：内容可换行（如带副位置的位置徽章），默认单行截断 */
function Info({ label, children, wrap }: { label: ReactNode; children: ReactNode; wrap?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-faint">{label}</div>
      <div className={wrap ? 'mt-0.5 min-w-0' : 'mt-0.5 truncate'}>{children}</div>
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-md border border-line bg-panel-3/40 px-2 py-1.5">
      <div className="text-[10px] text-faint">{label}</div>
      <div className={cx('text-base font-semibold tabular', tone)}>{value}</div>
    </div>
  );
}

function WillBar({ value }: { value: number }) {
  if (!Number.isFinite(value)) return <span className="text-faint">—</span>;
  const color = value >= 0.6 ? 'bg-good' : value >= 0.35 ? 'bg-gold' : 'bg-bad';
  return (
    <span className="flex items-center gap-2">
      <StatBar value={value * 100} color={color} className="w-24" />
      <span className={cx('tabular text-sm font-semibold', value >= 0.6 ? 'text-good' : value >= 0.35 ? 'text-gold' : 'text-bad')}>
        {pct(value)}
      </span>
    </span>
  );
}


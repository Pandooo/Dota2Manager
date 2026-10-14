// 教练页：现任教练、教练市场（可排序/筛选/签约；第九波：标记本赛季新到教练、按等级 / S+ / 新到筛选）、教练作用说明
import { useState, type ReactNode } from 'react';
import { useCall, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, TIERS, ageOf, coachMarket, coachSigningFee, econ, formatGold, getCoach, getPlayerTeam,
  isTransferWindowOpen, tierIndex,
} from '../../engine';
import type { Coach as CoachT, GameState, Team, Tier } from '../../engine';
import {
  AttrRow, Button, Card, EmptyState, Gold, PlayerLink, TeamLink, TierBadge, cx,
} from '../components/common';
import { ScreenHeader } from '../layout/HubKit';
import { Chip, Flag, MiniBar, SortTh, countryName, fmt1, safe, sortList, useSort } from '../components/SquadShared';
import { ConfirmButton } from '../components/ConfirmPopover';

type SortKey = 'name' | 'age' | 'tier' | 'insight' | 'talent' | 'resilience' | 'salary' | 'fee';
/** 等级筛选：全部 / 单一等级 / S 级及以上 */
type TierFilter = Tier | 'all' | 'top';
const BOOST_MAX = 10;
const WINDOW_LOCKED = '转会窗口已锁定（TI 预选与正赛阶段），TI 结束后才能更换教练';

/** 签约费（以引擎 coachSigningFee 为准） */
function feeOf(c: CoachT): number {
  return safe(() => coachSigningFee(c), Math.round(Math.max(0, c.salary || 0) * CONFIG.season.coachSigningFeeSalaryMult));
}

export default function Coach() {
  const game = useGame();
  const call = useCall();
  const setView = useGameStore((s) => s.setView);
  const sort = useSort<SortKey>('tier', 'desc');
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [affordOnly, setAffordOnly] = useState(false);
  const [newOnly, setNewOnly] = useState(false);

  const team = safe(() => getPlayerTeam(game), null as Team | null);
  if (!team) {
    return (
      <Card title="教练">
        <EmptyState text="找不到玩家战队数据，请重新读取存档。" />
      </Card>
    );
  }

  const coach = safe(() => getCoach(game, team.id), null as CoachT | null);
  const windowOpen = safe(() => isTransferWindowOpen(game), true);
  const market = safe(
    () => coachMarket(game),
    Object.values(game.coaches).filter((c) => !c.teamId),
  ).filter((c) => c && c.id !== coach?.id);

  const sortValue = (c: CoachT): number | string => {
    switch (sort.key) {
      case 'name': return c.name.toLowerCase();
      case 'age': return ageOf(game, c);
      case 'tier': return safe(() => tierIndex(c.tier), 0) * 1000 + c.insight;
      case 'insight': return c.insight;
      case 'talent': return c.talentBoost;
      case 'resilience': return c.resilienceBoost;
      case 'salary': return c.salary;
      case 'fee': return feeOf(c);
    }
  };
  // 第九波教练供给：本赛季新到（coaches.ts 在赛季初标记 arrivedTi）
  const seasonTi = game.season?.ti;
  const isNew = (c: CoachT) => typeof c.arrivedTi === 'number' && c.arrivedTi === seasonTi;
  const topIdx = safe(() => tierIndex(CONFIG.coachSupply?.topTier ?? 'S'), 3);
  const isTop = (c: CoachT) => safe(() => tierIndex(c.tier), 0) >= topIdx;
  const tierOk = (c: CoachT) => tierFilter === 'all' || (tierFilter === 'top' ? isTop(c) : c.tier === tierFilter);
  const filtered = market.filter((c) => tierOk(c) && (!newOnly || isNew(c)) && (!affordOnly || feeOf(c) <= team.gold));
  const rows = sortList(filtered, sortValue, sort.dir);
  const tierCounts = TIERS.map((t) => ({ t, n: market.filter((c) => c.tier === t).length }));
  const topCount = market.filter(isTop).length;
  const newCount = market.filter(isNew).length;
  const supply = game.coachSupply && game.coachSupply.ti === seasonTi ? game.coachSupply : null;

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="教练"
        subtitle={`${team.name} · 教练${coach ? `：${coach.name}` : '岗位空缺'} · 市场可签 ${market.length} 人`}
        nav={
          <>
            <Button variant="ghost" size="sm" onClick={() => setView('training')}>训练</Button>
            <Button variant="ghost" size="sm" onClick={() => setView('squad')}>阵容</Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <CurrentCoachCard game={game} team={team} coach={coach} windowOpen={windowOpen} onFire={() => void call('fireCoach')} />
        <ExplainCard game={game} />
      </div>

      <Card
        title={
          <>
            教练市场 <span className="ml-1 text-mute tabular">{filtered.length}/{market.length}</span>
          </>
        }
        subtitle={
          windowOpen ? (
            `签约费 = 工资 × ${CONFIG.season.coachSigningFeeSalaryMult}${coach ? '；签约新教练后现任教练离队' : ''} · 我方资金 ${formatGold(team.gold)}`
          ) : (
            <span className="text-gold">{WINDOW_LOCKED}</span>
          )
        }
        bodyClassName="p-0"
        actions={
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <FilterBtn active={tierFilter === 'all'} onClick={() => setTierFilter('all')}>
              全部
            </FilterBtn>
            {tierCounts.map(({ t, n }) => (
              <FilterBtn key={t} active={tierFilter === t} onClick={() => setTierFilter(t)} disabled={n === 0}>
                {t}
                <span className="ml-0.5 text-faint">{n}</span>
              </FilterBtn>
            ))}
            <FilterBtn active={tierFilter === 'top'} onClick={() => setTierFilter(tierFilter === 'top' ? 'all' : 'top')} disabled={topCount === 0} title="只看 S 级及以上">
              S+
              <span className="ml-0.5 text-faint">{topCount}</span>
            </FilterBtn>
            <FilterBtn
              active={newOnly}
              onClick={() => setNewOnly(!newOnly)}
              disabled={newCount === 0 && !newOnly}
              title={newCount ? '只看本赛季新进入市场的教练' : '本赛季暂无新到教练'}
              tone="gold"
            >
              新到
              <span className="ml-0.5 text-faint">{newCount}</span>
            </FilterBtn>
            <label className="ml-1 flex cursor-pointer items-center gap-1 text-mute">
              <input type="checkbox" checked={affordOnly} onChange={(e) => setAffordOnly(e.target.checked)} className="accent-[#c23c2a]" />
              负担得起
            </label>
          </div>
        }
      >
        {supply && supply.added > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-xs text-mute">
            <span className="font-semibold text-gold">本赛季新增 {supply.added} 名教练</span>
            {supply.generated > 0 && <span>新人教练 {supply.generated}</span>}
            {supply.real > 0 && <span>知名教练 {supply.real}</span>}
            {supply.retired > 0 && <span>退役选手转任 {supply.retired}</span>}
            {supply.other > 0 && <span>其他自由教练 {supply.other}</span>}
            <span className="text-faint">每个赛季开始时都会有一批教练进入市场</span>
          </div>
        )}
        {market.length === 0 ? (
          <EmptyState text="教练市场暂时没有可签约的教练。每个赛季开始时会有新教练进入市场，选手退役后也可能转型为教练。" />
        ) : rows.length === 0 ? (
          <EmptyState text="没有符合筛选条件的教练。" />
        ) : (
          <div className="max-h-[560px] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <SortTh k="name" sort={sort} defaultDir="asc">教练</SortTh>
                  <SortTh k="age" sort={sort} className="num" defaultDir="asc">年龄</SortTh>
                  <SortTh k="tier" sort={sort}>等级</SortTh>
                  <SortTh k="insight" sort={sort} className="num">灵性</SortTh>
                  <SortTh k="talent" sort={sort} title="训练时提升队员天赋的幅度（0–10；每个休赛回合第一次训练全额，额外训练按比例折算）">天赋提升</SortTh>
                  <SortTh k="resilience" sort={sort} title="训练时提升队员韧性的幅度（0–10；每个休赛回合第一次训练全额，额外训练按比例折算）">韧性提升</SortTh>
                  <SortTh k="salary" sort={sort} className="num">工资/回合</SortTh>
                  <SortTh k="fee" sort={sort} className="num">签约费</SortTh>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const fee = feeOf(c);
                  const lacking = team.gold < fee;
                  const why = !windowOpen
                    ? WINDOW_LOCKED
                    : lacking
                      ? `金币不足（签约费 ${formatGold(fee)}，账上 ${formatGold(team.gold)}）`
                      : '';
                  const former = c.formerPlayerId ? game.players[c.formerPlayerId] : undefined;
                  const ownAlumni = !!former && former.lastTeamId === team.id;
                  const fresh = isNew(c);
                  return (
                    <tr key={c.id} className={fresh ? 'bg-gold/[0.04]' : undefined}>
                      <td>
                        <span className="inline-flex items-center gap-1.5">
                          <Flag cc={c.nationality} />
                          <span className="font-medium">{c.name}</span>
                          {fresh && (
                            <Chip tone="gold" title={`TI${seasonTi} 赛季开始时新进入教练市场`}>
                              新到
                            </Chip>
                          )}
                          {former && (
                            <Chip tone={ownAlumni ? 'gold' : 'mute'} title={`由退役选手 ${former.handle} 转型${ownAlumni ? '（本队旧将）' : ''}`}>
                              {ownAlumni ? '旧将' : '前选手'}
                            </Chip>
                          )}
                        </span>
                      </td>
                      <td className="num">{ageOf(game, c)}</td>
                      <td>
                        <TierBadge tier={c.tier} />
                      </td>
                      <td className="num">
                        {fmt1(c.insight)}
                        <Cmp v={c.insight} base={coach?.insight} />
                      </td>
                      <td>
                        <BoostCell v={c.talentBoost} base={coach?.talentBoost} color="bg-tier-s" />
                      </td>
                      <td>
                        <BoostCell v={c.resilienceBoost} base={coach?.resilienceBoost} color="bg-info" />
                      </td>
                      <td className="num">
                        <Gold value={c.salary || 0} />
                      </td>
                      <td className="num">
                        <Gold value={fee} className={lacking ? 'text-bad' : undefined} />
                      </td>
                      <td className="text-right">
                        {coach ? (
                          <ConfirmButton
                            variant="secondary"
                            size="xs"
                            disabled={!!why}
                            title={why || `签约费 ${formatGold(fee)}；现任教练 ${coach.name} 将离队`}
                            confirm={{
                              title: `签约 ${c.name}？`,
                              message: (
                                <>
                                  支付签约费 <Gold value={fee} className="text-ink" />，工资 <Gold value={c.salary || 0} className="text-ink" />/回合；
                                  现任教练 <span className="text-ink">{coach.name}</span> 将离队。
                                </>
                              ),
                              confirmLabel: `支付 ${formatGold(fee)}`,
                            }}
                            onConfirm={() => void call('hireCoach', c.id)}
                          >
                            替换
                          </ConfirmButton>
                        ) : (
                          <Button size="xs" variant="gold" disabled={!!why} title={why || `支付签约费 ${formatGold(fee)} 签下 ${c.name}`} onClick={() => void call('hireCoach', c.id)}>
                            签约
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 现任教练
// ---------------------------------------------------------------------------
function CurrentCoachCard({
  game,
  team,
  coach,
  windowOpen,
  onFire,
}: {
  game: GameState;
  team: Team;
  coach: CoachT | null;
  windowOpen: boolean;
  onFire: () => void;
}) {
  if (!coach) {
    return (
      <Card title="现任教练">
        <EmptyState text="教练岗位空缺。">
          <div className="max-w-md text-xs leading-relaxed text-faint">
            没有教练时，队员只能靠年轻时的自然增长提升天赋，韧性无法通过训练提升，BP 也缺少教练的灵性加成。从下方教练市场签约一名教练吧。
          </div>
        </EmptyState>
      </Card>
    );
  }
  const age = ageOf(game, coach);
  const former = coach.formerPlayerId ? game.players[coach.formerPlayerId] : undefined;
  const k = CONFIG.coach;
  const ratingBonus = Math.max(0, coach.insight) * k.ratingBonusPerInsight;

  return (
    <Card
      title="现任教练"
      actions={
        <ConfirmButton
          size="sm"
          variant="danger"
          disabled={!windowOpen}
          title={windowOpen ? '解雇无需补偿；之后教练岗位空缺，可在转会窗口内从市场签约新教练' : WINDOW_LOCKED}
          confirm={{
            title: `解雇 ${coach.name}？`,
            message: '解雇无需补偿；之后教练岗位空缺，可在转会窗口内从教练市场签约新教练。',
            confirmLabel: '确认解雇',
            danger: true,
          }}
          onConfirm={onFire}
        >
          解雇
        </ConfirmButton>
      }
    >
      <div className="flex flex-wrap gap-5">
        <div className="flex w-36 shrink-0 flex-col items-center gap-2 rounded-lg border border-line bg-panel-2/50 px-3 py-4 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full border border-gold/40 bg-gradient-to-br from-dota/40 to-gold/20 text-2xl font-black text-ink">
            {coach.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="font-semibold leading-tight">{coach.name}</div>
          <TierBadge tier={coach.tier} size="lg" />
          <div className="text-xs text-mute">
            <Flag cc={coach.nationality} /> {countryName(coach.nationality)}
          </div>
          <div className="text-xs text-mute">{age} 岁</div>
        </div>

        <div className="min-w-60 flex-1 space-y-3">
          <div className="space-y-1.5">
            <AttrRow label="灵性" value={coach.insight} digits={1} />
            <BoostRow label="天赋提升" value={coach.talentBoost} color="bg-tier-s" />
            <BoostRow label="韧性提升" value={coach.resilienceBoost} color="bg-info" />
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <Mini label="工资/回合">
              <Gold value={coach.salary || 0} />
            </Mini>
            <Mini label="战队评分">
              <span className="text-good">+{fmt1(ratingBonus)}</span>
            </Mini>
            <Mini label="每回合天赋">
              <span className="text-good">+{(coach.talentBoost * k.talentPerTraining).toFixed(2)}</span>
            </Mini>
            <Mini label="每回合韧性">
              <span className="text-good">+{(coach.resilienceBoost * k.resiliencePerTraining).toFixed(2)}</span>
            </Mini>
          </div>
          <div className="text-xs leading-relaxed text-mute">
            BP 时战队灵性中教练占 {Math.round(k.insightWeightInDraft * 100)}%（首发均值占 {Math.round((1 - k.insightWeightInDraft) * 100)}%）。
            {former ? (
              <span className="ml-1">
                由退役选手 <PlayerLink player={former} className="text-gold" /> 转型
                {former.lastTeamId && game.teams[former.lastTeamId] && (
                  <>
                    （曾效力 <TeamLink teamId={former.lastTeamId} name={game.teams[former.lastTeamId].name} />）
                  </>
                )}
                。
              </span>
            ) : coach.formerPlayerId ? (
              <span className="ml-1">由退役选手转型。</span>
            ) : null}
          </div>
          <div className="text-[11px] text-faint">执教 {team.name}</div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 说明
// ---------------------------------------------------------------------------
function ExplainCard({ game }: { game: GameState }) {
  const k = CONFIG.coach;
  const e = safe(() => econ(game), 1);
  return (
    <Card title="教练的作用" subtitle="按等级的基础幅度（实例 ±30% 浮动）">
      <ul className="space-y-1.5 text-xs leading-relaxed text-mute">
        <li>
          <span className="font-semibold text-ink">训练时提升天赋/韧性：</span>每次训练天赋 += 天赋提升 × {k.talentPerTraining}，韧性 += 韧性提升 × {k.resiliencePerTraining}
          （替补 ×{CONFIG.growth.benchTrainingMult}，越接近 100 越难涨）。每个休赛回合的第一次训练全额，同一回合的额外训练 / 训练赛只按 ×
          {CONFIG.training.extraSessionAttrMult} 计——加练主要提升战力 / 天梯 / 灵性。{CONFIG.aging.talentDeclineStartAge} 岁以上选手只能靠教练提升天赋。
        </li>
        <li>
          <span className="font-semibold text-ink">BP 灵性加成：</span>战队灵性 = 首发灵性均值 × {Math.round((1 - k.insightWeightInDraft) * 100)}% + 教练灵性 ×{' '}
          {Math.round(k.insightWeightInDraft * 100)}%，影响大老师胜率与 BP 推荐质量；战队评分另加 教练灵性 × {k.ratingBonusPerInsight}。
        </li>
        <li>
          <span className="font-semibold text-ink">教练不随年龄变化：</span>年龄仅作展示，属性永久不变。
        </li>
        <li>
          <span className="font-semibold text-ink">退役选手可转教练：</span>选手在 TI 结算时可能退役，并按其天梯等级转为同级教练进入市场；若退役前效力于你的战队，你会收到优先签约的邀请。
        </li>
        <li>
          <span className="font-semibold text-ink">每赛季教练供给：</span>每个赛季开始时，市场会迎来一批新教练（新人教练、当届知名教练与退役选手转任，标记为「新到」），
          赛季初可签约教练不少于 {CONFIG.coachSupply?.minAvailable ?? 8} 名、多于空缺岗位，其中至少 {CONFIG.coachSupply?.minTopTier ?? 3} 名 S 级及以上；
          AI 战队只在没有主教练时聘请，不会把好教练全部签走。
        </li>
      </ul>
      <div className="mt-3 overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>等级</th>
              <th className="num">基础提升</th>
              <th className="num">参考工资/回合</th>
              <th className="num">参考签约费</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((t) => {
              const salary = Math.max(CONFIG.economy.minSalary, Math.round(k.salaryByTier[t] * e));
              return (
                <tr key={t}>
                  <td>
                    <TierBadge tier={t} />
                  </td>
                  <td className="num">{k.boostByTier[t]}</td>
                  <td className="num">
                    <Gold value={salary} />
                  </td>
                  <td className="num">
                    <Gold value={salary * CONFIG.season.coachSigningFeeSalaryMult} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------
function BoostRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 shrink-0 text-mute">{label}</span>
      <MiniBar value={value} max={BOOST_MAX} color={color} className="flex-1" />
      <span className="w-10 shrink-0 text-right tabular">{fmt1(value)}</span>
    </div>
  );
}

function BoostCell({ v, base, color }: { v: number; base?: number; color: string }) {
  return (
    <span className="flex min-w-28 items-center gap-1.5">
      <MiniBar value={v} max={BOOST_MAX} color={color} className="w-14" />
      <span className="w-8 text-right tabular">{fmt1(v)}</span>
      <Cmp v={v} base={base} />
    </span>
  );
}

/** 与现任教练对比的小箭头 */
function Cmp({ v, base }: { v: number; base?: number }) {
  if (base === undefined || !Number.isFinite(base)) return null;
  const d = v - base;
  if (Math.abs(d) < 0.05) return <span className="ml-1 inline-block w-3 text-[10px] text-faint">=</span>;
  return (
    <span className={cx('ml-1 inline-block w-3 text-[10px]', d > 0 ? 'text-good' : 'text-bad')} title={`比现任教练 ${d > 0 ? '+' : ''}${d.toFixed(1)}`}>
      {d > 0 ? '▲' : '▼'}
    </span>
  );
}

function Mini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-panel-2/50 px-2 py-1.5">
      <div className="text-[10px] text-faint">{label}</div>
      <div className="font-semibold tabular">{children}</div>
    </div>
  );
}

function FilterBtn({
  active, onClick, disabled, children, title, tone = 'dota',
}: { active: boolean; onClick: () => void; disabled?: boolean; children: ReactNode; title?: string; tone?: 'dota' | 'gold' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? (title ?? '该等级暂无可签约教练') : title}
      className={cx(
        'cursor-pointer rounded border px-1.5 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? tone === 'gold' ? 'border-gold bg-gold/15 text-ink' : 'border-dota bg-dota/15 text-ink'
          : tone === 'gold' ? 'border-gold/40 text-gold hover:text-ink' : 'border-line text-mute hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

// 转会市场 · 我的挂牌：挂牌中的选手、标价、剩余等待回合、收到的报价（接受/拒绝）、撤销挂牌
import { useCall, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, activeListing, formatGold, listedPlayers, listingBidOutlook, listingOffers, marketValue, overallRating,
  playerTier,
  type Player, type TransferOffer,
} from '../../engine';
import { Badge, Button, Card, EmptyState, Gold, PlayerLink, PosBadge, TeamLink, TierBadge, cx } from './common';
import { ConfirmButton } from './ConfirmPopover';
import { Banner, TableWrap, num, safe } from './MarketKit';

export default function MarketListings({ windowOpen }: { windowOpen: boolean }) {
  const g = useGame();
  const call = useCall();
  const setView = useGameStore((s) => s.setView);
  const me = g.settings.playerTeamId;
  const myTeam = g.teams[me];
  const S = CONFIG.squadOps;

  const listed = safe(() => listedPlayers(g), [] as Player[]);
  const starters = new Set(Object.values(myTeam?.lineup ?? {}).filter(Boolean) as string[]);

  const nextPhase = g.season.rounds?.[g.roundIndex + 1]?.phase;
  const paused =
    g.phase === 'preseason' ? '赛季初不计时，开赛后开始倒计时'
      : !windowOpen ? '转会窗口锁定中，倒计时暂停'
        : nextPhase !== 'regular' && nextPhase !== 'preseason' ? '下回合转会窗口锁定，本回合不计时'
          : '';

  const respond = (id: string, accept: boolean) => {
    void call('respondToOffer', id, accept);
  };

  /** 接受报价的就近确认：到账后金币、荣誉变化、节省工资 */
  const sellConfirm = (o: TransferOffer, p: Player) => {
    const d = CONFIG.honor.transfer.sellTierPenalty[safe(() => playerTier(p), 'C' as const)] ?? 0;
    return {
      title: `出售 ${p.handle}？`,
      confirmLabel: '确认接受',
      message: (
        <>
          以 <Gold value={o.fee} className="font-semibold text-ink" /> 出售给 <span className="text-ink">{g.teams[o.fromTeamId]?.name ?? '对方战队'}</span>。
          <span className="mt-1 grid grid-cols-2 gap-x-3">
            <span>到账后 <Gold value={num(myTeam?.gold) + o.fee} className="text-ink" /></span>
            <span>荣誉 <span className={cx('tabular', d < 0 ? 'text-bad' : 'text-faint')}>{d < 0 ? d : '无变化'}</span></span>
          </span>
          <span className="mt-0.5 block text-faint">节省工资 {formatGold(num(p.salary))}/回合。</span>
        </>
      ),
    };
  };

  return (
    <div className="space-y-4">
      <Banner tone="gold" title={`挂牌规则：等待 ${S.listingRounds} 个转会回合，无人报价则自动解约`}>
        挂牌后选手进入转会名单，其他俱乐部每回合结束时可能报价：标价越低（相对身价）、选手等级越高、越符合对方需求，越容易收到报价。
        每回合结束时计一次（赛季初、TI 阶段转会锁定期间不计时）。若整个挂牌期都无人报价，到期自动解约成为自由选手——不支付解约补偿、不扣俱乐部荣誉；收到过报价但未成交，则挂牌结束、选手留队。
        {paused && <span className="ml-1 font-semibold">当前：{paused}。</span>}
      </Banner>

      <Card
        title="挂牌中的选手"
        subtitle="在选手详情中设置标价挂牌，或在「阵容」页多选后批量挂牌（标价 = 身价）"
        bodyClassName="p-0"
        actions={<Button size="xs" variant="ghost" onClick={() => setView('squad')}>前往阵容</Button>}
      >
        {listed.length === 0 ? (
          <EmptyState text="目前没有挂牌出售的选手。">
            <span className="text-xs text-faint">想清理阵容又不想支付解约补偿？挂牌出售是更划算的选择。</span>
          </EmptyState>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>选手</th>
                  <th>等级</th>
                  <th className="num">评分</th>
                  <th className="num">身价</th>
                  <th className="num" title="标价 / 身价">标价</th>
                  <th className="num">剩余</th>
                  <th className="num" title="每回合结束时收到报价的概率（估算）">报价概率</th>
                  <th>收到的报价</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {listed.map((p) => {
                  const L = activeListing(g, p);
                  if (!L) return null;
                  const value = safe(() => marketValue(g, p), 0);
                  const ratio = value > 0 ? L.askingPrice / value : null;
                  const outlook = safe(() => listingBidOutlook(g, p.id), null);
                  const offers = safe(() => listingOffers(g, p.id), []);
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <PlayerLink player={p} />
                          <PosBadge pos={p.position} />
                          {starters.has(p.id) && <Badge className="bg-info/15 text-info">首发</Badge>}
                        </div>
                      </td>
                      <td><TierBadge tier={safe(() => playerTier(p), 'C' as const)} /></td>
                      <td className="num">{safe(() => overallRating(p), 0).toFixed(1)}</td>
                      <td className="num"><Gold value={value} /></td>
                      <td className="num">
                        <Gold value={L.askingPrice} className="font-semibold" />
                        {ratio !== null && (
                          <span className={cx('ml-1 text-[10px]', ratio <= 1 ? 'text-good' : 'text-bad')}>{Math.round(ratio * 100)}%</span>
                        )}
                      </td>
                      <td
                        className={cx('num text-xs', L.roundsLeft <= 1 ? 'text-bad font-semibold' : 'text-mute')}
                        title={
                          L.roundsLeft <= 0
                            ? '等待期已满：待处理报价处理后挂牌结束（收到过报价则选手留队）'
                            : paused || `第 ${g.roundIndex} 回合挂牌倒计时进行中`
                        }
                      >
                        {L.roundsLeft <= 0 ? '已到期' : `${L.roundsLeft} 回合${paused ? '（暂停）' : ''}`}
                      </td>
                      <td className="num text-xs">
                        {outlook && L.roundsLeft > 0 ? `${Math.round(outlook.chance * 100)}%` : '—'}
                        {outlook && L.roundsLeft > 0 && (
                          <span className="ml-1 text-[10px] text-faint" title="有意向且负担得起的俱乐部">{outlook.interested} 家</span>
                        )}
                      </td>
                      <td>
                        {offers.length === 0 ? (
                          <span className="text-xs text-faint">暂无</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {offers.map((o) => {
                              const buyer = g.teams[o.fromTeamId];
                              return (
                                <div key={o.id} className="flex items-center gap-1.5 text-xs">
                                  {buyer ? (
                                    <span className="inline-flex items-center gap-1">
                                      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: buyer.color }} />
                                      <TeamLink teamId={buyer.id} name={buyer.name} />
                                    </span>
                                  ) : (
                                    <span className="text-faint">未知战队</span>
                                  )}
                                  <Gold value={o.fee} className="font-semibold" />
                                  <ConfirmButton
                                    size="xs"
                                    variant="gold"
                                    disabled={!windowOpen}
                                    title={windowOpen ? '接受报价，选手转出' : '转会窗口已锁定（TI 阶段），TI 结束后开放'}
                                    confirm={sellConfirm(o, p)}
                                    onConfirm={() => respond(o.id, true)}
                                  >
                                    接受
                                  </ConfirmButton>
                                  <Button size="xs" variant="danger" title="拒绝该报价" onClick={() => respond(o.id, false)}>
                                    拒绝
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </td>
                      <td className="text-right">
                        <Button size="xs" title="从转会名单撤下，选手继续留队" onClick={() => void call('unlistPlayer', p.id)}>
                          撤销挂牌
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

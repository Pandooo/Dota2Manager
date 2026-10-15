// 转会市场 · 我的挂牌：挂牌中的选手、标价、剩余等待回合（挂牌期一整个赛季）、收到的报价（接受/拒绝）、撤销挂牌
import { useCall, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, activeListing, formatGold, listedPlayers, listingBidOutlook, listingDurationLabel, listingListedAtLabel, listingOffers,
  listingProgress, listingRoundStatus, marketValue, overallRating, playerTier,
  type Player, type TransferOffer,
} from '../../engine';
import { Badge, Button, Card, EmptyState, Gold, PlayerLink, PosBadge, TeamLink, TierBadge, cx } from './common';
import { TeamEmblem } from './TeamEmblem';
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

  // 本回合结束时：是否计时 / 是否可能收到新报价（与引擎 processTransferListings 同一判定）
  const status = safe(() => listingRoundStatus(g), { counts: windowOpen, bids: windowOpen, note: '' });
  const paused = status.counts ? '' : status.note;
  const durationLabel = safe(() => listingDurationLabel(), '一整个赛季');

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
      <Banner tone="gold" title={`挂牌规则：挂牌期为${durationLabel}，整个挂牌期无人报价则自动解约`}>
        挂牌后选手进入转会名单，其他俱乐部每回合结束时可能报价：标价越低（相对身价）、选手等级越高、越符合对方需求，越容易收到报价。
        每个常规赛回合结束时计一次（赛季初与 TI 阶段转会锁定期间不计时），挂牌在下赛季的同一时间点到期；常规赛最后一回合结束后转会窗口锁定，那一回合不会再收到新报价，未处理的报价作废。
        前 {S.listingFreshRolls} 次报价机会之后，标价高于身价的挂牌挂得越久，俱乐部的报价意愿越低（标价不高于身价不受影响；撤牌后不久重新挂牌，次数继续累计）。
        若整个挂牌期都没有收到任何报价，到期自动解约成为自由选手——不支付解约补偿、不扣俱乐部荣誉；收到过报价（含普通求购报价）但未成交，则挂牌期满后挂牌结束、选手留队。
        新加盟的选手（签约、转会、交易、抽卡等任何途径）须随队满 {S.listingMinTeamMatches} 场比赛（系列赛，不要求本人上场）且入队满 {S.listingMinTransferRounds} 个转会回合才能挂牌，在此之前其他俱乐部也不会主动求购他。
        {status.note && <span className="ml-1 font-semibold">当前：{status.note}。</span>}
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
                  const prog = safe(() => listingProgress(L), { roundsLeft: L.roundsLeft, totalRounds: L.roundsLeft, bidRolls: 0 });
                  const left = prog.roundsLeft;
                  // 收到过报价：到期不会自动解约（挂牌结束、选手留队），倒计时不再标红 / 标金
                  const safeAtExpiry = !!L.hadBids;
                  const listedAt = safe(() => listingListedAtLabel(L), `TI${L.season} 挂牌`);
                  const value = safe(() => marketValue(g, p), 0);
                  const ratio = value > 0 ? L.askingPrice / value : null;
                  const outlook = safe(() => listingBidOutlook(g, p.id), null);
                  const offers = safe(() => listingOffers(g, p.id), []);
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <PlayerLink player={p} />
                          <PosBadge pos={p.position} alt={p.altPositions} />
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
                        className={cx(
                          'num text-xs',
                          safeAtExpiry ? 'text-mute' : left <= 1 ? 'text-bad font-semibold' : left <= S.listingReminderRounds ? 'text-gold' : 'text-mute',
                        )}
                        title={
                          left <= 0
                            ? '挂牌期已满：待处理报价处理后挂牌结束、选手留队'
                            : `${listedAt}，挂牌期 ${prog.totalRounds} 个转会回合，剩余 ${left} 个` +
                              `${status.note ? `（${status.note}）` : ''}` +
                              (safeAtExpiry ? '。已收到过报价：挂牌期满后挂牌结束、选手留队' : '。整个挂牌期没有收到任何报价将自动解约（无补偿）')
                        }
                      >
                        {left <= 0 ? '已到期' : `${left} / ${prog.totalRounds} 回合${paused ? '（暂停）' : ''}`}
                        {safeAtExpiry && left > 0 && (
                          <span className="ml-1 block text-[10px] text-good">已收到过报价·到期不解约</span>
                        )}
                      </td>
                      <td
                        className="num text-xs"
                        title={
                          !status.bids
                            ? status.note || '本回合结束时不会收到新报价'
                            : outlook && outlook.stale < 1
                              ? `挂牌较久且标价高于身价，俱乐部报价意愿下降（× ${outlook.stale.toFixed(2)}）`
                              : undefined
                        }
                      >
                        {outlook && left > 0 && status.bids ? `${Math.round(outlook.chance * 100)}%` : '—'}
                        {outlook && left > 0 && (
                          <span className="ml-1 text-[10px] text-faint" title="有意向且负担得起的俱乐部">{outlook.interested} 家</span>
                        )}
                        {outlook && left > 0 && outlook.stale < 1 && outlook.interested > 0 && status.bids && (
                          <span className="ml-1 text-[10px] text-gold">挂牌较久</span>
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
                                      <TeamEmblem tag={buyer.tag} color={buyer.color} teamId={buyer.id} />
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

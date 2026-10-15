// 转会市场 · 收到的报价：待处理报价（接受/拒绝）+ 最近已处理报价记录
import { useCall, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, formatGold, marketValue, overallRating, playerTier,
  type GameState, type Player, type TransferOffer,
} from '../../engine';
import { Badge, Button, Card, EmptyState, Gold, PlayerLink, PosBadge, TeamLink, TierBadge, cx } from './common';
import { TeamEmblem } from './TeamEmblem';
import { ConfirmButton } from './ConfirmPopover';
import { BODY_FLUSH, Facts, PHONE_LINK, PhoneList, TableWrap, num, safe, useCompactList } from './MarketKit';

const STATUS_LABEL: Record<TransferOffer['status'], { text: string; cls: string }> = {
  pending: { text: '待处理', cls: 'bg-gold/15 text-gold' },
  accepted: { text: '已接受', cls: 'bg-good/15 text-good' },
  rejected: { text: '已拒绝', cls: 'bg-bad/15 text-bad' },
  expired: { text: '已过期', cls: 'bg-panel-3 text-faint' },
};

function TeamCell({ g, id, className }: { g: GameState; id: string; className?: string }) {
  const t = g.teams[id];
  if (!t) return <span className="text-faint">未知战队</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <TeamEmblem tag={t.tag} color={t.color} teamId={t.id} />
      <TeamLink teamId={t.id} name={t.name} className={cx('font-medium', className)} />
    </span>
  );
}

export default function MarketOffers({ windowOpen }: { windowOpen: boolean }) {
  const g = useGame();
  const call = useCall();
  const setView = useGameStore((s) => s.setView);
  const me = g.settings.playerTeamId;
  const myTeam = g.teams[me];
  const phone = useCompactList();

  const offers = Array.isArray(g.transferOffers) ? g.transferOffers : [];
  const pending = offers.filter((o) => o && o.status === 'pending' && o.toTeamId === me);
  const resolved = offers
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o && o.status !== 'pending' && (o.toTeamId === me || o.fromTeamId === me))
    .sort((a, b) => num(b.o.season, 0) - num(a.o.season, 0) || b.o.createdRound - a.o.createdRound || b.i - a.i)
    .slice(0, 30)
    .map(({ o }) => o);

  const starters = new Set(Object.values(myTeam?.lineup ?? {}).filter(Boolean) as string[]);

  const respond = (id: string, accept: boolean) => {
    void call('respondToOffer', id, accept);
  };

  /** 接受报价的就近确认：到账后金币、荣誉变化、首发提醒、节省工资 */
  const sellConfirm = (o: TransferOffer, p: Player) => {
    const d = CONFIG.honor.transfer.sellTierPenalty[playerTier(p)] ?? 0;
    return {
      title: `出售 ${p.handle}？`,
      confirmLabel: '确认接受',
      message: (
        <>
          以 <Gold value={o.fee} className="font-semibold text-ink" /> 出售给 <span className="text-ink">{g.teams[o.fromTeamId]?.name ?? '对方战队'}</span>。
          <span className="mt-1 grid grid-cols-2 gap-x-3">
            <span>到账后 <Gold value={num(myTeam?.gold) + o.fee} className="text-ink" /></span>
            <span>
              荣誉 <span className={cx('tabular', d < 0 ? 'text-bad' : d > 0 ? 'text-good' : 'text-faint')}>{d > 0 ? `+${d}` : d < 0 ? d : '无变化'}</span>
            </span>
          </span>
          {starters.has(p.id) && (
            <span className="mt-1 block text-gold">这是一名首发：出售后自动用替补补位，没有合适替补时该位置空缺。</span>
          )}
          <span className="mt-0.5 block text-faint">节省工资 {formatGold(num(p.salary))}/回合。</span>
        </>
      ),
    };
  };

  // 下回合若进入 TI 阶段（转会锁定），所有待处理报价会在本回合结束时作废（同 market.expireOffers）
  const nextPhase = g.season.rounds?.[g.roundIndex + 1]?.phase;
  const windowClosingSoon = nextPhase !== undefined && nextPhase !== 'preseason' && nextPhase !== 'regular';

  /** 剩余可答复回合（含本回合）：回合结束时若 回合+1 ≥ expiresRound 或转会窗口即将关闭即过期 */
  const roundsLeft = (o: TransferOffer) => {
    const sameSeason = o.season === undefined || o.season === g.season.ti;
    if (!sameSeason || windowClosingSoon) return 1;
    return Math.max(1, o.expiresRound - g.roundIndex);
  };

  /** 一份待处理报价的派生数据（表格与手机卡片共用） */
  const offerInfo = (o: TransferOffer) => {
    const p = g.players[o.playerId];
    const value = p ? safe(() => marketValue(g, p), 0) : 0;
    const premium = value > 0 ? o.fee / value : null;
    const left = roundsLeft(o);
    const acceptBlock = g.gameOver
      ? '游戏已结束'
      : !windowOpen
      ? '转会窗口已锁定（TI 阶段），TI 结束后开放'
      : !p || p.teamId !== me
        ? '选手已不在队中，该报价将自动作废'
        : null;
    return { p, premium, left, acceptBlock };
  };
  const premiumCls = (premium: number | null) => (premium === null ? 'text-faint' : premium >= 1 ? 'text-good' : 'text-bad');
  const leftTitle = (left: number) => (left <= 1 ? '本回合结束时报价将过期' : `需在第 ${g.roundIndex + left - 1} 回合结束前答复`);
  const offerBadges = (o: TransferOffer, p: Player) => (
    <>
      {starters.has(p.id) && <Badge className="bg-info/15 text-info">首发</Badge>}
      {o.poach && <Badge className="bg-dota/20 text-dota-2" title="低归属感挖角：违约金可能低于身价">挖角</Badge>}
      {o.listing && <Badge className="bg-gold/15 text-gold" title="针对挂牌选手的报价（见「我的挂牌」）">挂牌</Badge>}
    </>
  );
  const salaryDelta = (o: TransferOffer, p: Player | undefined) =>
    p && num(p.salary) > 0 ? (
      <span className="ml-1 text-[10px] text-faint">
        ({o.salary >= p.salary ? '+' : ''}{Math.round(((o.salary - p.salary) / p.salary) * 100)}%)
      </span>
    ) : null;

  return (
    <div className="space-y-4">
      <Card
        title="待处理报价"
        subtitle="AI 战队对你旗下选手的求购；归属感低的选手更容易被盯上"
        bodyClassName={BODY_FLUSH}
      >
        {pending.length === 0 ? (
          <EmptyState text="目前没有收到任何报价。">
            <span className="text-xs text-faint">转会窗口开放期间，AI 战队每回合都可能对你的选手报价，报价会在数回合后过期。</span>
          </EmptyState>
        ) : phone ? (
          // 手机：每份报价一张卡片，「接受 / 拒绝」为通栏的两个大按钮
          <PhoneList>
            {pending.map((o) => {
              const { p, premium, left, acceptBlock } = offerInfo(o);
              return (
                <li key={o.id} className="space-y-1.5 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    {p ? (
                      <>
                        <TierBadge tier={playerTier(p)} />
                        <PlayerLink player={p} className={PHONE_LINK} />
                        <PosBadge pos={p.position} alt={p.altPositions} />
                        {offerBadges(o, p)}
                        <span className="ml-auto text-xs text-mute">评分 <span className="tabular text-ink">{overallRating(p).toFixed(1)}</span></span>
                      </>
                    ) : (
                      <span className="text-faint">（选手已离队）</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-mute">
                    <span className="shrink-0 text-faint">报价方</span>
                    <TeamCell g={g} id={o.fromTeamId} className="-my-1 py-1 text-ink" />
                  </div>
                  <Facts
                    className="text-xs text-mute"
                    items={[
                      ['转会费', <><Gold value={o.fee} className="font-semibold" />{premium !== null && <span className={cx('ml-1 text-[10px]', premiumCls(premium))}>身价 {Math.round(premium * 100)}%</span>}</>],
                      ['新工资', <><Gold value={o.salary} />{salaryDelta(o, p)}</>],
                      ['答复期限', <span className={cx('tabular', left <= 1 ? 'text-gold' : 'text-ink')}>{left <= 1 ? '本回合内' : `${left} 回合内`}</span>],
                    ]}
                  />
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <ConfirmButton
                      size="sm"
                      variant="gold"
                      className="min-h-10 w-full"
                      disabled={!!acceptBlock}
                      title={acceptBlock ?? '接受报价，选手转出'}
                      confirm={p ? sellConfirm(o, p) : null}
                      onConfirm={() => respond(o.id, true)}
                    >
                      接受
                    </ConfirmButton>
                    <Button size="sm" variant="danger" className="min-h-10 w-full" title="拒绝报价（想走的选手归属感会下降）" onClick={() => respond(o.id, false)}>
                      拒绝
                    </Button>
                  </div>
                </li>
              );
            })}
          </PhoneList>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>选手</th>
                  <th>等级</th>
                  <th className="num">评分</th>
                  <th>报价方</th>
                  <th className="num">转会费</th>
                  <th className="num" title="报价 / 身价">溢价</th>
                  <th className="num" title="对方开出的新工资（每回合）">新工资</th>
                  <th className="num">剩余</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((o) => {
                  const { p, premium, left, acceptBlock } = offerInfo(o);
                  return (
                    <tr key={o.id}>
                      <td>
                        {p ? (
                          <div className="flex items-center gap-1.5">
                            <PlayerLink player={p} />
                            <PosBadge pos={p.position} alt={p.altPositions} />
                            {offerBadges(o, p)}
                          </div>
                        ) : (
                          <span className="text-faint">（选手已离队）</span>
                        )}
                      </td>
                      <td>{p ? <TierBadge tier={playerTier(p)} /> : '—'}</td>
                      <td className="num">{p ? overallRating(p).toFixed(1) : '—'}</td>
                      <td><TeamCell g={g} id={o.fromTeamId} /></td>
                      <td className="num"><Gold value={o.fee} className="font-semibold" /></td>
                      <td className={cx('num text-xs', premiumCls(premium))}>
                        {premium === null ? '—' : `${Math.round(premium * 100)}%`}
                      </td>
                      <td className="num">
                        <Gold value={o.salary} />
                        {salaryDelta(o, p)}
                      </td>
                      <td
                        className={cx('num text-xs', left <= 1 ? 'text-gold' : 'text-mute')}
                        title={leftTitle(left)}
                      >
                        {left <= 1 ? '本回合内' : `${left} 回合内`}
                      </td>
                      <td className="text-right">
                        <div className="inline-flex gap-1.5">
                          <ConfirmButton
                            size="xs"
                            variant="gold"
                            disabled={!!acceptBlock}
                            title={acceptBlock ?? '接受报价，选手转出'}
                            confirm={p ? sellConfirm(o, p) : null}
                            onConfirm={() => respond(o.id, true)}
                          >
                            接受
                          </ConfirmButton>
                          <Button size="xs" variant="danger" title="拒绝报价（想走的选手归属感会下降）" onClick={() => respond(o.id, false)}>
                            拒绝
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
        {pending.some((o) => o.poach) && (
          <div className="border-t border-line px-3 py-2 text-[11px] text-faint sm:px-4">
            挖角报价同时会出现在
            <button className="mx-1 cursor-pointer text-info hover:underline pointer-coarse:-my-2 pointer-coarse:py-2" onClick={() => setView('inbox')}>消息中心</button>
            的待决事件中，处理任意一处即可。
          </div>
        )}
      </Card>

      <Card title="报价记录" subtitle="最近已处理的转会报价（含过期）" bodyClassName={BODY_FLUSH}>
        {resolved.length === 0 ? (
          <EmptyState text="暂无报价记录。" />
        ) : phone ? (
          <PhoneList className="max-h-96 overflow-y-auto overscroll-contain">
            {resolved.map((o) => {
              const p = g.players[o.playerId];
              const incoming = o.toTeamId === me;
              const st = STATUS_LABEL[o.status] ?? STATUS_LABEL.expired;
              return (
                <li key={o.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      {p ? <PlayerLink player={p} className={PHONE_LINK} /> : <span className="text-faint">{o.playerId}</span>}
                      {incoming ? <span className="text-xs text-gold">求购我方</span> : <span className="text-xs text-info">我方求购</span>}
                      <Gold value={o.fee} className="text-xs" />
                    </div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-mute">
                      <span className="tabular">{o.season !== undefined ? `TI${o.season} · ` : ''}第{o.createdRound}回合</span>
                      <TeamCell g={g} id={incoming ? o.fromTeamId : o.toTeamId} className="-my-1 py-1" />
                    </div>
                  </div>
                  <Badge className={st.cls}>{st.text}</Badge>
                </li>
              );
            })}
          </PhoneList>
        ) : (
          <TableWrap maxH="max-h-80">
            <table className="tbl">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>选手</th>
                  <th>方向</th>
                  <th>对方</th>
                  <th className="num">转会费</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {resolved.map((o) => {
                  const p = g.players[o.playerId];
                  const incoming = o.toTeamId === me;
                  const st = STATUS_LABEL[o.status] ?? STATUS_LABEL.expired;
                  return (
                    <tr key={o.id}>
                      <td className="text-xs text-mute tabular">
                        {o.season !== undefined ? `TI${o.season} · ` : ''}第{o.createdRound}回合
                      </td>
                      <td>{p ? <PlayerLink player={p} /> : <span className="text-faint">{o.playerId}</span>}</td>
                      <td className="text-xs">
                        {incoming ? <span className="text-gold">求购我方</span> : <span className="text-info">我方求购</span>}
                      </td>
                      <td><TeamCell g={g} id={incoming ? o.fromTeamId : o.toTeamId} /></td>
                      <td className="num"><Gold value={o.fee} /></td>
                      <td><Badge className={st.cls}>{st.text}</Badge></td>
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

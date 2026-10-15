// 转会报价弹窗：转会费滑块（建议价 0.6×–2.5×）→ bidForPlayer；
// 可选「加入本队选手抵价」：现金 + 本队若干名选手（按身价 × 对方估值系数折算）→ tradeForPlayer（src/engine/trade.ts）
import { useState } from 'react';
import { useCall, useGame } from '../../store/gameStore';
import {
  CONFIG, ageOf, effectiveAttr, effectivePower, formatGold, marketValue, overallRating, playerTier,
  playerWillingness, rosterSigningBlock, rosterSigningNote, signingSalary, suggestedFee, REGION_LABEL,
  teamPlayers, tradeHoldRoundsLabel, tradeQuote, tradeValuation,
  type OpResult, type Player, type TradeItem,
} from '../../engine';
import { Button, Gold, Modal, PosBadge, TeamTag, TierBadge, cx } from './common';
import { ConfirmButton } from './ConfirmPopover';
import NewBadge, { useNewFeature } from './NewBadge';
import {
  AttrNum, Banner, PctBadge, aiAcceptEstimate, isRefused, markBidRejected, markRefused, num, rejectedBidOf, roundFee, safe,
} from './MarketKit';

const MIN_MULT = 0.6;
const MAX_MULT = 2.5;
const QUICK = [0.8, 1, 1.2, 1.5, 2];


export default function MarketBidModal({
  playerId,
  onClose,
  windowOpen,
}: {
  playerId: string | null;
  onClose: () => void;
  windowOpen: boolean;
}) {
  const g = useGame();
  const call = useCall();
  const me = g.settings.playerTeamId;
  const myTeam = g.teams[me];
  const p = playerId ? g.players[playerId] : undefined;
  const owner = p?.teamId ? g.teams[p.teamId] : undefined;

  // 注意：引擎原地修改 game，派生值每次渲染现算（不能以 game 引用做 memo 依赖）
  const info = (() => {
    if (!p) return null;
    const value = safe(() => marketValue(g, p), 0);
    const sf = safe(() => suggestedFee(g, p.id), 0) || roundFee(value * CONFIG.market.suggestedFeeBase);
    return {
      value,
      suggested: sf,
      min: roundFee(sf * MIN_MULT),
      max: roundFee(sf * MAX_MULT),
      will: safe<number | null>(() => playerWillingness(g, p.id, me), null),
      // 加盟后的工资：按我方俱乐部地位开价（引擎 signingSalary，与 bidForPlayer 实际签约一致）
      newSalary: safe(() => signingSalary(g, p, me), num(p.salary)),
    };
  })();

  // 父组件以 playerId 作为 key 挂载本弹窗，初始值直接取建议价（避免首帧闪烁 0）
  const [fee, setFee] = useState(() => info?.suggested ?? 0);
  const [text, setText] = useState(() => String(info?.suggested ?? ''));
  // 抵价选手（本队选手 id）与抵价区块是否展开（默认收起 = 纯现金报价）
  const [offered, setOffered] = useState<string[]>([]);
  const [tradeOpen, setTradeOpen] = useState(false);
  // 新功能徽标（v0.3.0）：显示在「加入本队选手抵价」旁，展开 / 收起抵价列表后消失
  const tradeNew = useNewFeature('trade');
  // 谈判结果记录在 MarketKit 的模块级 Map 里（不在 store 中）：记录后手动触发一次重渲染，让「已拒绝此价位」立即生效
  const [, setNonce] = useState(0);

  if (!playerId) return null;

  if (!p || !info || !myTeam) {
    return (
      <Modal open onClose={onClose} title="转会报价" width="max-w-md">
        <div className="text-sm text-mute">该选手已不在市场上（可能已转会、退役或被禁赛）。</div>
      </Modal>
    );
  }

  const T = CONFIG.market.trade;
  // 本队正式队员（候选抵价选手），按评分降序；每人单独估值用于列表显示，已选组合的估值见 quote
  const roster = safe(() => teamPlayers(g, me), [] as Player[])
    .filter((x) => !x.tempSubUntilTournament && !x.isWildSub)
    .sort((a, b) => overallRating(b) - overallRating(a));
  const standalone = new Map<string, TradeItem>();
  for (const c of roster) {
    const it = safe<TradeItem | null>(() => tradeValuation(g, p.id, [c.id]).items[0] ?? null, null);
    if (it) standalone.set(c.id, it);
  }
  const selected = offered.filter((id) => roster.some((c) => c.id === id));
  const trading = selected.length > 0;
  const quote = trading ? safe(() => tradeQuote(g, p.id, fee, selected), null) : null;
  // 对方容量：不必放人就能接收的人数 / 最多能接收的人数（含为此放走的替补，不放首发）
  const capacity = safe(() => tradeValuation(g, p.id, []), null);
  const maxIncoming = capacity?.maxIncoming ?? T.maxPlayers;
  const freeSlots = capacity?.freeSlots ?? T.maxPlayers;
  const releaseNames = (quote?.releases ?? []).map((id) => g.players[id]?.handle ?? id).join('、');
  const playersValue = quote?.playersValue ?? 0;
  const total = trading ? (quote?.total ?? fee + playersValue) : fee;
  // 有抵价选手时现金可以减到 0（总额仍需 > 0）
  const minFee = trading ? 0 : info.min;
  const myStarters = new Set(Object.values(myTeam.lineup ?? {}).filter(Boolean) as string[]);

  const setBoth = (v: number) => {
    const clamped = Math.max(minFee, Math.min(info.max, roundFee(v)));
    setFee(clamped);
    setText(String(clamped));
  };

  const toggleOffered = (id: string) => {
    const has = selected.includes(id);
    const next = has ? selected.filter((x) => x !== id) : [...selected, id];
    setOffered(next);
    // 去掉最后一名抵价选手后回到纯现金报价：现金不低于滑块下限
    if (!next.length && fee < info.min) {
      setFee(info.min);
      setText(String(info.min));
    }
  };

  // 只有达到绝对上限才不能报价；超出常规上限只做提示（有抵价选手时阵容人数不增加）
  const rosterBlock = safe<string | null>(() => rosterSigningBlock(g, me), null);
  const overNote = safe<string | null>(() => rosterSigningNote(g, me), null);
  const gold = num(myTeam.gold);
  // 本回合谈判记录：对方拒绝过的最高报价（现金与交易共用同一枚骰子，按总额比较）/ 选手本人是否已拒绝
  const rejectedFee = rejectedBidOf(g, p.id);
  const playerRefused = isRefused(g, p.id, info.will);
  // 交易报价的接受概率：只有对方拒收抵价选手 / 已拒绝此价位时为 0；只是现金不够（或对方工资负担不起，可调整现金解决）时
  // 仍按总额估算（与纯现金报价同口径），否则「加了抵价选手反而显示 0%」会让人误以为交易没希望
  const tradeAccept = (): number => {
    if (!quote || quote.total <= 0 || quote.items.some((it) => it.refused)) return 0;
    if (!quote.block) return quote.accept ?? 0;
    const cashOnly = quote.block.startsWith('资金不足') || quote.block.includes('无法负担抵价选手的工资');
    return cashOnly ? safe(() => aiAcceptEstimate(g, p, quote.total), 0) : 0;
  };
  const accept = total <= rejectedFee ? 0 : trading ? tradeAccept() : aiAcceptEstimate(g, p, fee);
  const overall = info.will === null ? null : playerRefused ? 0 : accept * info.will;
  const ratio = info.suggested > 0 ? total / info.suggested : 1;

  const block = ((): string | null => {
    if (g.gameOver) return '游戏已结束';
    if (!windowOpen) return '转会窗口已锁定（TI 阶段）';
    if (p.status !== 'active') return `${p.handle} 当前无法转会（已退役或被禁赛）`;
    if (p.tempSubUntilTournament || p.isWildSub) return '临时替补无法转会';
    if (p.teamId === me) return '该选手已在你的战队';
    if (!p.teamId) return '该选手已成为自由选手，请在「自由选手」页签约';
    if (owner?.isPlayer) return `${owner.name} 由其他玩家执教，暂不支持直接求购其选手`;
    if (!trading && rosterBlock) return rosterBlock;
    if (playerRefused) return `${p.handle} 本回合已明确拒绝加盟，下回合再谈（或先提升俱乐部荣誉）`;
    if (trading) {
      if (!quote) return '无法评估这份交易报价';
      if (quote.block) return quote.block;
      if (total <= rejectedFee) return `${owner?.name ?? '对方'} 本回合已拒绝总额 ${formatGold(rejectedFee)} 的报价，需要更高的总额`;
      return null;
    }
    if (fee <= 0) return '报价金额无效';
    if (fee <= rejectedFee) return `${owner?.name ?? '对方'} 本回合已拒绝 ${formatGold(rejectedFee)} 的报价，需要报更高的价格`;
    if (gold < fee) return `金币不足（需要 ${formatGold(fee)}，当前 ${formatGold(gold)}）。可展开下方「加入本队选手抵价」，用本队选手抵价减少现金`;
    return null;
  })();

  // 同一回合谈判骰子固定：记录失败原因，避免重复提交必然失败的报价（交易与现金报价按总额记录）
  const afterResult = (res: OpResult | undefined, offerTotal: number) => {
    if (!res) return;
    if (res.ok) {
      onClose();
      return;
    }
    if (res.message.includes('不愿加盟')) markRefused(g, p.id, info.will ?? 1);
    else if (res.message.includes('拒绝了')) markBidRejected(g, p.id, offerTotal);
    setNonce((n) => n + 1);
  };
  const submitCash = () => {
    if (block) return;
    const offer = fee;
    void call('bidForPlayer', p.id, offer).then((res) => afterResult(res, offer));
  };
  const submitTrade = () => {
    if (block) return;
    const offerTotal = total;
    void call('tradeForPlayer', p.id, fee, selected).then((res) => afterResult(res, offerTotal));
  };

  const tier = playerTier(p);
  const age = ageOf(g, p);
  const selectedNames = selected.map((id) => g.players[id]?.handle ?? id).join('、');
  const showTradeList = tradeOpen || trading;

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-xl"
      title={
        <span className="flex items-center gap-2">
          转会报价 <span className="text-mute">·</span> <span className="text-gold">{p.handle}</span>
        </span>
      }
      footer={
        // 手机：余额单独一行，「取消」与提交按钮在下一行（提交按钮占满剩余宽度、44px 高）；按钮文字不换行
        <>
          <span className="basis-full self-center whitespace-nowrap text-xs text-mute sm:mr-auto sm:basis-auto">
            报价后余额 <Gold value={gold - fee} />
          </span>
          <Button variant="ghost" className="whitespace-nowrap max-sm:min-h-11" onClick={onClose}>取消</Button>
          {trading ? (
            <ConfirmButton
              variant="primary"
              wrapClassName="max-sm:flex-1"
              className="whitespace-nowrap max-sm:min-h-11 max-sm:w-full"
              disabled={!!block}
              title={block ?? '提交交易报价，对方将立即答复'}
              confirm={{
                title: '确认交易报价',
                message: `送出 ${selectedNames}（抵价合计 ${formatGold(playersValue)}）+ 现金 ${formatGold(fee)}，求购 ${p.handle}。成交后抵价选手将加盟 ${owner?.name ?? '对方'}` +
                  `${releaseNames ? `（对方阵容超员，将放走替补 ${releaseNames}）` : ''}，不能撤销。`,
                confirmLabel: '提交交易',
              }}
              onConfirm={submitTrade}
            >
              提交交易 · 总额 {formatGold(total)}
            </ConfirmButton>
          ) : (
            <Button
              variant="primary"
              className="whitespace-nowrap max-sm:min-h-11 max-sm:flex-1"
              disabled={!!block}
              title={block ?? '提交报价，对方将立即答复'}
              onClick={submitCash}
            >
              提交报价 {formatGold(fee)}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {/* 选手概要 */}
        <div className="flex items-center gap-3 rounded-lg border border-line bg-panel-2/60 p-3">
          <TierBadge tier={tier} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold">{p.handle}</span>
              <PosBadge pos={p.position} alt={p.altPositions} />
              {p.name && <span className="text-xs text-faint">{p.name}</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-mute">
              {owner && <TeamTag color={owner.color} tag={owner.tag} />}
              <span>{age} 岁</span>
              <span>{p.nationality} · {REGION_LABEL[p.region] ?? p.region}</span>
              <span>合同至 TI{p.contractUntil}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
          {[
            ['战力', <AttrNum key="p" value={effectivePower(p)} />],
            ['评分', <span key="r" className="tabular">{overallRating(p).toFixed(1)}</span>],
            ['天赋', <AttrNum key="t" value={effectiveAttr(p, 'talent')} />],
            ['灵性', <AttrNum key="i" value={effectiveAttr(p, 'insight')} />],
            ['归属感', <AttrNum key="l" value={effectiveAttr(p, 'loyalty')} />],
            ['加盟后工资', <Gold key="s" value={info.newSalary} />],
          ].map(([label, v], i) => (
            <div key={i} className="rounded-md border border-line bg-panel-2/40 px-2 py-1.5">
              <div className="text-[11px] text-faint sm:text-[10px]">{label}</div>
              <div className="font-semibold">{v}</div>
            </div>
          ))}
        </div>

        {/* 价格参考 */}
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md border border-line px-3 py-2">
            <div className="text-[11px] text-faint">身价</div>
            <Gold value={info.value} className="font-semibold" />
          </div>
          <div className="rounded-md border border-gold/30 bg-gold/5 px-3 py-2">
            <div className="text-[11px] text-faint">建议转会费（含原队重要度溢价）</div>
            <Gold value={info.suggested} className="font-semibold" />
          </div>
        </div>

        {/* 报价（现金部分） */}
        <div className="rounded-lg border border-line p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs text-mute">{trading ? '现金部分' : '你的报价'}</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                aria-label={trading ? '现金部分' : '报价金额'}
                value={text}
                min={minFee}
                max={info.max}
                step={CONFIG.market.feeRounding}
                onChange={(e) => {
                  setText(e.target.value);
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= minFee && v <= info.max) setFee(roundFee(v));
                }}
                onBlur={() => setBoth(text === '' ? minFee : Number(text) || minFee)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setBoth(text === '' ? minFee : Number(text) || minFee);
                }}
                className="h-8 w-32 rounded-md border border-line bg-panel-2 px-2 text-right text-sm tabular text-gold outline-none focus:border-dota/70 pointer-coarse:h-10"
              />
              <span className={cx('w-14 text-right text-xs tabular', ratio >= 1 ? 'text-good' : 'text-bad')} title="报价总额 / 建议转会费">
                ×{ratio.toFixed(2)}
              </span>
            </div>
          </div>
          <input
            type="range"
            min={minFee}
            max={info.max}
            step={CONFIG.market.feeRounding}
            value={Math.max(minFee, Math.min(info.max, fee))}
            onChange={(e) => setBoth(Number(e.target.value))}
            aria-label="报价滑块"
            className="w-full cursor-pointer accent-[#e5b24d] pointer-coarse:h-10"
          />
          <div className="mt-1 flex justify-between text-[11px] text-faint tabular sm:text-[10px]">
            <span>{trading ? '0（全部以选手抵价）' : `${formatGold(info.min)}（×${MIN_MULT}）`}</span>
            <span>{formatGold(info.max)}（×{MAX_MULT}）</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK.map((m) => (
              <button
                key={m}
                onClick={() => setBoth(info.suggested * m)}
                className={cx(
                  'cursor-pointer rounded border px-2 py-0.5 text-xs tabular transition-colors pointer-coarse:min-h-9 pointer-coarse:px-3',
                  !trading && Math.abs(ratio - m) < 0.01 ? 'border-gold/60 bg-gold/15 text-gold' : 'border-line text-mute hover:text-ink',
                )}
              >
                {m === 1 ? '建议价' : `×${m}`}
              </button>
            ))}
            {trading && (
              <button
                onClick={() => setBoth(Math.max(0, info.suggested - playersValue))}
                className="cursor-pointer rounded border border-line px-2 py-0.5 text-xs tabular text-mute transition-colors hover:text-ink pointer-coarse:min-h-9 pointer-coarse:px-3"
                title="现金 = 建议转会费 − 抵价合计（不足时为 0）"
              >
                现金补足到建议价
              </button>
            )}
          </div>
        </div>

        {/* 抵价选手 */}
        <div className="rounded-lg border border-line p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-mute">
              加入本队选手抵价
              <span className="text-faint">（可选，最多 {T.maxPlayers} 名）</span>
              <NewBadge feature="trade" dismissOn="none" className="ml-1" />
              {trading && <span className="ml-2 text-gold tabular">已选 {selected.length} 人 · 抵价 {formatGold(playersValue)}</span>}
            </span>
            <button
              onClick={() => {
                setTradeOpen((o) => !o);
                tradeNew.dismiss();
              }}
              className="shrink-0 cursor-pointer whitespace-nowrap text-xs text-mute hover:text-ink pointer-coarse:-my-1 pointer-coarse:min-h-10 pointer-coarse:px-2"
              title={showTradeList ? '收起选手列表' : '展开本队选手列表，勾选用于抵价的选手'}
            >
              {showTradeList ? '收起 ▴' : '展开 ▾'}
            </button>
          </div>
          {showTradeList && (
            <>
              <div className="mt-2 text-[11px] leading-relaxed text-faint">
                {owner?.name ?? '对方'} 按「身价 × 系数」接收抵价选手：基础 {T.baseRatio}；对方缺该位置或能顶替其首发时溢价（最高 {T.ratioRange[1]}），位置重叠、年龄偏大、等级低于其首发时折价（最低 {T.ratioRange[0]}）；不愿加盟对方的选手会被拒收；刚从自由市场签下（入队不满 {tradeHoldRoundsLabel('freeAgent')} 个转会回合或随队不满 {CONFIG.squadOps.listingMinTeamMatches} 场比赛）的选手与本队抽卡得到的新秀（入队不满 {tradeHoldRoundsLabel('gacha')} 个转会回合或随队不满 {CONFIG.squadOps.listingMinTeamMatches} 场比赛）按签字费估值（身价 × {T.freeAgentSignedCap}）。
                {freeSlots < T.maxPlayers && maxIncoming > freeSlots &&
                  `${owner?.name ?? '对方'} 阵容接近上限（${CONFIG.ai.maxRoster} 人）：${freeSlots > 0 ? `接收超过 ${freeSlots} 名时` : '每接收 1 名都'}会放走替补腾位置（不放首发）。`}
                {maxIncoming < T.maxPlayers && `${owner?.name ?? '对方'} 目前最多只能接收 ${maxIncoming} 名选手。`}
                送出的选手不扣荣誉。
              </div>
              {roster.length === 0 ? (
                <div className="mt-2 text-xs text-mute">本队没有可用于抵价的正式队员。</div>
              ) : (
                <ul className="mt-2 divide-y divide-line/60">
                  {roster.map((c) => {
                    const it = standalone.get(c.id);
                    const on = selected.includes(c.id);
                    const combined = on ? quote?.items.find((x) => x.playerId === c.id) : undefined;
                    const shown = combined ?? it;
                    const reason = !on
                      ? it?.refused
                        ?? (selected.length >= T.maxPlayers ? `一次最多 ${T.maxPlayers} 名选手抵价` : null)
                        ?? (selected.length >= maxIncoming ? `${owner?.name ?? '对方'} 最多只能接收 ${maxIncoming} 名选手` : null)
                      : null;
                    const disabled = !!reason;
                    return (
                      <li key={c.id}>
                        <label
                          className={cx(
                            'flex items-start gap-2 py-1.5 text-xs pointer-coarse:py-2.5',
                            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-panel-2/40',
                          )}
                          title={reason ?? (shown?.notes.length ? shown.notes.join('；') : undefined)}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-[#e5b24d] pointer-coarse:h-5 pointer-coarse:w-5"
                            checked={on}
                            disabled={disabled}
                            onChange={() => toggleOffered(c.id)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="font-semibold text-ink">{c.handle}</span>
                              <PosBadge pos={c.position} alt={c.altPositions} />
                              <TierBadge tier={playerTier(c)} />
                              <span className="text-faint">{ageOf(g, c)} 岁 · 评分 {overallRating(c).toFixed(1)}</span>
                              {myStarters.has(c.id) && <span className="text-[10px] text-gold" title="本队首发">首发</span>}
                            </span>
                            <span className="mt-0.5 block text-[11px] text-mute">
                              {shown && !shown.refused ? (
                                <>
                                  身价 {formatGold(shown.marketValue)} × {shown.factor.toFixed(2)} ≈ <span className="text-gold tabular">{formatGold(shown.value)}</span>
                                  {shown.notes.length > 0 && <span className="text-faint">（{shown.notes.join('；')}）</span>}
                                </>
                              ) : (
                                <span className="text-bad">{shown?.refused ?? it?.refused ?? '无法估值'}</span>
                              )}
                            </span>
                            {/* 触屏看不到 title：不能再勾选的原因（人数上限）直接写在行内；拒收原因上一行已显示 */}
                            {reason && reason !== it?.refused && <span className="mt-0.5 hidden text-[11px] text-bad pointer-coarse:block">{reason}</span>}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
          {trading && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-gold/30 bg-gold/5 px-3 py-2 text-xs">
              <span className="text-mute">
                现金 <Gold value={fee} /> + 抵价 <Gold value={playersValue} /> ＝ 报价总额
              </span>
              <Gold value={total} className="text-sm font-semibold" />
              {releaseNames && (
                <span className="w-full text-[11px] text-faint" title="对方阵容超出 AI 上限时，同回合放走保留价值最低的替补（不放首发、不放刚收下的抵价选手）">
                  成交后 {owner?.name ?? '对方'} 阵容超员，将放走替补 <span className="text-mute">{releaseNames}</span>（成为自由选手）
                </span>
              )}
            </div>
          )}
        </div>

        {/* 估算 */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md border border-line px-2 py-2 sm:px-3">
            <div className="text-[11px] text-faint max-sm:leading-tight">对方接受（估算）</div>
            {total <= rejectedFee ? (
              <span className="text-xs text-bad" title="本回合对方已拒绝过不低于此总额的报价">已拒绝此价位</span>
            ) : (
              <PctBadge value={accept} title={trading ? '按报价总额（现金 + 抵价估值）/ 身价、选手在原队重要度与归属感估算' : '按报价/身价、选手在原队重要度与归属感估算'} />
            )}
          </div>
          <div className="rounded-md border border-line px-2 py-2 sm:px-3">
            <div className="text-[11px] text-faint max-sm:leading-tight">选手意愿</div>
            {playerRefused ? (
              <span className="text-xs text-bad" title="本回合谈判结果已固定，下回合可再谈">本回合拒绝</span>
            ) : (
              <PctBadge value={info.will} title="俱乐部荣誉越高，选手越愿意加盟" />
            )}
          </div>
          <div className="rounded-md border border-line px-2 py-2 sm:px-3">
            <div className="text-[11px] text-faint max-sm:leading-tight">综合成功率（估算）</div>
            <PctBadge value={overall} />
          </div>
        </div>

        {!block && !trading && overNote && <Banner tone="info" title="将超出常规阵容上限">{overNote}。</Banner>}

        {block ? (
          <Banner tone="warn" title="当前无法报价">{block}</Banner>
        ) : (
          <div className="text-[11px] leading-relaxed text-faint">
            对方会立即答复；报价{trading ? '总额' : ''}越高接受概率越大，原队核心与高归属感选手更难挖。同一回合内对方与选手的态度不会改变：被俱乐部拒绝可以提高{trading ? '总额' : '报价'}重试，被选手本人拒绝则需下回合再谈。成交后签下 {tier} 级选手可获得荣誉 +{CONFIG.honor.transfer.signTierBonus[tier] ?? 0}，工资按其当前能力重新核定{trading ? '；抵价选手按市场工资加盟对方，不扣荣誉' : ''}。
          </div>
        )}
      </div>
    </Modal>
  );
}

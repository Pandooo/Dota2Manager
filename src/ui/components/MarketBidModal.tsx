// 转会报价弹窗：转会费滑块（建议价 0.6×–2.5×）→ bidForPlayer
import { useState } from 'react';
import { useCall, useGame } from '../../store/gameStore';
import {
  CONFIG, ageOf, effectiveAttr, effectivePower, formatGold, marketValue, overallRating, playerTier,
  playerWillingness, rosterSigningBlock, rosterSigningNote, signingSalary, suggestedFee, REGION_LABEL,
} from '../../engine';
import { Button, Gold, Modal, PosBadge, TeamTag, TierBadge, cx } from './common';
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

  if (!playerId) return null;

  if (!p || !info || !myTeam) {
    return (
      <Modal open onClose={onClose} title="转会报价" width="max-w-md">
        <div className="text-sm text-mute">该选手已不在市场上（可能已转会、退役或被禁赛）。</div>
      </Modal>
    );
  }

  const setBoth = (v: number) => {
    const clamped = Math.max(info.min, Math.min(info.max, roundFee(v)));
    setFee(clamped);
    setText(String(clamped));
  };

  // 只有达到绝对上限才不能报价；超出常规上限只做提示
  const rosterBlock = safe<string | null>(() => rosterSigningBlock(g, me), null);
  const overNote = safe<string | null>(() => rosterSigningNote(g, me), null);
  const gold = num(myTeam.gold);
  // 本回合谈判记录：对方拒绝过的最高报价 / 选手本人是否已拒绝
  const rejectedFee = rejectedBidOf(g, p.id);
  const playerRefused = isRefused(g, p.id, info.will);
  const accept = fee <= rejectedFee ? 0 : aiAcceptEstimate(g, p, fee);
  const overall = info.will === null ? null : playerRefused ? 0 : accept * info.will;
  const ratio = info.suggested > 0 ? fee / info.suggested : 1;

  const block = ((): string | null => {
    if (g.gameOver) return '游戏已结束';
    if (!windowOpen) return '转会窗口已锁定（TI 阶段）';
    if (p.status !== 'active') return `${p.handle} 当前无法转会（已退役或被禁赛）`;
    if (p.tempSubUntilTournament || p.isWildSub) return '临时替补无法转会';
    if (p.teamId === me) return '该选手已在你的战队';
    if (!p.teamId) return '该选手已成为自由选手，请在「自由选手」页签约';
    if (rosterBlock) return rosterBlock;
    if (playerRefused) return `${p.handle} 本回合已明确拒绝加盟，下回合再谈（或先提升俱乐部荣誉）`;
    if (fee <= 0) return '报价金额无效';
    if (fee <= rejectedFee) return `${owner?.name ?? '对方'} 本回合已拒绝 ${formatGold(rejectedFee)} 的报价，需要报更高的价格`;
    if (gold < fee) return `金币不足（需要 ${formatGold(fee)}，当前 ${formatGold(gold)}）`;
    return null;
  })();

  const submit = () => {
    if (block) return;
    const id = p.id;
    const offer = fee;
    const will = info.will ?? 1;
    void call('bidForPlayer', id, offer).then((res) => {
      if (!res) return;
      if (res.ok) {
        onClose();
        return;
      }
      // 同一回合谈判骰子固定：记录失败原因，避免重复提交必然失败的报价
      if (res.message.includes('不愿加盟')) markRefused(g, id, will);
      else if (res.message.includes('拒绝了对')) markBidRejected(g, id, offer);
    });
  };

  const tier = playerTier(p);
  const age = ageOf(g, p);

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
        <>
          <span className="mr-auto self-center text-xs text-mute">
            报价后余额 <Gold value={gold - fee} />
          </span>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!!block} title={block ?? '提交报价，对方将立即答复'} onClick={submit}>
            提交报价 {formatGold(fee)}
          </Button>
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
              <div className="text-[10px] text-faint">{label}</div>
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

        {/* 报价 */}
        <div className="rounded-lg border border-line p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs text-mute">你的报价</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={text}
                min={info.min}
                max={info.max}
                step={CONFIG.market.feeRounding}
                onChange={(e) => {
                  setText(e.target.value);
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= info.min && v <= info.max) setFee(roundFee(v));
                }}
                onBlur={() => setBoth(Number(text) || info.suggested)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setBoth(Number(text) || info.suggested);
                }}
                className="h-8 w-32 rounded-md border border-line bg-panel-2 px-2 text-right text-sm tabular text-gold outline-none focus:border-dota/70"
              />
              <span className={cx('w-14 text-right text-xs tabular', ratio >= 1 ? 'text-good' : 'text-bad')}>
                ×{ratio.toFixed(2)}
              </span>
            </div>
          </div>
          <input
            type="range"
            min={info.min}
            max={info.max}
            step={CONFIG.market.feeRounding}
            value={Math.max(info.min, Math.min(info.max, fee))}
            onChange={(e) => setBoth(Number(e.target.value))}
            className="w-full cursor-pointer accent-[#e5b24d]"
          />
          <div className="mt-1 flex justify-between text-[10px] text-faint tabular">
            <span>{formatGold(info.min)}（×{MIN_MULT}）</span>
            <span>{formatGold(info.max)}（×{MAX_MULT}）</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK.map((m) => (
              <button
                key={m}
                onClick={() => setBoth(info.suggested * m)}
                className={cx(
                  'cursor-pointer rounded border px-2 py-0.5 text-xs tabular transition-colors',
                  Math.abs(ratio - m) < 0.01 ? 'border-gold/60 bg-gold/15 text-gold' : 'border-line text-mute hover:text-ink',
                )}
              >
                {m === 1 ? '建议价' : `×${m}`}
              </button>
            ))}
          </div>
        </div>

        {/* 估算 */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md border border-line px-3 py-2">
            <div className="text-[11px] text-faint">对方接受（估算）</div>
            {fee <= rejectedFee ? (
              <span className="text-xs text-bad" title="本回合对方已拒绝过不低于此金额的报价">已拒绝此价位</span>
            ) : (
              <PctBadge value={accept} title="按报价/身价、选手在原队重要度与归属感估算" />
            )}
          </div>
          <div className="rounded-md border border-line px-3 py-2">
            <div className="text-[11px] text-faint">选手意愿</div>
            {playerRefused ? (
              <span className="text-xs text-bad" title="本回合谈判结果已固定，下回合可再谈">本回合拒绝</span>
            ) : (
              <PctBadge value={info.will} title="俱乐部荣誉越高，选手越愿意加盟" />
            )}
          </div>
          <div className="rounded-md border border-line px-3 py-2">
            <div className="text-[11px] text-faint">综合成功率（估算）</div>
            <PctBadge value={overall} />
          </div>
        </div>

        {!block && overNote && <Banner tone="info" title="将超出常规阵容上限">{overNote}。</Banner>}

        {block ? (
          <Banner tone="warn" title="当前无法报价">{block}</Banner>
        ) : (
          <div className="text-[11px] leading-relaxed text-faint">
            对方会立即答复；报价越高接受概率越大，原队核心与高归属感选手更难挖。同一回合内对方与选手的态度不会改变：
            被俱乐部拒绝可以提高报价重试，被选手本人拒绝则需下回合再谈。成交后签下 {tier} 级选手可获得荣誉
            +{CONFIG.honor.transfer.signTierBonus[tier] ?? 0}，工资按其当前能力重新核定。
          </div>
        )}
      </div>
    </Modal>
  );
}

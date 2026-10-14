// 新秀抽卡（转会中心标签页；2026-10-14 用户决策：抽卡回归并取代新秀选秀，新增「请神」与名人堂）：
// 本赛季卡池（各等级剩余的真实 / 请神 / 虚构卡）、单抽 / 十连价格、SSR 保底进度、抽卡按钮（就近确认，显示花费）、
// 本次结果（等级配色、真实 / 请神徽章与原型、本回合内退回）、本赛季抽卡记录、规则与往届汇总。
// 只读引擎查询（gachaView / gachaLog / gachaPullBlock / gachaDiscardBlock）；操作经 call('gachaPull' | 'gachaDiscard')。
import { useEffect, type ReactNode } from 'react';
import { useCall, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, GACHA_KIND_LABEL, ageOf, effectiveAttr, effectivePower, formatGold, gachaDiscardBlock, gachaHistory, gachaLog,
  gachaOverCapAfter, gachaPullBlock, gachaRookieWageCap, gachaTierProbabilities, gachaView, isTransferWindowOpen, pediaHasPlayer, playerTier, rosterOverCap,
  rosterOverCapNotice, rosterOverflowNotice, rosterSigningNote, rosterSize,
  type GachaCardKind, type GachaPullRecord, type GachaSeasonRecord, type GachaView, type GameState, type Player, type Tier,
} from '../../engine';
import { Badge, Button, Card, EmptyState, Gold, PlayerLink, PosBadge, TierBadge, cx } from '../components/common';
import { ConfirmButton } from '../components/ConfirmPopover';
import { ScreenHeader } from '../layout/HubKit';
import { AttrNum, Banner, Meter, TableWrap, num, safe } from '../components/MarketKit';
import { openPedia } from '../components/PediaKit';
import { useNewFeature } from '../components/NewBadge';
import { gachaDiscardConfirm } from '../components/gachaDiscard';

const pct = (v: number, digits = 1) => `${(num(v) * 100).toFixed(digits)}%`;

/** 卡种徽章：真实新秀 / 请神（原型）；虚构新秀不加徽章 */
export function GachaKindBadge({ kind, proto, protoHandle }: { kind: GachaCardKind; proto?: string; protoHandle?: string }) {
  if (kind === 'real') return <Badge className="bg-gold/15 text-gold" title="真实新秀：能力与成长参照其真实历史生涯">★真实</Badge>;
  if (kind === 'summon') {
    return (
      <Badge
        className="bg-[#7a4fb5]/20 text-[#c39cff]"
        title={`请神新秀：出道能力与之后的成长走势复制名人堂成员 ${protoHandle ?? proto ?? ''}`}
      >
        请神 · {protoHandle ?? proto}
      </Badge>
    );
  }
  return null;
}

const TIER_TILE: Record<Tier, string> = {
  C: 'border-tier-c/40 bg-tier-c/5',
  B: 'border-tier-b/40 bg-tier-b/5',
  A: 'border-tier-a/40 bg-tier-a/5',
  S: 'border-tier-s/50 bg-tier-s/10',
  SS: 'border-tier-ss/60 bg-tier-ss/10',
  SSR: 'border-[#ff4d6d]/60 bg-gradient-to-br from-[#ffd54a]/15 to-[#ff4d6d]/15',
};

function MiniStat({ label, value, sub, children }: { label: ReactNode; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2/60 px-3 py-2">
      <div className="text-[11px] tracking-wider text-faint">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular">{value}</div>
      {sub && <div className="text-xs text-faint">{sub}</div>}
      {children}
    </div>
  );
}

/** 一张抽卡结果（本次 / 本回合） */
function ResultTile({ g, rec, onDiscard }: { g: GameState; rec: GachaPullRecord; onDiscard: (id: string) => void }) {
  const p: Player | undefined = g.players[rec.playerId];
  const block = rec.discarded ? '已退回' : safe(() => gachaDiscardBlock(g, p), '暂不可退回');
  const refund = Math.round(num(rec.cost) * num(CONFIG.gacha.discardRefundRatio));
  return (
    <div className={cx('flex flex-col gap-1.5 rounded-lg border px-3 py-2', TIER_TILE[rec.tier], rec.discarded && 'opacity-50')}>
      <div className="flex items-center gap-2">
        <TierBadge tier={rec.tier} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {p ? <PlayerLink player={p} className="truncate font-semibold" /> : <span className="font-semibold">{rec.handle}</span>}
            {rec.pity && <Badge className="bg-gold/20 text-gold" title="SSR 保底触发">保底</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <GachaKindBadge kind={rec.kind} proto={rec.proto} protoHandle={rec.protoHandle} />
            {p && <PosBadge pos={p.position} alt={p.altPositions} />}
          </div>
        </div>
      </div>
      {p && (
        <div className="text-xs text-mute">
          {safe(() => ageOf(g, p), 0)} 岁 · 战力 <AttrNum value={effectivePower(p)} digits={1} /> · 天赋 <AttrNum value={effectiveAttr(p, 'talent')} /> · 工资{' '}
          <Gold value={num(p.salary)} />/回合
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-faint">{rec.discarded ? '已退回（进入自由市场）' : p?.teamId === g.settings.playerTeamId ? `新秀合同至 TI${p.contractUntil}` : '已离队'}</span>
        {!rec.discarded && (
          <ConfirmButton
            size="xs"
            variant="ghost"
            disabled={!!block}
            title={block ?? `退回 ${rec.handle}：返还 ${formatGold(refund)}，他将进入自由市场`}
            confirm={gachaDiscardConfirm({ handle: rec.handle, refund, kind: rec.kind, protoHandle: rec.protoHandle })}
            onConfirm={() => onDiscard(rec.playerId)}
          >
            退回
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}

/** 卡池剩余构成（按等级） */
function PoolTable({ view }: { view: GachaView }) {
  return (
    <TableWrap>
      <table className="tbl">
        <thead>
          <tr>
            <th>等级</th>
            <th className="num" title="本届真实新秀（能力参照真实历史）">真实</th>
            <th className="num" title="请神卡：复制名人堂成员（出道等级与卡的等级相同）">请神</th>
            <th className="num">虚构</th>
            <th className="num">剩余</th>
            <th className="num" title="按剩余张数，下一抽抽到该等级的概率">下一抽</th>
            <th className="num" title="本赛季放进卡池的卡（真实 / 请神 / 虚构，含第 1 回合前真实新秀离池时补入的卡与抽空后的补充卡池），不是已抽出的张数">本季入池（真/请/虚）</th>
          </tr>
        </thead>
        <tbody>
          {view.tiers.map((t) => (
            <tr key={t.tier}>
              <td><TierBadge tier={t.tier} /></td>
              <td className={cx('num', t.real ? 'text-gold' : 'text-faint')}>{t.real}</td>
              <td className={cx('num', t.summon ? 'text-[#c39cff]' : 'text-faint')}>{t.summon}</td>
              <td className={cx('num', !t.fictional && 'text-faint')}>{t.fictional}</td>
              <td className="num font-semibold">{t.total}</td>
              <td className="num">{pct(t.chance)}</td>
              <td className="num text-xs text-mute">{t.made[0]} / {t.made[1]} / {t.made[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function HistoryTable({ list }: { list: GachaSeasonRecord[] }) {
  if (!list.length) return <EmptyState text="暂无往届抽卡记录（每届卡池在 TI 预选赛转会锁定时关闭后记入）。" />;
  return (
    <TableWrap>
      <table className="tbl">
        <thead>
          <tr>
            <th>届次</th>
            <th className="num">卡池张数</th>
            <th className="num">抽出（AI）</th>
            <th className="num">SSR</th>
            <th className="num">请神</th>
            <th className="num" title="未被抽走的真实新秀（第 1 回合开始前离开卡池）：按出道去向加盟职业战队 / 进入自由市场">真实新秀加盟 / 自由</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.ti}>
              <td>TI{r.ti}</td>
              <td className="num">
                {r.size}
                {r.base > CONFIG.gacha.poolSize && <span className="ml-1 text-[10px] text-faint" title="真实新秀超出比例，基础卡池按比例放大">放大</span>}
                {r.refills > 0 && <span className="ml-1 text-[10px] text-faint">补充 {r.refills}</span>}
              </td>
              <td className="num">{r.drawn}（{r.aiDrawn}）</td>
              <td className="num">{r.ssr}</td>
              <td className="num">{r.summons}</td>
              <td className="num">{r.realJoined} / {r.realFree}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export default function Gacha() {
  const g = useGame();
  const call = useCall();
  const setView = useGameStore((s) => s.setView);
  const me = g.settings.playerTeamId;
  const team = g.teams[me];
  const view = safe(() => gachaView(g, me), null as GachaView | null);
  const log = safe(() => gachaLog(g, me), [] as GachaPullRecord[]);
  const history = safe(() => gachaHistory(g), [] as GachaSeasonRecord[]);
  const probs = safe(() => gachaTierProbabilities(), null as Record<Tier, number> | null);
  const blockOne = safe(() => gachaPullBlock(g, 1), '暂不可抽卡');
  const blockTen = safe(() => gachaPullBlock(g, 10), '暂不可抽卡');
  const note = safe<string | null>(() => rosterSigningNote(g, me), null);
  const overflow = safe<string | null>(() => rosterOverflowNotice(g, me), null);
  // 超编（2026-10-15 用户决策「十连后本回合内退回到 12 人」）：抽卡可超出绝对上限，须在本回合内退回。
  // 与推进阻塞 / 总览待处理同口径：只在转会窗口开放时提示（锁定期不检查超编，也不能解约）
  const windowOpen = safe(() => isTransferWindowOpen(g), g.phase === 'preseason' || g.phase === 'regular');
  const overCap = safe(() => rosterOverCap(g, me), 0);
  const overCapNote = windowOpen ? safe<string | null>(() => rosterOverCapNotice(g, me), null) : null;
  const lazy = useGameStore((st) => st.lazyAdvance);
  const wageCap = safe(() => gachaRookieWageCap(g), Infinity);
  // 从总览 / 侧栏直接进入本页时，「转会 › 新秀抽卡」标签上的 New 徽标也算找到了
  const { show: badgeShown, dismiss: dismissBadge } = useNewFeature('gacha');
  useEffect(() => {
    if (badgeShown) dismissBadge();
  }, [badgeShown, dismissBadge]);

  if (!team || !view) {
    return (
      <>
        <ScreenHeader title="新秀抽卡" />
        <EmptyState text="找不到你的战队数据。">
          <Button onClick={() => setView('dashboard')}>返回总览</Button>
        </EmptyState>
      </>
    );
  }

  // 本回合的抽卡（最新一次操作在前）
  const thisRound = log.filter((r) => r.round === g.roundIndex);
  const lastBatch = thisRound[0]?.batch;
  const latest = thisRound.filter((r) => r.batch === lastBatch).slice().reverse();
  const earlier = thisRound.filter((r) => r.batch !== lastBatch);
  const ssrChance = view.tiers.find((t) => t.tier === 'SSR')?.chance ?? 0;
  const pityLeft = Math.max(0, view.pityThreshold - view.pity);
  const pull = (n: number) => void call('gachaPull', n);
  const discard = (id: string) => void call('gachaDiscard', id);
  const hard = CONFIG.team.hardMaxRoster;
  /** 按钮说明：抽完会超编时注明（不禁用：总是抽满，本回合内退回） */
  const overAfterTitle = (n: number) => {
    const over = safe(() => gachaOverCapAfter(g, n), 0);
    return over > 0 ? `（抽完超编 ${over} 人，需在本回合内退回 ${hard} 人）` : '';
  };
  const confirmPull = (n: number) => {
    const over = safe(() => gachaOverCapAfter(g, n), 0);
    const after = safe(() => rosterSize(g, me), 0) + n;
    return {
      title: n === 10 ? '十连抽？' : '单抽？',
      confirmLabel: n === 10 ? `十连 · ${formatGold(view.ten)}` : `单抽 · ${formatGold(view.single)}`,
      message: (
        <>
          花费 <b className="text-ink">{formatGold(n === 10 ? view.ten : view.single)}</b> 从卡池（剩余 {view.remaining} 张）均匀抽 {n} 张，新秀立即签下新秀合同入队（工资按等级标准 × 新秀折扣{Number.isFinite(wageCap) ? `，不超过 ${formatGold(wageCap)}/回合` : ''}）。本回合内可退回，返还单抽价格的 {Math.round(num(CONFIG.gacha.discardRefundRatio) * 100)}%；之后入队满 {CONFIG.gacha.resaleHoldRounds} 个转会回合（约一个赛季）前不能挂牌出售。
          {pityLeft <= n && <span className="mt-1 block text-gold">这次将触发 SSR 保底。</span>}
          {over > 0 ? (
            <span className="mt-1 block text-bad">
              抽完后阵容 {after}/{hard} 人，超编 {over} 人：抽完后需在本回合内退回 {hard} 人（放弃本回合抽到的新秀或解约），否则不能进入下一回合。
              {lazy && (
                <span className="text-mute">
                  已开启「下一回合」自动处理：不手动处理时，按下一回合会自动退回本回合抽到的新秀中评分最低的 {over} 名（不论等级，返还单抽价格的 {Math.round(num(CONFIG.gacha.discardRefundRatio) * 100)}%）。
                </span>
              )}
            </span>
          ) : (
            note && <span className="mt-1 block text-mute">{note}</span>
          )}
        </>
      ),
    };
  };

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="新秀抽卡"
        subtitle={`TI${view.ti} 赛季卡池 · 转会窗口开放期间可抽（先到先得），TI 预选赛转会锁定时卡池关闭 · 真实新秀卡只在赛季初（第 1 回合开始前）可抽`}
        nav={<Button size="sm" variant="ghost" onClick={() => setView('squad')}>查看阵容</Button>}
      />

      {!view.open && (
        <Banner tone="info" title={view.size ? '本赛季卡池已关闭' : '本赛季卡池尚未开放'}>
          {view.size
            ? '转会窗口已锁定（TI 预选赛与正赛）。TI 结算后的新赛季开放新卡池。'
            : '卡池在每个赛季初建立（读取旧存档时从下个赛季初开始）。'}
        </Banner>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MiniStat
          label="卡池剩余"
          value={`${view.remaining} / ${view.size || '—'}`}
          sub={
            view.size
              ? `本赛季已抽出 ${view.drawn} 张（AI 战队 ${view.aiDrawn}）${view.refills ? ` · 已补充 ${view.refills} 次` : ''}${view.enlargedBy.length ? ` · 真实新秀超出比例（${view.enlargedBy.join('、')}），卡池按比例放大` : ''}`
              : '—'
          }
        />
        <MiniStat label="价格" value={<><Gold value={view.single} /> <span className="text-sm text-faint">/ 单抽</span></>} sub={`十连 ${formatGold(view.ten)}（不打折）· 随年代经济指数变化`} />
        <MiniStat label="SSR 保底" value={`${view.pity} / ${view.pityThreshold}`} sub={`再抽 ${pityLeft} 张必出 SSR · 下一抽 SSR 概率 ${pct(ssrChance)}`}>
          <Meter className="mt-1.5" value={view.pity} max={Math.max(1, view.pityThreshold - 1)} color={pityLeft <= 10 ? 'bg-gold' : 'bg-tier-s'} />
        </MiniStat>
        <MiniStat label="本赛季我已抽" value={`${view.seasonPulls} 张`} sub={`资金 ${formatGold(team.gold)}`} />
      </div>

      {overCapNote ? (
        <Banner
          tone="bad"
          title={`超编 ${overCap} 人：阵容 ${overCap + hard}/${hard}`}
          actions={<Button size="sm" onClick={() => setView('squad')} title="在阵容页解约或出售队员">去阵容页解约</Button>}
        >
          {overCapNote}。可以在下方结果中「退回」本回合抽到的新秀（返还单抽价格的 {Math.round(num(CONFIG.gacha.discardRefundRatio) * 100)}%），
          或在阵容页解约 / 出售其他队员（挂牌不算，成交离队后才算）。
          {lazy ? '已开启「下一回合」自动处理：按下一回合时先自动退回评分最低的新秀，仍超编再解约替补中代价（解约补偿 + 身价）最低者。' : ''}
          超编期间不能再抽卡。
        </Banner>
      ) : overflow && (
        <Banner tone="info" title="阵容超出常规上限" actions={<Button size="sm" onClick={() => setView('squad')}>安排首发与替补</Button>}>
          {overflow}。这不影响推进；本回合抽到的新秀可以退回。
        </Banner>
      )}

      {/* 窄屏单列用 minmax(0,1fr)：卡池表等宽内容在卡片内横向滚动，不把整列（和卡片右上角的抽卡按钮）撑出屏幕 */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card
          title="抽卡"
          subtitle="卡池内均匀不放回抽取；新秀立即入队，首发与替补由你在阵容页安排"
          actions={
            <>
              <ConfirmButton variant="gold" disabled={!!blockOne} title={blockOne ?? `单抽：${formatGold(view.single)}${overAfterTitle(1)}`} confirm={confirmPull(1)} onConfirm={() => pull(1)}>
                单抽 · {formatGold(view.single)}
              </ConfirmButton>
              <ConfirmButton variant="primary" disabled={!!blockTen} title={blockTen ?? `十连：${formatGold(view.ten)}${overAfterTitle(10)}`} confirm={confirmPull(10)} onConfirm={() => pull(10)}>
                十连 · {formatGold(view.ten)}
              </ConfirmButton>
            </>
          }
        >
          {latest.length === 0 ? (
            <EmptyState text={view.open ? '本回合还没有抽卡。点击「单抽」或「十连」抽卡。' : '卡池未开放。'} />
          ) : (
            <div className="space-y-3">
              <div className="text-xs text-mute">本次结果（{latest.length} 张）· 本回合内可退回</div>
              <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                {latest.map((r) => <ResultTile key={r.playerId} g={g} rec={r} onDiscard={discard} />)}
              </div>
              {earlier.length > 0 && (
                <>
                  <div className="pt-1 text-xs text-mute">本回合较早的抽卡（{earlier.length} 张）</div>
                  <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                    {earlier.map((r) => <ResultTile key={r.playerId} g={g} rec={r} onDiscard={discard} />)}
                  </div>
                </>
              )}
            </div>
          )}
        </Card>

        <Card title="卡池构成" subtitle={`TI${view.ti} · 剩余 ${view.remaining} 张`} bodyClassName="p-0">
          {view.size ? <PoolTable view={view} /> : <EmptyState text="本赛季没有卡池" />}
          {(view.realLeft.length > 0 || view.summonLeft.length > 0 || view.realReleased) && (
            <div className="space-y-2 border-t border-line px-4 py-3 text-xs">
              {view.realReleased && view.realLeft.length === 0 && (
                <div className="text-faint">
                  本赛季没有被抽走的真实新秀已在第 1 回合开始前按真实出道去向加盟（卡池补入了同等级的请神 / 虚构卡），之后的卡池只有请神与虚构新秀。
                </div>
              )}
              {view.realLeft.length > 0 && (
                <div>
                  <div className="mb-1 text-faint">剩余真实新秀（{view.realLeft.length}）</div>
                  <div className="flex flex-wrap gap-1">
                    {view.realLeft.slice(0, 40).map((x) => (
                      <span key={x.id} className="inline-flex items-center gap-1 rounded border border-gold/30 bg-gold/5 px-1.5 py-0.5">
                        <TierBadge tier={x.tier} />
                        <span className="text-gold">{x.handle}</span>
                      </span>
                    ))}
                    {view.realLeft.length > 40 && <span className="text-faint">……另有 {view.realLeft.length - 40} 名</span>}
                  </div>
                </div>
              )}
              {view.summonLeft.length > 0 && (
                <div>
                  <div className="mb-1 text-faint">剩余请神卡的原型（同一原型每赛季至多 {CONFIG.gacha.summonMaxPerPrototype} 张）</div>
                  <div className="flex flex-wrap gap-1">
                    {view.summonLeft.slice(0, 40).map((x) => {
                      const inner = (
                        <>
                          <TierBadge tier={x.tier} />
                          <span className="text-[#c39cff]">{x.handle}</span>
                          {x.n > 1 && <span className="text-faint">×{x.n}</span>}
                        </>
                      );
                      // 不在本局的 DotA1 时代传奇没有选手页（与「DotaPedia › 名人堂」一致，不做成链接）
                      return safe(() => pediaHasPlayer(g, x.id), false) ? (
                        <button
                          key={`${x.tier}-${x.id}`}
                          type="button"
                          onClick={() => openPedia('player', x.id)}
                          title={`名人堂成员 ${x.handle}（出道等级 ${x.tier}）`}
                          className="inline-flex cursor-pointer items-center gap-1 rounded border border-[#7a4fb5]/40 bg-[#7a4fb5]/10 px-1.5 py-0.5 hover:border-[#c39cff]"
                        >
                          {inner}
                        </button>
                      ) : (
                        <span
                          key={`${x.tier}-${x.id}`}
                          title={`名人堂成员 ${x.handle}（出道等级 ${x.tier}；DotA1 时代传奇，不在本局选手中）`}
                          className="inline-flex items-center gap-1 rounded border border-[#7a4fb5]/40 bg-[#7a4fb5]/10 px-1.5 py-0.5"
                        >
                          {inner}
                        </span>
                      );
                    })}
                    {view.summonLeft.length > 40 && <span className="text-faint">……另有 {view.summonLeft.length - 40} 个</span>}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <Card title="本赛季抽卡记录" subtitle={log.length ? `共 ${log.length} 张（最新在前）` : undefined} bodyClassName="p-0">
          {log.length === 0 ? (
            <EmptyState text="本赛季还没有抽卡。" />
          ) : (
            <TableWrap maxH="max-h-[420px]">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>回合</th>
                    <th>新秀</th>
                    <th>等级</th>
                    <th>卡种</th>
                    <th>现状</th>
                    <th className="num">价格</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((r) => {
                    const p = g.players[r.playerId];
                    const status = r.discarded ? '已退回' : !p ? '—' : p.teamId === me ? '在队' : p.teamId ? `→ ${g.teams[p.teamId]?.tag ?? p.teamId}` : '自由选手';
                    return (
                      <tr key={`${r.playerId}-${r.round}-${r.batch}`} className={cx(r.discarded && 'text-faint')}>
                        <td className="text-xs text-mute">{r.round === 0 ? '赛季初' : `第 ${r.round} 回合`}</td>
                        <td>{p ? <PlayerLink player={p} /> : r.handle}</td>
                        <td>
                          <span className="inline-flex items-center gap-1">
                            <TierBadge tier={r.tier} />
                            {p && playerTier(p) !== r.tier && <span className="text-[10px] text-faint">现 {playerTier(p)}</span>}
                          </span>
                        </td>
                        <td>
                          <span className="inline-flex items-center gap-1">
                            {r.kind === 'fictional' ? <span className="text-xs text-mute">{GACHA_KIND_LABEL.fictional}</span> : <GachaKindBadge kind={r.kind} proto={r.proto} protoHandle={r.protoHandle} />}
                            {r.pity && <Badge className="bg-gold/20 text-gold">保底</Badge>}
                          </span>
                        </td>
                        <td className="text-xs text-mute">{status}</td>
                        <td className="num"><Gold value={r.cost} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card
          title="规则"
          actions={<Button size="xs" variant="ghost" onClick={() => setView('pediaHall')} title="DotaPedia · 名人堂：全部请神原型与在役请神新秀">名人堂 ›</Button>}
        >
          <div className="space-y-2 text-xs leading-relaxed text-mute">
            {probs && (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {(['SSR', 'SS', 'S', 'A', 'B', 'C'] as Tier[]).map((t) => (
                  <span key={t} className="inline-flex items-center gap-1">
                    <TierBadge tier={t} /> <span className="tabular text-ink">{pct(probs[t], 0)}</span>
                  </span>
                ))}
              </div>
            )}
            <p>
              每个赛季初建一个有限卡池：基础 {CONFIG.gacha.poolSize} 张，各等级张数严格按上述比例。每个等级先放本届登场的<b className="text-gold">真实新秀</b>（等级取其出道届的真实水平，超出名额时卡池按比例放大），其余名额约 {Math.round(num(CONFIG.gacha.summonShare) * 100)}% 为<b className="text-[#c39cff]">请神卡</b>、其余为虚构新秀卡。卡池内均匀不放回抽取，所有战队共享、先到先得；抽空后补充一个同比例的卡池。
            </p>
            <p>
              <b className="text-gold">真实新秀</b>只在赛季初（第 1 回合开始前）可抽：开赛时没有被抽走的真实新秀离开卡池，加盟其真实出道战队（出道战队是你的战队时，由你决定签下或放弃），出道战队不在联赛时加盟其他 AI 战队或进入自由市场；卡池补入同等级的请神 / 虚构卡，之后的出卡比例不变。
            </p>
            <p>
              <b className="text-[#c39cff]">请神</b>：虚拟新秀与名人堂成员（DotA1 时代传奇、开局届之前真实历史中达到过 SS / SSR 的选手与本局历届 SS / SSR 选手）构建请神关系——原型的出道等级与卡的等级相同，新秀复制原型的出道能力、天赋与位置，之后每个赛季的成长走势复制原型的生涯。同一原型每赛季至多 {CONFIG.gacha.summonMaxPerPrototype} 张，所以联赛里可能同时有一名真身和几名请神新秀。
            </p>
            <p>
              价格随年代经济指数变化（TI1 单抽 {formatGold(CONFIG.gacha.singleCost)}），十连 = {CONFIG.gacha.tenMult} × 单抽。SSR 保底：距上一张 SSR 第 {view.pityThreshold} 抽必出（计数随战队、跨赛季）。十连 / 单抽总是抽满：抽完超过绝对上限 {hard} 人时，须在本回合内放弃新秀或解约，退回 {hard} 人才能进入下一回合（超编期间不能再抽）。新秀合同 {CONFIG.gacha.rookieContractSeasons} 个赛季{Number.isFinite(wageCap) ? `，工资不超过 ${formatGold(wageCap)}/回合` : ''}；抽到的新秀在同一回合内可退回，返还单抽价格的 {Math.round(num(CONFIG.gacha.discardRefundRatio) * 100)}%；入队满 {CONFIG.gacha.resaleHoldRounds} 个转会回合（约一个赛季）前不能挂牌出售，作为交易抵价时按签字费估值。
            </p>
            <p>
              AI 战队在第 1 回合开始前（你先抽）与赛季中期按资金与阵容空位自动抽卡（每赛季至多 {CONFIG.gacha.aiMaxPullsPerSeason} 张；资金不足或阵容已满时可能不抽，开局赛季常常不抽）。TI 预选赛转会锁定时卡池关闭。
            </p>
          </div>
        </Card>
      </div>

      <Card title="往届抽卡" subtitle={history.length ? `共 ${history.length} 届` : undefined} bodyClassName="p-0">
        <HistoryTable list={history} />
      </Card>
    </div>
  );
}

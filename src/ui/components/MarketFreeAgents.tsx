// 转会市场 · 自由选手：筛选（位置/等级/最低战力/搜索）+ 签约
import { useState } from 'react';
import { useCall, useGame } from '../../store/gameStore';
import {
  CONFIG, POSITIONS, TIERS, ageOf, effectiveAttr, effectivePower, formatGold, freeAgents, marketValue, overallRating,
  playerTier, playerWillingness, rosterRoom, rosterSigningBlock, rosterSigningNote, signingSalary, tierIndex, POSITION_LABEL,
  REGION_LABEL,
  playsNaturally,
  type Player, type Position, type Tier,
} from '../../engine';
import { Button, Card, EmptyState, Gold, PlayerLink, PosBadge, TierBadge, cx } from './common';
import { ConfirmButton } from './ConfirmPopover';
import {
  AttrNum, BODY_FLUSH, Facts, Field, PHONE_LINK, PctBadge, Pager, PhoneFilters, PhoneList, PhoneRow, Select, SortSelect, SortTh, TableWrap,
  TextInput, cmp, expectedSalary, isRefused, markRefused, num, safe, signingFeeOf, usePaged, useSort, useCompactList,
} from './MarketKit';

type SortKey = 'handle' | 'pos' | 'age' | 'tier' | 'power' | 'talent' | 'insight' | 'salary' | 'fee' | 'will';

/** 手机上的排序选项（卡片列表没有表头） */
const SORT_OPTIONS: { k: SortKey; label: string }[] = [
  { k: 'power', label: '战力' },
  { k: 'tier', label: '等级' },
  { k: 'talent', label: '天赋' },
  { k: 'insight', label: '灵性' },
  { k: 'age', label: '年龄' },
  { k: 'fee', label: '签约费' },
  { k: 'salary', label: '工资' },
  { k: 'will', label: '加盟意愿' },
  { k: 'pos', label: '位置' },
  { k: 'handle', label: '选手 ID' },
];

interface Row {
  p: Player;
  age: number;
  tier: Tier;
  power: number;
  talent: number;
  insight: number;
  rating: number;
  value: number;
  fee: number;
  salary: number;
  will: number | null;
}

const PAGE = 50;

export default function MarketFreeAgents({ windowOpen }: { windowOpen: boolean }) {
  const g = useGame();
  const call = useCall();
  const me = g.settings.playerTeamId;
  const team = g.teams[me];
  const [pos, setPos] = useState<'all' | Position>('all');
  const [tier, setTier] = useState<'all' | Tier>('all');
  const [minPower, setMinPower] = useState(0);
  const [q, setQ] = useState('');
  const { sort, toggle, setSort } = useSort<SortKey>('power');
  const phone = useCompactList();

  // 常规上限（软）只做提示；只有达到绝对上限（hardMaxRoster）才不能签约
  const room = safe(() => rosterRoom(g, me), 0);
  const rosterBlock = safe<string | null>(() => rosterSigningBlock(g, me), null);
  const overNote = safe<string | null>(() => rosterSigningNote(g, me), null);
  const gold = num(team?.gold);

  const all: Row[] = safe(() => freeAgents(g), [] as Player[])
    .filter((p) => p && p.status === 'active')
    .map((p) => {
      const value = safe(() => marketValue(g, p), 0);
      return {
        p,
        age: ageOf(g, p),
        tier: playerTier(p),
        power: effectivePower(p),
        talent: effectiveAttr(p, 'talent'),
        insight: effectiveAttr(p, 'insight'),
        rating: overallRating(p),
        value,
        fee: signingFeeOf(g, p),
        // 签约后的工资：按我方俱乐部地位开价（引擎 signingSalary，与 signFreeAgent 实际签约一致）
        salary: safe(() => signingSalary(g, p, me), expectedSalary(g, p)),
        will: safe<number | null>(() => playerWillingness(g, p.id, me), null),
      };
    });

  const needle = q.trim().toLowerCase();
  const filtered = all.filter(
    (r) =>
      (pos === 'all' || playsNaturally(r.p, pos)) && // 含副位置（第十三波）
      (tier === 'all' || r.tier === tier) &&
      r.power >= minPower &&
      (!needle ||
        (r.p.handle ?? '').toLowerCase().includes(needle) ||
        (r.p.name ?? '').toLowerCase().includes(needle) ||
        (r.p.nationality ?? '').toLowerCase() === needle),
  );
  const keyOf = (r: Row): number | string => {
    switch (sort.key) {
      case 'handle': return (r.p.handle ?? '').toLowerCase();
      case 'pos': return POSITIONS.indexOf(r.p.position);
      case 'age': return r.age;
      case 'tier': return tierIndex(r.tier) * 1e5 + r.p.mmr;
      case 'power': return r.power;
      case 'talent': return r.talent;
      case 'insight': return r.insight;
      case 'salary': return r.salary;
      case 'fee': return r.fee;
      case 'will': return r.will ?? -1;
    }
  };
  const sorted = filtered.slice().sort((a, b) => cmp(keyOf(a), keyOf(b), sort.dir) || b.rating - a.rating);
  const paged = usePaged(sorted, PAGE, `${pos}|${tier}|${minPower}|${needle}|${sort.key}|${sort.dir}`);

  const blockOf = (r: Row): string | null => {
    if (!team) return '找不到你的战队';
    if (g.gameOver) return '游戏已结束';
    if (!windowOpen) return '转会窗口已锁定（TI 阶段），TI 结束后开放';
    if (rosterBlock) return rosterBlock;
    if (gold < r.fee) return `金币不足（签约费 ${formatGold(r.fee)}，当前 ${formatGold(gold)}）`;
    if (isRefused(g, r.p.id, r.will)) return `${r.p.handle} 本回合已婉拒邀约，下回合再谈（或先提升荣誉）`;
    return null;
  };

  const doSign = (target: Row) => {
    const id = target.p.id;
    const will = target.will ?? 1;
    void call('signFreeAgent', id).then((res) => {
      // 选手婉拒：本回合谈判骰子固定，标记以免反复尝试（意愿提升后自动解除）
      if (res && !res.ok && res.message.includes('婉拒')) markRefused(g, id, will);
    });
  };

  /** 签约的就近确认气泡：费用、工资、意愿、签约后余额与提示 */
  const signConfirm = (r: Row) => ({
    title: `签约 ${r.p.handle}？`,
    confirmLabel: '支付并签约',
    cancelLabel: '再想想',
    message: (
      <>
        <span className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          <span>签约费 <Gold value={r.fee} className="text-ink" /></span>
          <span>工资 <Gold value={r.salary} className="text-ink" />/回合</span>
          <span>加盟意愿 <PctBadge value={r.will} /></span>
          <span>余额 <Gold value={gold - r.fee} className="text-ink" /></span>
        </span>
        {overNote && <span className="mt-1 block text-info">{overNote}。</span>}
        {(r.will ?? 1) < 0.5 && <span className="mt-1 block text-gold">意愿偏低，可能直接拒绝；提升俱乐部荣誉可提高加盟意愿。</span>}
        <span className="mt-1 block text-faint">
          签约按意愿概率判定，同一回合内结果固定：被婉拒后需等到下回合（或荣誉提升后）再谈。
          {(CONFIG.honor.transfer.signTierBonus[r.tier] ?? 0) > 0 && <> 签下 {r.tier} 级选手荣誉 +{CONFIG.honor.transfer.signTierBonus[r.tier]}。</>}
        </span>
      </>
    ),
  });

  const sp = { sort, onSort: toggle };
  const resetFilters = () => { setPos('all'); setTier('all'); setMinPower(0); setQ(''); };
  const posSelect = (
    <Select value={pos} onChange={(e) => setPos(e.target.value as 'all' | Position)} className="max-sm:w-full">
      <option value="all">全部位置</option>
      {POSITIONS.map((x) => (
        <option key={x} value={x}>{POSITION_LABEL[x]}</option>
      ))}
    </Select>
  );
  const tierSelect = (
    <Select value={tier} onChange={(e) => setTier(e.target.value as 'all' | Tier)} className="max-sm:w-full">
      <option value="all">全部等级</option>
      {TIERS.slice().reverse().map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </Select>
  );
  const powerRange = (
    <input
      type="range"
      min={0}
      max={100}
      step={1}
      value={minPower}
      onChange={(e) => setMinPower(Number(e.target.value))}
      className="h-8 w-40 cursor-pointer accent-[#c23c2a] max-sm:h-10 max-sm:w-full"
    />
  );
  const rosterInfo = (
    <>
      <span title={`常规上限 ${CONFIG.team.maxRoster} 人（可以超出：替补归属感下降更快、工资照付）；绝对上限 ${CONFIG.team.hardMaxRoster} 人`}>
        阵容 <span className={cx('font-semibold tabular', rosterBlock ? 'text-bad' : room < 0 ? 'text-gold' : 'text-ink')}>
          {CONFIG.team.maxRoster - room}/{CONFIG.team.maxRoster}
        </span>
      </span>
      <span className="mx-2 text-faint">|</span>
      可用金币 <Gold value={gold} className="font-semibold" />
    </>
  );
  const signButton = (r: Row, block: string | null, className?: string) => (
    <ConfirmButton
      size={phone ? 'sm' : 'xs'}
      variant={block ? 'secondary' : 'primary'}
      className={className}
      disabled={!!block}
      title={block ?? `支付签约费 ${formatGold(r.fee)} 尝试签约（成功率约 ${Math.round((r.will ?? 0) * 100)}%）${overNote ? `\n${overNote}` : ''}`}
      confirm={signConfirm(r)}
      onConfirm={() => doSign(r)}
    >
      签约
    </ConfirmButton>
  );
  const willCell = (r: Row) =>
    isRefused(g, r.p.id, r.will) ? (
      <span className="text-xs text-bad" title="本回合谈判结果已固定，下回合可再谈">本回合婉拒</span>
    ) : (
      <PctBadge value={r.will} />
    );

  return (
    <Card
      title="自由选手"
      subtitle={`共 ${all.length} 名自由身选手 · 签约费 = 身价 × ${Math.round(CONFIG.economy.signingFeeRatio * 100)}% · 签约成功率取决于选手意愿`}
      bodyClassName={BODY_FLUSH}
    >
      {/* 筛选：手机上为搜索 + 「筛选」开关 + 排序；桌面为一行 */}
      {phone ? (
        <PhoneFilters
          search={<TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 ID / 姓名 / 国籍代码" className="w-full" aria-label="搜索" />}
          active={(pos !== 'all' ? 1 : 0) + (tier !== 'all' ? 1 : 0) + (minPower > 0 ? 1 : 0)}
          onReset={resetFilters}
          sort={<SortSelect options={SORT_OPTIONS} sort={sort} onChange={setSort} />}
        >
          <Field label="位置">{posSelect}</Field>
          <Field label="天梯等级">{tierSelect}</Field>
          <Field label={`最低战力 ≥ ${minPower}`} className="col-span-2">{powerRange}</Field>
        </PhoneFilters>
      ) : (
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
          <Field label="搜索">
            <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID / 姓名 / 国籍代码" className="w-44" />
          </Field>
          <Field label="位置">{posSelect}</Field>
          <Field label="天梯等级">{tierSelect}</Field>
          <Field label={`最低战力 ≥ ${minPower}`}>{powerRange}</Field>
          {(pos !== 'all' || tier !== 'all' || minPower > 0 || q) && (
            <Button size="sm" variant="ghost" onClick={resetFilters}>
              重置筛选
            </Button>
          )}
          <div className="ml-auto text-xs text-mute">{rosterInfo}</div>
        </div>
      )}

      {all.length === 0 ? (
        <EmptyState text="当前自由选手池为空">
          <span className="text-xs text-faint">每个赛季初与回合推进时市场会补充新的自由选手；落选的新秀也会进入自由市场。</span>
        </EmptyState>
      ) : sorted.length === 0 ? (
        <EmptyState text="没有符合筛选条件的选手，试试放宽条件。" />
      ) : (
        <>
          {phone ? (
            <PhoneList>
              {paged.rows.map((r) => {
                const block = blockOf(r);
                return (
                  <PhoneRow
                    key={r.p.id}
                    head={
                      <>
                        <TierBadge tier={r.tier} />
                        <PlayerLink player={r.p} className={PHONE_LINK} />
                        {r.p.isReal && r.p.isRookie && <span className="text-[10px] text-gold">★新秀</span>}
                        <span className="text-[10px] text-faint">{r.p.nationality}</span>
                        <PosBadge pos={r.p.position} alt={r.p.altPositions} />
                      </>
                    }
                    action={signButton(r, block, 'min-h-10 min-w-16')}
                  >
                    <Facts
                      items={[
                        ['战力', <span className="font-semibold"><AttrNum value={r.power} digits={1} /></span>],
                        ['天赋', <AttrNum value={r.talent} />],
                        ['灵性', <AttrNum value={r.insight} />],
                        ['年龄', <span className="tabular text-ink">{r.age}</span>],
                      ]}
                    />
                    <Facts
                      items={[
                        ['签约费', <Gold value={r.fee} />],
                        ['工资', <><Gold value={r.salary} />/回合</>],
                        ['意愿', willCell(r)],
                      ]}
                    />
                  </PhoneRow>
                );
              })}
            </PhoneList>
          ) : (
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <SortTh k="handle" {...sp}>选手</SortTh>
                    <SortTh k="pos" {...sp}>位置</SortTh>
                    <SortTh k="age" {...sp} num>年龄</SortTh>
                    <SortTh k="tier" {...sp}>等级</SortTh>
                    <SortTh k="power" {...sp} num>战力</SortTh>
                    <SortTh k="talent" {...sp} num>天赋</SortTh>
                    <SortTh k="insight" {...sp} num>灵性</SortTh>
                    <SortTh k="salary" {...sp} num title="签约后的每大回合工资（按当前等级/战力/年代重算；高荣誉俱乐部需按自身地位开出更高的工资）">工资/回合</SortTh>
                    <SortTh k="fee" {...sp} num title="身价 × 签约费比例">签约费</SortTh>
                    <SortTh k="will" {...sp} title="选手加盟意愿（受俱乐部荣誉影响），即签约成功概率">意愿</SortTh>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((r) => {
                    const block = blockOf(r);
                    return (
                      <tr key={r.p.id}>
                        <td>
                          <div className="flex items-center gap-1.5">
                            <PlayerLink player={r.p} />
                            {r.p.isReal && r.p.isRookie && <span className="text-[10px] text-gold" title="真实新秀">★</span>}
                            <span className="text-[10px] text-faint" title={REGION_LABEL[r.p.region]}>{r.p.nationality}</span>
                          </div>
                        </td>
                        <td><PosBadge pos={r.p.position} alt={r.p.altPositions} /></td>
                        <td className="num">{r.age}</td>
                        <td><TierBadge tier={r.tier} /></td>
                        <td className="num font-semibold"><AttrNum value={r.power} digits={1} /></td>
                        <td className="num"><AttrNum value={r.talent} /></td>
                        <td className="num"><AttrNum value={r.insight} /></td>
                        <td className="num"><Gold value={r.salary} /></td>
                        <td className="num"><Gold value={r.fee} /></td>
                        <td>{willCell(r)}</td>
                        <td className="text-right">{signButton(r, block)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
          <Pager {...paged} onChange={paged.setPage} unit="人" />
        </>
      )}
    </Card>
  );
}

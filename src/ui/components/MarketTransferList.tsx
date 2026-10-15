// 转会市场 · 转会求购：其他战队全部选手（搜索/位置/等级/赛区/战队 筛选 + 分页 50/页）→ 报价弹窗
import { useState } from 'react';
import { useGame } from '../../store/gameStore';
import {
  CONFIG, POSITIONS, REGIONS, TIERS, ageOf, effectiveAttr, effectivePower, marketValue, overallRating, playerTier,
  suggestedFee, tierIndex, POSITION_LABEL, POSITION_SHORT, REGION_LABEL, formatGold,
  playsNaturally, playerRating, roleFit, roleFitText,
  type Player, type Position, type Region, type Team, type Tier,
} from '../../engine';
import { Button, Card, EmptyState, Gold, PlayerLink, PosBadge, TeamLink, TierBadge, cx } from './common';
import { TeamEmblem } from './TeamEmblem';
import {
  AttrNum, BODY_FLUSH, Facts, Field, PHONE_LINK, Pager, PhoneFilters, PhoneList, PhoneRow, Select, SortSelect, SortTh, TableWrap, TextInput,
  cmp, num, safe, usePaged, useSort, useCompactList,
} from './MarketKit';
import MarketBidModal from './MarketBidModal';

type SortKey = 'handle' | 'team' | 'pos' | 'age' | 'tier' | 'power' | 'rating' | 'talent' | 'value' | 'contract';

/** 手机上的排序选项（卡片列表没有表头） */
const SORT_OPTIONS: { k: SortKey; label: string }[] = [
  { k: 'rating', label: '评分' },
  { k: 'power', label: '战力' },
  { k: 'tier', label: '等级' },
  { k: 'talent', label: '天赋' },
  { k: 'age', label: '年龄' },
  { k: 'value', label: '身价' },
  { k: 'contract', label: '合同到期' },
  { k: 'team', label: '战队' },
  { k: 'pos', label: '位置' },
  { k: 'handle', label: '选手 ID' },
];

interface Row {
  p: Player;
  team: Team;
  age: number;
  tier: Tier;
  power: number;
  rating: number;
  talent: number;
  value: number;
  starter: boolean;
}

const PAGE = 50;

export default function MarketTransferList({ windowOpen }: { windowOpen: boolean }) {
  const g = useGame();
  const me = g.settings.playerTeamId;
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<'all' | Position>('all');
  const [tier, setTier] = useState<'all' | Tier>('all');
  const [region, setRegion] = useState<'all' | Region>('all');
  const [teamId, setTeamId] = useState<string>('all');
  const [bidId, setBidId] = useState<string | null>(null);
  const { sort, toggle, setSort } = useSort<SortKey>('rating');
  const phone = useCompactList();

  const otherTeams = Object.values(g.teams)
    .filter((t) => t && t.id !== me && !t.disbanded)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'zh-CN'));

  const all: Row[] = [];
  for (const t of otherTeams) {
    const starters = new Set(Object.values(t.lineup ?? {}).filter(Boolean) as string[]);
    for (const id of t.playerIds ?? []) {
      const p = g.players[id];
      if (!p || p.status !== 'active' || p.teamId !== t.id || p.tempSubUntilTournament || p.isWildSub) continue;
      all.push({
        p,
        team: t,
        age: ageOf(g, p),
        tier: playerTier(p),
        power: effectivePower(p),
        // 按位置筛选时为打该位置的评分（副位置 ×0.95 等已计入），否则为本位置综合评分
        rating: pos === 'all' ? overallRating(p) : safe(() => playerRating(p, pos), overallRating(p)),
        talent: effectiveAttr(p, 'talent'),
        value: safe(() => marketValue(g, p), 0),
        starter: starters.has(p.id),
      });
    }
  }

  const needle = q.trim().toLowerCase();
  const filtered = all.filter(
    (r) =>
      (pos === 'all' || playsNaturally(r.p, pos)) && // 含副位置（第十三波）
      (tier === 'all' || r.tier === tier) &&
      (region === 'all' || r.team.region === region) &&
      (teamId === 'all' || r.team.id === teamId) &&
      (!needle ||
        (r.p.handle ?? '').toLowerCase().includes(needle) ||
        (r.p.name ?? '').toLowerCase().includes(needle) ||
        (r.team.name ?? '').toLowerCase().includes(needle) ||
        (r.team.tag ?? '').toLowerCase().includes(needle)),
  );
  const keyOf = (r: Row): number | string => {
    switch (sort.key) {
      case 'handle': return (r.p.handle ?? '').toLowerCase();
      case 'team': return (r.team.name ?? '').toLowerCase();
      case 'pos': return POSITIONS.indexOf(r.p.position);
      case 'age': return r.age;
      case 'tier': return tierIndex(r.tier) * 1e5 + r.p.mmr;
      case 'power': return r.power;
      case 'rating': return r.rating;
      case 'talent': return r.talent;
      case 'value': return r.value;
      case 'contract': return num(r.p.contractUntil);
    }
  };
  const sorted = filtered.slice().sort((a, b) => cmp(keyOf(a), keyOf(b), sort.dir) || b.rating - a.rating);
  const paged = usePaged(sorted, PAGE, `${pos}|${tier}|${region}|${teamId}|${needle}|${sort.key}|${sort.dir}`);
  const sp = { sort, onSort: toggle };
  const feeMultMax = +(CONFIG.market.suggestedFeeBase + CONFIG.market.importanceStar * CONFIG.market.suggestedFeeImportanceMult).toFixed(2);
  const dirty = q || pos !== 'all' || tier !== 'all' || region !== 'all' || teamId !== 'all';
  const resetFilters = () => { setQ(''); setPos('all'); setTier('all'); setRegion('all'); setTeamId('all'); };
  const posSelect = (
    <Select value={pos} onChange={(e) => setPos(e.target.value as 'all' | Position)} className="max-sm:w-full">
      <option value="all">全部位置</option>
      {POSITIONS.map((x) => <option key={x} value={x}>{POSITION_LABEL[x]}</option>)}
    </Select>
  );
  const tierSelect = (
    <Select value={tier} onChange={(e) => setTier(e.target.value as 'all' | Tier)} className="max-sm:w-full">
      <option value="all">全部等级</option>
      {TIERS.slice().reverse().map((t) => <option key={t} value={t}>{t}</option>)}
    </Select>
  );
  const regionSelect = (
    <Select value={region} onChange={(e) => setRegion(e.target.value as 'all' | Region)} className="max-sm:w-full">
      <option value="all">全部赛区</option>
      {REGIONS.map((r) => <option key={r} value={r}>{REGION_LABEL[r]}</option>)}
    </Select>
  );
  const teamSelect = (
    <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="max-w-48 max-sm:w-full max-sm:max-w-none">
      <option value="all">全部战队</option>
      {otherTeams.map((t) => <option key={t.id} value={t.id}>{t.tag} · {t.name}</option>)}
    </Select>
  );
  const bidButton = (r: Row, sf: number, className?: string) => (
    <Button
      size={phone ? 'sm' : 'xs'}
      variant={windowOpen ? 'primary' : 'secondary'}
      className={className}
      onClick={() => setBidId(r.p.id)}
      title={windowOpen ? `向 ${r.team.name} 报价（建议 ${formatGold(sf)}）` : '转会窗口已锁定（TI 阶段），可查看报价参考但无法提交'}
    >
      报价
    </Button>
  );
  const ratingCell = (r: Row) => (
    <>
      {r.rating.toFixed(1)}
      {pos !== 'all' && roleFit(r.p, pos) !== 'main' && <span className="ml-1 text-[10px] font-normal text-info">副</span>}
    </>
  );
  const contractCls = (r: Row) => (num(r.p.contractUntil) <= g.season.ti ? 'text-gold' : 'text-mute');

  return (
    <Card
      title="转会求购"
      subtitle={`${otherTeams.length} 支战队 · ${all.length} 名在役选手 · 建议转会费 = 身价 × ${CONFIG.market.suggestedFeeBase}~${feeMultMax}（原队核心更贵）`}
      bodyClassName={BODY_FLUSH}
    >
      {phone ? (
        <PhoneFilters
          search={<TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索选手 / 战队" className="w-full" aria-label="搜索" />}
          active={(pos !== 'all' ? 1 : 0) + (tier !== 'all' ? 1 : 0) + (region !== 'all' ? 1 : 0) + (teamId !== 'all' ? 1 : 0)}
          onReset={resetFilters}
          sort={<SortSelect options={SORT_OPTIONS} sort={sort} onChange={setSort} />}
        >
          <Field label="位置">{posSelect}</Field>
          <Field label="天梯等级">{tierSelect}</Field>
          <Field label="战队赛区">{regionSelect}</Field>
          <Field label="战队">{teamSelect}</Field>
        </PhoneFilters>
      ) : (
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
          <Field label="搜索">
            <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="选手 / 战队" className="w-40" />
          </Field>
          <Field label="位置">{posSelect}</Field>
          <Field label="天梯等级">{tierSelect}</Field>
          <Field label="战队赛区">{regionSelect}</Field>
          <Field label="战队">{teamSelect}</Field>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={resetFilters}>
              重置筛选
            </Button>
          )}
        </div>
      )}

      {all.length === 0 ? (
        <EmptyState text="市场上暂时没有其他战队的选手。" />
      ) : sorted.length === 0 ? (
        <EmptyState text="没有符合筛选条件的选手，试试放宽条件。" />
      ) : (
        <>
          {phone ? (
            <PhoneList>
              {paged.rows.map((r) => {
                const sf = safe(() => suggestedFee(g, r.p.id), 0);
                return (
                  <PhoneRow
                    key={r.p.id}
                    head={
                      <>
                        <TierBadge tier={r.tier} />
                        <PlayerLink player={r.p} className={PHONE_LINK} />
                        {r.starter && <span className="text-[10px] text-faint">首发</span>}
                        <PosBadge pos={r.p.position} alt={r.p.altPositions} />
                      </>
                    }
                    action={bidButton(r, sf, 'min-h-10 min-w-16')}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className="inline-flex items-center gap-1.5">
                        <TeamEmblem tag={r.team.tag} color={r.team.color} teamId={r.team.id} />
                        <TeamLink teamId={r.team.id} name={r.team.tag} className="-my-1 py-1 font-semibold text-ink" />
                        <span className="text-[10px] text-faint">{r.team.region}</span>
                      </span>
                      <span className="whitespace-nowrap"><span className="text-faint">年龄</span> <span className="tabular text-ink">{r.age}</span></span>
                      <span className={cx('whitespace-nowrap tabular', contractCls(r))}>合同 TI{r.p.contractUntil}{num(r.p.contractUntil) <= g.season.ti ? '（本季到期）' : ''}</span>
                    </div>
                    <Facts
                      items={[
                        [pos === 'all' ? '评分' : `打${POSITION_SHORT[pos]}号位评分`, <span className="font-semibold text-ink tabular">{ratingCell(r)}</span>],
                        ['战力', <AttrNum value={r.power} digits={1} />],
                        ['天赋', <AttrNum value={r.talent} />],
                      ]}
                    />
                    <Facts
                      items={[
                        ['身价', <Gold value={r.value} />],
                        ['建议', sf > 0 ? <Gold value={sf} className="font-semibold" /> : <span className="text-faint">—</span>],
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
                    <SortTh k="team" {...sp}>战队</SortTh>
                    <SortTh k="pos" {...sp}>位置</SortTh>
                    <SortTh k="age" {...sp} num>年龄</SortTh>
                    <SortTh k="tier" {...sp}>等级</SortTh>
                    <SortTh k="power" {...sp} num>战力</SortTh>
                    <SortTh
                      k="rating"
                      {...sp}
                      num
                      title={pos === 'all' ? '综合评分 = 有效战力 × 天梯倍数' : `打${POSITION_LABEL[pos]}的评分（副位置等非本位置已按位置系数折算）`}
                    >
                      评分
                    </SortTh>
                    <SortTh k="talent" {...sp} num>天赋</SortTh>
                    <SortTh k="contract" {...sp} num>合同</SortTh>
                    <SortTh k="value" {...sp} num>身价</SortTh>
                    <th className="num" title="考虑选手在原队重要度后的建议报价">建议转会费</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((r) => {
                    const sf = safe(() => suggestedFee(g, r.p.id), 0);
                    return (
                      <tr key={r.p.id}>
                        <td>
                          <div className="flex items-center gap-1.5">
                            <PlayerLink player={r.p} />
                            {r.starter && <span className="text-[10px] text-faint" title="原队首发">首发</span>}
                          </div>
                        </td>
                        <td>
                          <span className="inline-flex items-center gap-1.5">
                            <TeamEmblem tag={r.team.tag} color={r.team.color} teamId={r.team.id} />
                            <TeamLink teamId={r.team.id} name={r.team.tag} className="font-semibold" />
                            <span className="text-[10px] text-faint">{r.team.region}</span>
                          </span>
                        </td>
                        <td><PosBadge pos={r.p.position} alt={r.p.altPositions} /></td>
                        <td className="num">{r.age}</td>
                        <td><TierBadge tier={r.tier} /></td>
                        <td className="num"><AttrNum value={r.power} digits={1} /></td>
                        <td className="num font-semibold" title={pos !== 'all' && r.p.position !== pos ? `打${POSITION_LABEL[pos]}：${roleFitText(r.p, pos)}` : undefined}>
                          {ratingCell(r)}
                        </td>
                        <td className="num"><AttrNum value={r.talent} /></td>
                        <td className={cx('num text-xs', contractCls(r))}
                          title={num(r.p.contractUntil) <= g.season.ti ? '合同本赛季到期' : undefined}>
                          TI{r.p.contractUntil}
                        </td>
                        <td className="num"><Gold value={r.value} /></td>
                        <td className="num">{sf > 0 ? <Gold value={sf} className="font-semibold" /> : <span className="text-faint">—</span>}</td>
                        <td className="text-right">{bidButton(r, sf)}</td>
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

      {bidId && <MarketBidModal key={bidId} playerId={bidId} onClose={() => setBidId(null)} windowOpen={windowOpen} />}
    </Card>
  );
}

// 转会市场 · 转会求购：其他战队全部选手（搜索/位置/等级/赛区/战队 筛选 + 分页 50/页）→ 报价弹窗
import { useState } from 'react';
import { useGame } from '../../store/gameStore';
import {
  CONFIG, POSITIONS, REGIONS, TIERS, ageOf, effectiveAttr, effectivePower, marketValue, overallRating, playerTier,
  suggestedFee, tierIndex, POSITION_LABEL, REGION_LABEL, formatGold,
  type Player, type Position, type Region, type Team, type Tier,
} from '../../engine';
import { Button, Card, EmptyState, Gold, PlayerLink, PosBadge, TeamLink, TierBadge, cx } from './common';
import { TeamEmblem } from './TeamEmblem';
import { AttrNum, Field, Pager, Select, SortTh, TableWrap, TextInput, cmp, num, safe, usePaged, useSort } from './MarketKit';
import MarketBidModal from './MarketBidModal';

type SortKey = 'handle' | 'team' | 'pos' | 'age' | 'tier' | 'power' | 'rating' | 'talent' | 'value' | 'contract';

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
  const { sort, toggle } = useSort<SortKey>('rating');

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
        rating: overallRating(p),
        talent: effectiveAttr(p, 'talent'),
        value: safe(() => marketValue(g, p), 0),
        starter: starters.has(p.id),
      });
    }
  }

  const needle = q.trim().toLowerCase();
  const filtered = all.filter(
    (r) =>
      (pos === 'all' || r.p.position === pos) &&
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

  return (
    <Card
      title="转会求购"
      subtitle={`${otherTeams.length} 支战队 · ${all.length} 名在役选手 · 建议转会费 = 身价 × ${CONFIG.market.suggestedFeeBase}~${feeMultMax}（原队核心更贵）`}
      bodyClassName="p-0"
    >
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
        <Field label="搜索">
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="选手 / 战队" className="w-40" />
        </Field>
        <Field label="位置">
          <Select value={pos} onChange={(e) => setPos(e.target.value as 'all' | Position)}>
            <option value="all">全部位置</option>
            {POSITIONS.map((x) => <option key={x} value={x}>{POSITION_LABEL[x]}</option>)}
          </Select>
        </Field>
        <Field label="天梯等级">
          <Select value={tier} onChange={(e) => setTier(e.target.value as 'all' | Tier)}>
            <option value="all">全部等级</option>
            {TIERS.slice().reverse().map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="战队赛区">
          <Select value={region} onChange={(e) => setRegion(e.target.value as 'all' | Region)}>
            <option value="all">全部赛区</option>
            {REGIONS.map((r) => <option key={r} value={r}>{REGION_LABEL[r]}</option>)}
          </Select>
        </Field>
        <Field label="战队">
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="max-w-48">
            <option value="all">全部战队</option>
            {otherTeams.map((t) => <option key={t.id} value={t.id}>{t.tag} · {t.name}</option>)}
          </Select>
        </Field>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => { setQ(''); setPos('all'); setTier('all'); setRegion('all'); setTeamId('all'); }}>
            重置筛选
          </Button>
        )}
      </div>

      {all.length === 0 ? (
        <EmptyState text="市场上暂时没有其他战队的选手。" />
      ) : sorted.length === 0 ? (
        <EmptyState text="没有符合筛选条件的选手，试试放宽条件。" />
      ) : (
        <>
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
                  <SortTh k="rating" {...sp} num title="综合评分 = 有效战力 × 天梯倍数">评分</SortTh>
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
                      <td><PosBadge pos={r.p.position} /></td>
                      <td className="num">{r.age}</td>
                      <td><TierBadge tier={r.tier} /></td>
                      <td className="num"><AttrNum value={r.power} digits={1} /></td>
                      <td className="num font-semibold">{r.rating.toFixed(1)}</td>
                      <td className="num"><AttrNum value={r.talent} /></td>
                      <td className={cx('num text-xs', num(r.p.contractUntil) <= g.season.ti ? 'text-gold' : 'text-mute')}
                        title={num(r.p.contractUntil) <= g.season.ti ? '合同本赛季到期' : undefined}>
                        TI{r.p.contractUntil}
                      </td>
                      <td className="num"><Gold value={r.value} /></td>
                      <td className="num">{sf > 0 ? <Gold value={sf} className="font-semibold" /> : <span className="text-faint">—</span>}</td>
                      <td className="text-right">
                        <Button
                          size="xs"
                          variant={windowOpen ? 'primary' : 'secondary'}
                          onClick={() => setBidId(r.p.id)}
                          title={windowOpen ? `向 ${r.team.name} 报价（建议 ${formatGold(sf)}）` : '转会窗口已锁定（TI 阶段），可查看报价参考但无法提交'}
                        >
                          报价
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
          <Pager {...paged} onChange={paged.setPage} unit="人" />
        </>
      )}

      {bidId && <MarketBidModal key={bidId} playerId={bidId} onClose={() => setBidId(null)} windowOpen={windowOpen} />}
    </Card>
  );
}

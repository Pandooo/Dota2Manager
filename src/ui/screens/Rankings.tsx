// 排名：赛季积分榜 / 战力榜 / 选手榜 / TI 历史
import { useState, type ReactNode } from 'react';
import { useGame } from '../../store/gameStore';
import type { GameState, Player, Position, Region, Team } from '../../engine/types';
import { POSITIONS, REGIONS } from '../../engine/types';
import {
  POSITION_LABEL, POSITION_SHORT, REGION_LABEL, activeTeams, ageOf, effectiveAttr, effectivePower, formatRank, getCoach, lineupPlayers,
  overallRating, playerTier, rankTeamsByRating, seasonStandings, teamRating,
} from '../../engine';
import { getAllTiInfo, getTiInfo } from '../../data/index';
import {
  Badge, Button, Card, EmptyState, Hint, PlayerLink, PosBadge, RegionBadge, Stat, StatBar, TableScroll, Tabs, TierBadge, cx,
} from '../components/common';
import { ScreenHeader } from '../layout/HubKit';
import { Segmented, TeamName, TourSelect, rankClass, safe, teamInfo } from '../components/TourShared';
import { PHONE_HIDE, STICKY_TD, STICKY_TH } from '../components/PediaKit';
import { useIsPhone } from '../mobile';

type TabKey = 'standings' | 'power' | 'players' | 'ti';

export default function Rankings() {
  const game = useGame();
  const [tab, setTab] = useState<TabKey>('standings');
  return (
    <div className="space-y-4">
      <ScreenHeader title="排名" subtitle={`TI${game.season.ti} 赛季 · ${game.season.year}`} />
      <Tabs<TabKey>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'standings', label: '赛季积分榜' },
          { key: 'power', label: '战力榜' },
          { key: 'players', label: '选手榜' },
          { key: 'ti', label: 'TI 历史' },
        ]}
      />
      {tab === 'standings' && <StandingsTab game={game} />}
      {tab === 'power' && <PowerTab game={game} />}
      {tab === 'players' && <PlayersTab game={game} />}
      {tab === 'ti' && <TiHistoryTab game={game} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 赛季积分榜
// ---------------------------------------------------------------------------
function StandingsTab({ game }: { game: GameState }) {
  const me = game.settings.playerTeamId;
  const fallback = () =>
    safe(() => activeTeams(game), Object.values(game.teams).filter((t) => !t.disbanded))
      .slice()
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || b.honor - a.honor);
  const standings: Team[] = safe(() => seasonStandings(game), fallback());
  const di = safe(() => getTiInfo(game.season.ti).directInvites, 0);
  const tiT = game.tournaments[`ti-${game.season.ti}`];
  const actualInvites = tiT && tiT.invitedTeamIds?.length ? new Set(tiT.invitedTeamIds) : null;
  const tiTeams = new Set(tiT?.teamIds ?? []);
  // 本赛季 TI 赛区预选（进入 TI 预选回合时生成）
  const tiQuals = Object.values(game.tournaments).filter((x) => x.season === game.season.ti && !!x.advanceToTi);
  const qualOf = (teamId: string) =>
    tiQuals.find((x) => (x.teamIds ?? []).includes(teamId) || (x.qualifierTeamIds ?? []).includes(teamId));
  const tiStatus = (teamId: string, i: number): ReactNode => {
    if (!actualInvites) {
      return di > 0 && i < di ? <span className="text-gold/80">直邀圈</span> : <span className="text-faint">赛区预选</span>;
    }
    if (actualInvites.has(teamId)) return <span className="font-semibold text-gold">已直邀</span>;
    if (tiTeams.has(teamId)) return <span className="font-semibold text-good">预选晋级</span>;
    const q = qualOf(teamId);
    if (!q) return <span className="text-faint">未入围</span>;
    if (q.status === 'finished') return <span className="text-bad/80">预选出局</span>;
    return <span className="text-info">赛区预选中</span>;
  };
  const ratingOrder = safe(() => rankTeamsByRating(game), [] as string[]);
  const ratingRank = new Map(ratingOrder.map((id, i) => [id, i + 1]));
  const titles = new Map<string, number>();
  for (const h of game.history?.tournaments ?? []) {
    if (h.season === game.season.ti && h.championId) titles.set(h.championId, (titles.get(h.championId) ?? 0) + 1);
  }
  const beefIds = new Set(game.beefs.filter((b) => b.season === game.season.ti).map((b) => b.teamId));

  if (standings.length === 0) return <Card><EmptyState text="暂无战队数据" /></Card>;

  const myIdx = standings.findIndex((t) => t.id === me);
  const myTeam = standings[myIdx];
  const cutoffTeam = di > 0 ? standings[Math.min(di, standings.length) - 1] : undefined;
  const firstOut = di > 0 ? standings[di] : undefined;
  const gap =
    myTeam && cutoffTeam
      ? myIdx < di
        ? (myTeam.points ?? 0) - (firstOut?.points ?? 0)
        : (cutoffTeam.points ?? 0) - (myTeam.points ?? 0)
      : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="我的排名" value={myIdx >= 0 ? `#${myIdx + 1}` : '—'} hint={`共 ${standings.length} 支战队`} />
        <Stat label="巡回赛积分" value={Math.round(myTeam?.points ?? 0)} />
        <Stat label="直邀线" value={di > 0 ? `前 ${di} 名` : '—'} hint={cutoffTeam ? `第 ${di} 名 ${Math.round(cutoffTeam.points ?? 0)} 分` : undefined} />
        <Stat
          label={myIdx >= 0 && myIdx < di ? '领先直邀线' : '距直邀线'}
          value={gap === null ? '—' : <span className={myIdx < di ? 'text-good' : 'text-bad'}>{Math.max(0, Math.round(gap))} 分</span>}
          hint={myIdx >= 0 && myIdx < di ? '领先第一个圈外战队' : '需超过直邀线上的战队'}
        />
      </div>
      <Card
        title="赛季积分榜"
        subtitle={actualInvites ? 'TI 直邀名单已确定' : `积分榜前 ${di || 'N'} 名将在 TI 预选回合开始时获得直邀`}
        bodyClassName="p-0"
      >
        {/* 手机（< sm）：战队列固定在左侧（名次并入），赛区 / 荣誉 / 本季冠军 / 上季排名隐藏 */}
        <TableScroll>
          <table className="tbl">
            <thead>
              <tr>
                <th className={cx('w-10', PHONE_HIDE)}>#</th>
                <th className={STICKY_TH}>战队</th>
                <th className={PHONE_HIDE}>赛区</th>
                <th className="num">积分</th>
                <th className={cx('num', PHONE_HIDE)}>荣誉</th>
                <th className="num" title="首发评分之和 + 教练加成（括号内为战力榜名次）">战力</th>
                <th className={cx('num', PHONE_HIDE)}>本季冠军</th>
                <th className={cx('num', PHONE_HIDE)}>上季排名</th>
                <th>TI 资格</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((t, i) => {
                const isMe = t.id === me;
                const rating = safe(() => teamRating(game, t.id), 0);
                return (
                  <FragmentRow key={t.id} cutoff={di > 0 && i === di} di={di}>
                    <tr className={cx(isMe && 'bg-gold/10')}>
                      <td className={cx('tabular', PHONE_HIDE, i < 3 ? 'font-semibold text-gold' : 'text-mute')}>{i + 1}</td>
                      <td className={STICKY_TD}>
                        <span className="flex max-w-56 items-center gap-1.5 max-sm:max-w-[10rem]">
                          <span className={cx('w-5 shrink-0 text-right text-xs tabular sm:hidden', i < 3 ? 'font-semibold text-gold' : 'text-mute')}>{i + 1}</span>
                          <TeamName game={game} teamId={t.id} />
                          {beefIds.has(t.id) && (
                            <Badge className="bg-dota/20 text-dota-2 border border-dota/40" title="本赛季宿敌">
                              宿敌
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td className={PHONE_HIDE}>
                        <RegionBadge region={t.region} />
                      </td>
                      <td className="num font-semibold">{Math.round(t.points ?? 0)}</td>
                      <td className={cx('num', PHONE_HIDE)}>{Math.round(t.honor)}</td>
                      <td className="num">
                        {Math.round(rating)}
                        <span className="ml-1 text-[11px] text-faint">({ratingRank.get(t.id) ?? '-'})</span>
                      </td>
                      <td className={cx('num', PHONE_HIDE)}>{titles.get(t.id) ? <span className="text-gold">{titles.get(t.id)}</span> : <span className="text-faint">0</span>}</td>
                      <td className={cx('num text-mute', PHONE_HIDE)}>{t.lastSeasonRank ? `#${t.lastSeasonRank}` : '—'}</td>
                      <td className="text-xs">{tiStatus(t.id, i)}</td>
                    </tr>
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </Card>
    </div>
  );
}

/** 在指定行前插入「直邀线」分隔行 */
function FragmentRow({ cutoff, di, children }: { cutoff: boolean; di: number; children: ReactNode }) {
  return (
    <>
      {cutoff && (
        <tr>
          <td colSpan={9} className="!py-0">
            <div className="flex items-center gap-2 py-1 text-[11px] text-gold max-sm:sticky max-sm:left-0 max-sm:w-[calc(100vw-3.5rem)]">
              <span className="h-px flex-1 border-t-2 border-dashed border-gold/60" />
              <span>▲ TI 直邀线（前 {di} 名）</span>
              <span className="h-px flex-1 border-t-2 border-dashed border-gold/60" />
            </div>
          </td>
        </tr>
      )}
      {children}
    </>
  );
}

// ---------------------------------------------------------------------------
// 战力榜
// ---------------------------------------------------------------------------
function PowerTab({ game }: { game: GameState }) {
  const me = game.settings.playerTeamId;
  const [region, setRegion] = useState<Region | 'all'>('all');
  const ids = safe(() => rankTeamsByRating(game), [] as string[]);
  const rows = ids
    .map((id, i) => ({ id, rank: i + 1, team: game.teams[id], rating: safe(() => teamRating(game, id), 0) }))
    .filter((r) => r.team && (region === 'all' || r.team.region === region));
  const max = rows.reduce((m, r) => Math.max(m, r.rating), 0) || 1;

  return (
    <Card
      title="战力榜"
      subtitle="按战队评分（首发 5 人位置评分之和 + 教练加成）排序"
      actions={
        <TourSelect value={region} onChange={(v) => setRegion(v as Region | 'all')}>
          <option value="all">全部赛区</option>
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {REGION_LABEL[r]}
            </option>
          ))}
        </TourSelect>
      }
      bodyClassName="p-0"
    >
      {rows.length === 0 ? (
        <EmptyState text="暂无战队数据" />
      ) : (
        // 手机：战队列固定在左侧（名次并入），赛区 / 教练 / 荣誉 / 积分隐藏
        <TableScroll>
          <table className="tbl">
            <thead>
              <tr>
                <th className={cx('w-10', PHONE_HIDE)}>#</th>
                <th className={STICKY_TH}>战队</th>
                <th className={PHONE_HIDE}>赛区</th>
                <th className="w-56 max-sm:w-auto max-sm:min-w-32">战队评分</th>
                <th>王牌选手</th>
                <th className={PHONE_HIDE}>教练</th>
                <th className={cx('num', PHONE_HIDE)}>荣誉</th>
                <th className={cx('num', PHONE_HIDE)}>积分</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const starters = safe(() => lineupPlayers(game, r.id), []);
                const star = starters
                  .map((s) => s.player)
                  .filter((p): p is Player => !!p)
                  .sort((a, b) => overallRating(b) - overallRating(a))[0];
                const coach = safe(() => getCoach(game, r.id), null);
                const missing = starters.filter((s) => !s.player).length;
                return (
                  <tr key={r.id} className={cx(r.id === me && 'bg-gold/10')}>
                    <td className={cx('tabular', PHONE_HIDE, r.rank <= 3 ? 'font-semibold text-gold' : 'text-mute')}>{r.rank}</td>
                    <td className={STICKY_TD}>
                      <span className="flex max-w-52 items-center gap-1.5 max-sm:max-w-[9.5rem]">
                        <span className={cx('w-5 shrink-0 text-right text-xs tabular sm:hidden', r.rank <= 3 ? 'font-semibold text-gold' : 'text-mute')}>{r.rank}</span>
                        <TeamName game={game} teamId={r.id} />
                      </span>
                    </td>
                    <td className={PHONE_HIDE}>
                      <RegionBadge region={r.team.region} />
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <StatBar value={r.rating} max={max} className="flex-1" color={r.id === me ? 'bg-gold' : 'bg-info'} />
                        <span className="w-10 text-right tabular">{Math.round(r.rating)}</span>
                        {missing > 0 && (
                          <span className="text-[10px] text-bad" title={`首发空缺 ${missing} 人`}>
                            缺{missing}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {star ? (
                        <span className="flex items-center gap-1.5">
                          <PosBadge pos={star.position} />
                          <PlayerLink player={star} />
                          <span className="text-[11px] text-faint tabular">{Math.round(overallRating(star))}</span>
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className={cx('text-xs', PHONE_HIDE)}>
                      {coach ? (
                        <span className="flex items-center gap-1.5">
                          <TierBadge tier={coach.tier} />
                          {coach.name}
                        </span>
                      ) : (
                        <span className="text-faint">空缺</span>
                      )}
                    </td>
                    <td className={cx('num', PHONE_HIDE)}>{Math.round(r.team.honor)}</td>
                    <td className={cx('num text-mute', PHONE_HIDE)}>{Math.round(r.team.points ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 选手榜
// ---------------------------------------------------------------------------
type SortKey = 'overall' | 'power' | 'mmr' | 'insight' | 'talent' | 'age';
/** 手机上选手榜先列出的人数 */
const PHONE_ROWS = 30;
type Scope = 'all' | 'signed' | 'free' | 'mine';

const SORT_LABEL: Record<SortKey, string> = {
  overall: '综合评分',
  power: '战斗力',
  mmr: '天梯分',
  insight: '灵性',
  talent: '天赋',
  age: '年龄（小→大）',
};

function PlayersTab({ game }: { game: GameState }) {
  const me = game.settings.playerTeamId;
  const [pos, setPos] = useState<Position | 'all'>('all');
  const [region, setRegion] = useState<Region | 'all'>('all');
  const [scope, setScope] = useState<Scope>('all');
  const [sort, setSort] = useState<SortKey>('overall');
  const [q, setQ] = useState('');
  // 手机：先列前 PHONE_ROWS 名（不用卡片内滚动，避免滑动被表格吞掉），可展开全部
  const phone = useIsPhone();
  const [allRows, setAllRows] = useState(false);

  // 注意：引擎原地修改 game，不能用 useMemo 依赖 game 引用缓存
  const gacha = new Set(game.gachaPool ?? []);
  const temp = new Set(game.tempSubCandidates ?? []);
  const pool = Object.values(game.players).filter(
    (p) => p.status === 'active' && !p.isWildSub && !gacha.has(p.id) && !temp.has(p.id),
  );

  const query = q.trim().toLowerCase();
  const filtered = pool.filter((p) => {
    if (pos !== 'all' && p.position !== pos) return false;
    if (region !== 'all' && p.region !== region) return false;
    if (scope === 'signed' && !p.teamId) return false;
    if (scope === 'free' && p.teamId) return false;
    if (scope === 'mine' && p.teamId !== me) return false;
    if (query && !p.handle.toLowerCase().includes(query) && !(p.name ?? '').toLowerCase().includes(query)) return false;
    return true;
  });
  const keyOf = (p: Player): number => {
    switch (sort) {
      case 'power':
        return effectivePower(p);
      case 'mmr':
        return effectiveAttr(p, 'mmr');
      case 'insight':
        return effectiveAttr(p, 'insight');
      case 'talent':
        return effectiveAttr(p, 'talent');
      case 'age':
        return -ageOf(game, p);
      default:
        return overallRating(p);
    }
  };
  const rows = filtered
    .map((p) => ({ p, k: safe(() => keyOf(p), 0), ovr: safe(() => overallRating(p), 0) }))
    .sort((a, b) => b.k - a.k || b.ovr - a.ovr)
    .slice(0, 100);
  const shownRows = phone && !allRows ? rows.slice(0, PHONE_ROWS) : rows;
  // 手机上隐藏的属性列：当前排序所用的那一列仍显示
  const hideCol = (k: SortKey) => (sort === k ? undefined : PHONE_HIDE);

  return (
    <Card
      title="选手榜"
      subtitle={`共 ${filtered.length} 名符合条件的现役选手 · 显示前 ${rows.length} 名`}
      bodyClassName="p-0"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <Segmented<Position | 'all'>
          value={pos}
          onChange={setPos}
          options={[{ key: 'all', label: '全部位置' }, ...POSITIONS.map((p) => ({ key: p, label: `${POSITION_SHORT[p]}号位`, title: POSITION_LABEL[p] }))]}
        />
        <TourSelect value={region} onChange={(v) => setRegion(v as Region | 'all')}>
          <option value="all">全部赛区</option>
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {REGION_LABEL[r]}
            </option>
          ))}
        </TourSelect>
        <TourSelect value={scope} onChange={(v) => setScope(v as Scope)}>
          <option value="all">全部选手</option>
          <option value="signed">职业战队</option>
          <option value="free">自由选手</option>
          <option value="mine">本队</option>
        </TourSelect>
        <TourSelect value={sort} onChange={(v) => setSort(v as SortKey)} title="排序">
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              按{SORT_LABEL[k]}
            </option>
          ))}
        </TourSelect>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索选手 ID…"
          className="w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm outline-none placeholder:text-faint focus:border-dota sm:ml-auto sm:w-44"
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState text="没有符合筛选条件的选手" />
      ) : (
        // 桌面：表格内滚动（最高 640px）；手机：选手列固定在左侧（名次并入），年龄 / 赛区 / 灵性 / 天赋隐藏（排序所用的列除外）
        <TableScroll className="lg:max-h-[640px] lg:overflow-y-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className={cx('w-10', PHONE_HIDE)}>#</th>
                <th className={STICKY_TH}>选手</th>
                <th>位置</th>
                <th>天梯</th>
                <th className={cx('num', hideCol('age'))}>年龄</th>
                <th>战队</th>
                <th className={PHONE_HIDE}>赛区</th>
                <th className="num">战斗力</th>
                <th className={cx('num', hideCol('insight'))}>灵性</th>
                <th className={cx('num', hideCol('talent'))}>天赋</th>
                <th className="num" title="本位置评分 = 有效战力 × 天梯倍数">综合</th>
              </tr>
            </thead>
            <tbody>
              {shownRows.map(({ p, ovr }, i) => (
                <tr key={p.id} className={cx(p.teamId === me && 'bg-gold/10')}>
                  <td className={cx('tabular', PHONE_HIDE, i < 3 ? 'font-semibold text-gold' : 'text-mute')}>{i + 1}</td>
                  <td className={STICKY_TD}>
                    <span className={cx('mr-1.5 inline-block w-6 text-right text-xs tabular sm:hidden', i < 3 ? 'font-semibold text-gold' : 'text-mute')}>{i + 1}</span>
                    <PlayerLink player={p} />
                    {p.isRookie && <span className="ml-1 text-[10px] text-good">新秀</span>}
                  </td>
                  <td>
                    <PosBadge pos={p.position} />
                  </td>
                  <td>
                    <TierBadge tier={safe(() => playerTier(p), 'C')} />
                  </td>
                  <td className={cx('num', hideCol('age'))}>{safe(() => ageOf(game, p), 0)}</td>
                  <td className="max-w-40">
                    {p.teamId ? <TeamName game={game} teamId={p.teamId} mode="tag" /> : <span className="text-xs text-faint">自由选手</span>}
                  </td>
                  <td className={PHONE_HIDE}>
                    <RegionBadge region={p.region} />
                  </td>
                  <td className="num">{safe(() => effectivePower(p), p.power).toFixed(1)}</td>
                  <td className={cx('num text-mute', hideCol('insight'))}>{Math.round(safe(() => effectiveAttr(p, 'insight'), p.insight))}</td>
                  <td className={cx('num text-mute', hideCol('talent'))}>{Math.round(p.talent)}</td>
                  <td className="num font-semibold">{ovr.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {shownRows.length < rows.length && (
        <div className="flex justify-center border-t border-line py-2">
          <Button size="sm" variant="ghost" onClick={() => setAllRows(true)}>
            显示全部 {rows.length} 名
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// TI 历史
// ---------------------------------------------------------------------------
function TiHistoryTab({ game }: { game: GameState }) {
  const me = game.settings.playerTeamId;
  const tis = safe(() => getAllTiInfo(), []).slice().sort((a, b) => b.ti - a.ti);
  const inGame = new Map<number, (typeof game.history.tournaments)[number]>();
  for (const h of game.history?.tournaments ?? []) if (h.tier === 'ti') inGame.set(h.season, h);
  const { startTi, endTi } = game.settings;
  const myTiTitles = Array.from(inGame.values()).filter((h) => h.championId === me).length;

  if (tis.length === 0 && inGame.size === 0) return <Card><EmptyState text="暂无 TI 数据" /></Card>;

  const nameOf = (id?: string | null) => (id ? teamInfo(game, id).name : '—');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="本存档赛季" value={`TI${startTi} → TI${endTi}`} hint={`共 ${endTi - startTi + 1} 个赛季`} />
        <Stat label="已完成 TI" value={inGame.size} />
        <Stat label="我的 TI 冠军" value={<span className={myTiTitles ? 'text-gold' : ''}>{myTiTitles}</span>} hint="目标：至少一座不朽盾" />
        <Stat label="当前赛季" value={`TI${game.season.ti}`} hint={String(game.season.year)} />
      </div>
      <Card title="TI 历史" subtitle="真实历史冠军 vs 本存档中的结果（存档范围内的届次以左侧金线标出）" bodyClassName="p-0">
        {/* 手机：届次列固定在左侧，举办地 / 奖金池 / 真实亚军隐藏 */}
        <TableScroll>
          <table className="tbl">
            <thead>
              <tr>
                <th className={STICKY_TH}>届次</th>
                <th className={PHONE_HIDE}>举办地</th>
                <th className={cx('num', PHONE_HIDE)}>真实奖金池</th>
                <th>真实冠军</th>
                <th className={PHONE_HIDE}>真实亚军</th>
                <th>本存档冠军</th>
                <th>我的成绩</th>
              </tr>
            </thead>
            <tbody>
              {tis.map((info) => {
                const inRange = info.ti >= startTi && info.ti <= endTi;
                const h = inGame.get(info.ti);
                const myPl = h?.placements?.[me];
                const isCur = info.ti === game.season.ti;
                return (
                  <tr key={info.ti} className={cx(isCur && 'bg-gold/5', !inRange && 'opacity-60')}>
                    <td className={cx('relative', STICKY_TD)}>
                      {inRange && <span className="absolute bottom-1 left-0 top-1 w-1 rounded-r bg-gold/70" />}
                      <span className="font-semibold">TI{info.ti}</span>
                      <span className="ml-1.5 text-xs text-faint">{info.year}</span>
                      {info.projected && <Badge className="ml-1.5 bg-panel-3 text-faint">推演</Badge>}
                      {isCur && <Badge className="ml-1.5 bg-gold text-black">本赛季</Badge>}
                    </td>
                    <td className={cx('text-xs text-mute', PHONE_HIDE)}>
                      {info.city}
                      {info.country ? ` · ${info.country}` : ''}
                    </td>
                    <td className={cx('num', PHONE_HIDE)} title="真实奖金池（美元）">
                      ${Math.round(info.prizePool ?? 0).toLocaleString('en-US')}
                    </td>
                    <td className="text-xs">{info.champion ? <span className="text-ink">{nameOf(info.champion)}</span> : <span className="text-faint">—</span>}</td>
                    <td className={cx('text-xs text-mute', PHONE_HIDE)}>{info.runnerUp ? nameOf(info.runnerUp) : '—'}</td>
                    <td className="text-xs">
                      {h ? (
                        <span className={cx('flex items-center gap-1', h.championId === me && 'font-semibold')}>
                          {h.championId === me && <span className="text-gold">♛</span>}
                          <TeamName game={game} teamId={h.championId} />
                        </span>
                      ) : inRange && info.ti >= game.season.ti ? (
                        <span className="text-faint">待决出</span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="text-xs">
                      {myPl ? (
                        <span className={rankClass(myPl[0])}>{formatRank(myPl[0], myPl[1])}</span>
                      ) : h ? (
                        <span className="text-faint">未参加</span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </Card>
      <Hint>真实冠军仅作展示；本存档中的 TI 由模拟决出，历史可能被改写。</Hint>
    </div>
  );
}

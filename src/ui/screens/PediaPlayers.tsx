// DotaPedia · 选手：全部选手列表（搜索；按位置 / 等级 / 战队 / 状态筛选；按历史地位、KDA、胜率等排序；分页）→ 选手词条
import { useEffect, useMemo, useState } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import { POSITIONS, POSITION_LABEL, TIERS, pediaPlayerStandingBoard, playerTier } from '../../engine';
import type { GameState, PediaPlayerStanding, Position, Tier } from '../../engine';
import { Card, EmptyState, Gold, PosBadge, TierBadge, cx } from '../components/common';
import { Flag, SortTh, sortList, useSort } from '../components/SquadShared';
import { Segmented, TourSelect } from '../components/TourShared';
import { PPlayer, PTeam, Pager, PediaInput, TIER_RANK, fmt1, fmtKda, fmtPct, safe, usePediaSel, PediaEntryGuard } from '../components/PediaKit';
import PediaPlayerPage from './PediaPlayerPage';

export default function PediaPlayers() {
  const game = useGame();
  const sel = usePediaSel('player', game);
  if (sel) {
    return (
      <PediaEntryGuard key={sel} kind="player">
        <PediaPlayerPage id={sel} />
      </PediaEntryGuard>
    );
  }
  return <PlayerList game={game} />;
}

type Status = 'active' | 'free' | 'retired' | 'banned';
const STATUS_LABEL: Record<Status, string> = { active: '现役', free: '自由选手', retired: '已退役', banned: '禁赛' };
const STATUS_CLASS: Record<Status, string> = { active: 'text-good', free: 'text-info', retired: 'text-faint', banned: 'text-bad' };

interface PlayerRow {
  id: string;
  handle: string;
  cc: string | null;
  pos: Position | null;
  tier: Tier | null;
  /** 当前东家（现役）或最近效力的战队 */
  teamId: string | null;
  formerTeam: boolean;
  status: Status;
  games: number;
  wins: number;
  winRate: number;
  avgK: number;
  avgD: number;
  avgA: number;
  kda: number;
  mvps: number;
  prize: number;
  standing: PediaPlayerStanding | null;
  real: boolean;
}

function buildPlayerRows(game: GameState): PlayerRow[] {
  const standings = new Map(safe(() => pediaPlayerStandingBoard(game), [] as PediaPlayerStanding[]).map((s) => [s.playerId, s]));
  const ps = game.pedia?.players ?? {};
  const ids = new Set<string>(Object.keys(ps));
  for (const [id, p] of Object.entries(game.players)) if (!p.isWildSub) ids.add(id);
  const rows: PlayerRow[] = [];
  for (const id of ids) {
    const p = game.players[id];
    const e = ps[id];
    let games = 0, wins = 0, k = 0, d = 0, a = 0, mvps = 0, prize = 0;
    let last: string | null = null;
    for (const r of e?.s ?? []) {
      games += r[2] || 0;
      wins += r[3] || 0;
      k += r[4] || 0;
      d += r[5] || 0;
      a += r[6] || 0;
      mvps += r[7] || 0;
      prize += r[8] || 0;
      if ((r[2] || 0) > 0) last = r[1];
    }
    const status: Status = !p ? 'retired' : p.status === 'banned' ? 'banned' : p.status === 'retired' ? 'retired' : !p.teamId ? 'free' : 'active';
    const current = status === 'active' && p?.teamId ? p.teamId : null;
    rows.push({
      id,
      handle: p?.handle ?? e?.n ?? id,
      cc: p?.nationality ?? null,
      pos: p?.position ?? e?.p ?? null,
      tier: p ? safe(() => playerTier(p), null) : null,
      teamId: current ?? last ?? p?.lastTeamId ?? null,
      formerTeam: !current,
      status,
      games,
      wins,
      winRate: games > 0 ? wins / games : NaN,
      avgK: games > 0 ? k / games : NaN,
      avgD: games > 0 ? d / games : NaN,
      avgA: games > 0 ? a / games : NaN,
      kda: games > 0 ? (k + a) / Math.max(1, d) : NaN,
      mvps,
      prize,
      standing: standings.get(id) ?? null,
      real: p ? !!p.isReal : true,
    });
  }
  return rows;
}

type SortKey = 'standing' | 'handle' | 'tier' | 'games' | 'winRate' | 'kda' | 'avgK' | 'mvps' | 'prize';
const PAGE = 50;

function PlayerList({ game }: { game: GameState }) {
  const version = useGameStore((s) => s.version);
  const rows = useMemo(() => buildPlayerRows(game), [game, version]);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<'all' | Position>('all');
  const [tier, setTier] = useState<'all' | Tier>('all');
  const [team, setTeam] = useState('all');
  const [status, setStatus] = useState<'all' | Status>('all');
  // 「仅有出场」默认开启；新开局还没有任何出场记录时默认关闭（否则列表为空）
  const [played, setPlayed] = useState(() => rows.some((r) => r.games > 0));
  const [page, setPage] = useState(0);
  const sort = useSort<SortKey>('standing');
  // 换排序时回到第一页
  useEffect(() => setPage(0), [sort.key, sort.dir]);
  const me = game.settings.playerTeamId;
  const reset = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(0);
  };

  const teams = useMemo(
    () => Object.values(game.teams).filter((t) => !t.disbanded).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [game, version],
  );

  const query = q.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (played && r.games <= 0) return false;
    if (pos !== 'all' && r.pos !== pos) return false;
    if (tier !== 'all' && r.tier !== tier) return false;
    if (status !== 'all' && r.status !== status) return false;
    if (team !== 'all' && !(r.teamId === team && !r.formerTeam)) return false;
    if (query) {
      const p = game.players[r.id];
      if (!`${r.handle} ${p?.name ?? ''} ${r.id}`.toLowerCase().includes(query)) return false;
    }
    return true;
  });
  const sorted = sortList(
    filtered,
    (r) => {
      switch (sort.key) {
        case 'standing':
          return (r.standing?.score ?? -1) + r.games * 1e-6;
        case 'handle':
          return r.handle;
        case 'tier':
          return r.tier ? TIER_RANK[r.tier] : -1;
        case 'games':
          return r.games;
        case 'winRate':
          return r.winRate;
        case 'kda':
          return r.kda;
        case 'avgK':
          return r.avgK;
        case 'mvps':
          return r.mvps;
        case 'prize':
          return r.prize;
      }
    },
    sort.dir,
  );
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const pg = Math.min(page, pages - 1);
  const shown = sorted.slice(pg * PAGE, pg * PAGE + PAGE);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PediaInput value={q} onChange={reset(setQ)} placeholder="按 ID / 本名筛选" className="w-48" />
        <TourSelect value={pos} onChange={(v) => reset(setPos)(v as 'all' | Position)} title="位置">
          <option value="all">全部位置</option>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {POSITION_LABEL[p]}
            </option>
          ))}
        </TourSelect>
        <TourSelect value={tier} onChange={(v) => reset(setTier)(v as 'all' | Tier)} title="当前天梯等级">
          <option value="all">全部等级</option>
          {TIERS.slice().reverse().map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </TourSelect>
        <TourSelect value={team} onChange={reset(setTeam)} title="当前效力的战队" className="max-w-48">
          <option value="all">全部战队</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </TourSelect>
        <Segmented
          value={status}
          onChange={reset(setStatus)}
          options={[
            { key: 'all', label: '全部' },
            { key: 'active', label: '现役' },
            { key: 'free', label: '自由' },
            { key: 'retired', label: '退役' },
            { key: 'banned', label: '禁赛' },
          ]}
        />
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-mute" title="只列出在本局有出场记录的选手">
          <input type="checkbox" checked={played} onChange={(e) => reset(setPlayed)(e.target.checked)} />
          仅有出场
        </label>
        <div className="ml-auto">
          <Pager page={pg} pages={pages} onPage={setPage} total={sorted.length} />
        </div>
      </div>

      <Card bodyClassName="p-0">
        {shown.length === 0 ? (
          <EmptyState text={played ? '没有符合条件的选手（已勾选「仅有出场」）' : '没有符合条件的选手'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <SortTh k="handle" sort={sort} defaultDir="asc">选手</SortTh>
                  <th>位置</th>
                  <SortTh k="tier" sort={sort}>等级</SortTh>
                  <th title="现役 = 当前东家；其他状态显示最近效力的战队">战队 / 状态</th>
                  <SortTh k="standing" sort={sort} title="选手历史地位（TI 名次、冠军、MVP、赛季、巅峰等级；含开局前的现实 TI）">历史地位</SortTh>
                  <SortTh k="games" sort={sort} className="num">局数</SortTh>
                  <SortTh k="winRate" sort={sort} className="num">胜率</SortTh>
                  <SortTh k="avgK" sort={sort} className="num" title="场均 击杀 / 阵亡 / 助攻">K / D / A</SortTh>
                  <SortTh k="kda" sort={sort} className="num" title="(击杀 + 助攻) / 阵亡">KDA</SortTh>
                  <SortTh k="mvps" sort={sort} className="num">MVP</SortTh>
                  <SortTh k="prize" sort={sort} className="num" title="赛事奖金的队员分成">奖金</SortTh>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={r.id} className={cx(r.teamId === me && !r.formerTeam && 'bg-gold/5')}>
                    <td className="num text-faint">{pg * PAGE + i + 1}</td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        {r.cc ? <Flag cc={r.cc} /> : <span className="inline-block w-4" />}
                        <PPlayer id={r.id} handle={r.handle} />
                        {!r.real && <span className="text-[10px] text-faint" title="程序生成的选手">生成</span>}
                      </span>
                    </td>
                    <td>{r.pos ? <PosBadge pos={r.pos} /> : <span className="text-faint">—</span>}</td>
                    <td>{r.tier ? <TierBadge tier={r.tier} /> : <span className="text-faint">—</span>}</td>
                    <td>
                      <div className="flex max-w-44 items-center gap-1.5">
                        {r.teamId ? (
                          <span className={cx('inline-flex min-w-0 items-center gap-1', r.formerTeam && 'opacity-70')} title={r.formerTeam ? '最近效力的战队' : undefined}>
                            <PTeam id={r.teamId} />
                          </span>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                        {r.status !== 'active' && <span className={cx('shrink-0 text-[11px]', STATUS_CLASS[r.status])}>{STATUS_LABEL[r.status]}</span>}
                      </div>
                    </td>
                    <td title={r.standing ? `第 ${r.standing.rank} / ${r.standing.total}` : undefined}>
                      {r.standing ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className={cx(r.standing.title === '职业选手' ? 'text-mute' : 'text-gold')}>{r.standing.title}</span>
                          <span className="text-xs text-faint tabular">{r.standing.score}</span>
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="num">{r.games || <span className="text-faint">0</span>}</td>
                    <td className="num">{fmtPct(r.winRate)}</td>
                    <td className="num text-mute">{r.games > 0 ? `${fmt1(r.avgK)} / ${fmt1(r.avgD)} / ${fmt1(r.avgA)}` : '—'}</td>
                    <td className="num font-semibold">{r.games > 0 ? fmtKda(r.kda) : '—'}</td>
                    <td className="num">{r.mvps || <span className="text-faint">0</span>}</td>
                    <td className="num">{r.prize > 0 ? <Gold value={r.prize} /> : <span className="text-faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {pages > 1 && (
        <div className="flex justify-end">
          <Pager page={pg} pages={pages} onPage={setPage} total={sorted.length} />
        </div>
      )}
    </div>
  );
}

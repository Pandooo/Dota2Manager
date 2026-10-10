// DotaPedia · 战队：全部战队列表（含已解散 / 除名，按赛区 / 状态筛选，按历史地位 / 冠军 / 胜率排序）→ 战队词条
import { useMemo, useState } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import { REGIONS, REGION_LABEL, isHumanTeam, pediaLegacyBoard } from '../../engine';
import type { GameState, PediaTeamLegacy, Region } from '../../engine';
import { Card, EmptyState, Gold, RegionBadge, cx } from '../components/common';
import { Chip, SortTh, sortList, useSort } from '../components/SquadShared';
import { Segmented, TourSelect } from '../components/TourShared';
import { GradeBadge, PTeam, PediaInput, fmtPct, safe, usePediaSel, PediaEntryGuard } from '../components/PediaKit';
import { WdlBar } from '../components/PediaCharts';
import PediaTeamPage from './PediaTeamPage';

export default function PediaTeams() {
  const game = useGame();
  const sel = usePediaSel('team', game);
  if (sel) {
    return (
      <PediaEntryGuard key={sel} kind="team">
        <PediaTeamPage id={sel} />
      </PediaEntryGuard>
    );
  }
  return <TeamList game={game} />;
}

type Status = 'active' | 'disbanded' | 'banned' | 'gone';
const STATUS_LABEL: Record<Status, string> = { active: '现役', disbanded: '已解散', banned: '已除名', gone: '已不在联赛' };

interface TeamRow {
  id: string;
  name: string;
  tag: string;
  color: string;
  region: Region | null;
  status: Status;
  human: boolean;
  lg: PediaTeamLegacy | null;
  titles: number;
  tiTitles: number;
  majors: number;
  tiApps: number;
  sw: number;
  sd: number;
  sl: number;
  gw: number;
  gl: number;
  seriesRate: number;
  gameRate: number;
  prize: number;
  firstTi: number | null;
}

/** 列表行：现役战队 + DotaPedia 中有记录的历史战队（解散后没有任何战绩的不列出） */
function buildTeamRows(game: GameState): TeamRow[] {
  const titles = new Map<string, { all: number; ti: number; major: number }>();
  const tiApps = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const h of game.history?.tournaments ?? []) {
    if (h.championId && h.tier !== 'qualifier') {
      const t = titles.get(h.championId) ?? { all: 0, ti: 0, major: 0 };
      t.all++;
      if (h.tier === 'ti') t.ti++;
      if (h.tier === 'major') t.major++;
      titles.set(h.championId, t);
    }
    for (const teamId of Object.keys(h.placements ?? {})) {
      if (h.tier === 'ti') tiApps.set(teamId, (tiApps.get(teamId) ?? 0) + 1);
      firstSeen.set(teamId, Math.min(firstSeen.get(teamId) ?? Infinity, h.season));
    }
  }
  const legacy = new Map(safe(() => pediaLegacyBoard(game), [] as PediaTeamLegacy[]).map((l) => [l.teamId, l]));
  const ids = new Set<string>([...Object.keys(game.teams), ...Object.keys(game.pedia?.teams ?? {})]);
  const rows: TeamRow[] = [];
  for (const id of ids) {
    const team = game.teams[id];
    const pt = game.pedia?.teams?.[id];
    let sw = 0, sd = 0, sl = 0, gw = 0, gl = 0, prize = 0;
    let first = firstSeen.get(id) ?? Infinity;
    for (const r of pt?.s ?? []) {
      sw += r.sw || 0;
      sd += r.sd || 0;
      sl += r.sl || 0;
      gw += r.gw || 0;
      gl += r.gl || 0;
      prize += (r.pc || 0) + (r.pp || 0);
      if ((r.sw || 0) + (r.sd || 0) + (r.sl || 0) > 0) first = Math.min(first, r.ti);
    }
    const status: Status = !team ? 'gone' : team.banned ? 'banned' : team.disbanded ? 'disbanded' : 'active';
    const t = titles.get(id);
    const lg = legacy.get(id) ?? null;
    if (status !== 'active' && sw + sd + sl === 0 && !t && !lg) continue;
    rows.push({
      id,
      name: team?.name ?? pt?.n ?? id,
      tag: team?.tag ?? pt?.tag ?? '',
      color: team?.color ?? '#5b6579',
      region: team?.region ?? null,
      status,
      human: isHumanTeam(game, id),
      lg,
      titles: t?.all ?? 0,
      tiTitles: t?.ti ?? 0,
      majors: t?.major ?? 0,
      tiApps: tiApps.get(id) ?? 0,
      sw, sd, sl, gw, gl,
      seriesRate: sw + sd + sl > 0 ? sw / (sw + sd + sl) : NaN,
      gameRate: gw + gl > 0 ? gw / (gw + gl) : NaN,
      prize,
      firstTi: Number.isFinite(first) ? first : null,
    });
  }
  return rows;
}

type SortKey = 'legacy' | 'name' | 'titles' | 'tiApps' | 'series' | 'seriesRate' | 'gameRate' | 'prize' | 'first';

function TeamList({ game }: { game: GameState }) {
  const version = useGameStore((s) => s.version);
  const rows = useMemo(() => buildTeamRows(game), [game, version]);
  const [q, setQ] = useState('');
  const [region, setRegion] = useState<'all' | Region>('all');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const sort = useSort<SortKey>('legacy');
  const me = game.settings.playerTeamId;

  const query = q.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (region !== 'all' && r.region !== region) return false;
    if (status === 'active' && r.status !== 'active') return false;
    if (status === 'inactive' && r.status === 'active') return false;
    if (query && !`${r.name} ${r.tag} ${r.id}`.toLowerCase().includes(query)) return false;
    return true;
  });
  const sorted = sortList(
    filtered,
    (r) => {
      switch (sort.key) {
        case 'legacy':
          return r.lg?.score ?? -1;
        case 'name':
          return r.name;
        case 'titles':
          return r.titles * 1000 + r.tiTitles * 100 + r.majors;
        case 'tiApps':
          return r.tiApps;
        case 'series':
          return r.sw + r.sd + r.sl;
        case 'seriesRate':
          return r.seriesRate;
        case 'gameRate':
          return r.gameRate;
        case 'prize':
          return r.prize;
        case 'first':
          // 尚未出战的排在最后（升序时）
          return r.firstTi ?? (sort.dir === 'asc' ? 1e9 : -1);
      }
    },
    sort.dir,
  );

  const counts = { all: rows.length, active: rows.filter((r) => r.status === 'active').length };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PediaInput value={q} onChange={setQ} placeholder="按战队名 / 简称筛选" className="w-56" />
        <TourSelect value={region} onChange={(v) => setRegion(v as 'all' | Region)} title="赛区">
          <option value="all">全部赛区</option>
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {REGION_LABEL[r]}
            </option>
          ))}
        </TourSelect>
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { key: 'all', label: `全部 ${counts.all}` },
            { key: 'active', label: `现役 ${counts.active}` },
            { key: 'inactive', label: `解散 / 除名 ${counts.all - counts.active}` },
          ]}
        />
        <span className="ml-auto text-xs text-faint">点击表头排序 · 点击战队名打开词条</span>
      </div>

      <Card bodyClassName="p-0">
        {sorted.length === 0 ? (
          <EmptyState text="没有符合条件的战队" />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <SortTh k="name" sort={sort} defaultDir="asc">战队</SortTh>
                  <th>赛区</th>
                  <th>状态</th>
                  <SortTh k="legacy" sort={sort} title="实时历史地位（开局前现实成就 + 本局成就）">历史地位</SortTh>
                  <SortTh k="titles" sort={sort} className="num" title="冠军总数（不含预选赛）">冠军</SortTh>
                  <SortTh k="tiApps" sort={sort} className="num" title="本局 TI 正赛参赛次数">TI</SortTh>
                  <SortTh k="series" sort={sort} title="系列赛 胜-平-负">系列赛</SortTh>
                  <SortTh k="seriesRate" sort={sort} className="num">胜率</SortTh>
                  <SortTh k="gameRate" sort={sort} className="num" title="小局胜率">小局</SortTh>
                  <SortTh k="prize" sort={sort} className="num" title="名次奖金（俱乐部 + 队员分成）">奖金</SortTh>
                  <SortTh k="first" sort={sort} defaultDir="asc" title="本局首次出战的赛季">始于</SortTh>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={r.id} className={cx(r.id === me && 'bg-gold/5', r.status !== 'active' && 'opacity-80')}>
                    <td className="num text-faint">{i + 1}</td>
                    <td className="max-w-56">
                      <div className="flex items-center gap-1.5">
                        <PTeam id={r.id} name={r.name} color={r.color} className="font-medium" />
                        {r.tag && <span className="text-[11px] text-faint">{r.tag}</span>}
                        {r.human && <Chip tone={r.id === me ? 'gold' : 'info'}>{r.id === me ? '本方' : '玩家'}</Chip>}
                      </div>
                    </td>
                    <td>{r.region ? <RegionBadge region={r.region} /> : <span className="text-faint">—</span>}</td>
                    <td className={cx('text-xs', r.status === 'active' ? 'text-good' : r.status === 'banned' ? 'text-bad' : 'text-faint')}>
                      {STATUS_LABEL[r.status]}
                    </td>
                    <td title={r.lg ? `${r.lg.summary}\n${r.lg.title.desc}` : undefined}>
                      {r.lg ? (
                        <span className="inline-flex items-center gap-1.5">
                          <GradeBadge grade={r.lg.grade} />
                          <span className={cx(r.lg.title.id === 'unknown' ? 'text-faint' : 'text-ink')}>{r.lg.title.name}</span>
                          <span className="text-xs text-mute tabular">{r.lg.score}</span>
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="num" title={r.titles ? `TI ×${r.tiTitles} · Major ×${r.majors}` : undefined}>
                      {r.titles ? (
                        <span>
                          <span className="font-semibold">{r.titles}</span>
                          {r.tiTitles > 0 && <span className="ml-1 text-[11px] text-gold">TI×{r.tiTitles}</span>}
                        </span>
                      ) : (
                        <span className="text-faint">0</span>
                      )}
                    </td>
                    <td className="num">{r.tiApps || <span className="text-faint">0</span>}</td>
                    <td className="w-40">{r.sw + r.sd + r.sl > 0 ? <WdlBar w={r.sw} d={r.sd} l={r.sl} /> : <span className="text-faint">—</span>}</td>
                    <td className="num">{fmtPct(r.seriesRate)}</td>
                    <td className="num text-mute">{fmtPct(r.gameRate)}</td>
                    <td className="num">{r.prize > 0 ? <Gold value={r.prize} /> : <span className="text-faint">—</span>}</td>
                    <td className="text-mute tabular">{r.firstTi ? `TI${r.firstTi}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

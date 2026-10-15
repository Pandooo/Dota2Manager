// DotaPedia · 名人堂（2026-10-14 抽卡回归）：初始成员（DotA1 时代传奇）+ 开局补录（开局届之前真实数据中的 SS / SSR，2026-10-15「补录」）
// + 本局历届赛季结算时为 SS / SSR 的选手。来源用徽章区分（DotA1 时代 / 真实数据补录 / 本局入堂），可按来源筛选。
// 名人堂成员是新秀抽卡「请神」的原型（出道等级与卡的等级相同）；列出每名成员的出道 / 巅峰等级、能否作为原型与在役的请神新秀。只读。
import { useMemo, useState } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import { CONFIG, HOF_SOURCE_LABEL, REGION_LABEL, hallOfFameRows, livingSummonsOf, pediaHasPlayer, regionOfNationality } from '../../engine';
import type { HallOfFameRow } from '../../engine';
import { Badge, Card, EmptyState, PosBadge, TableScroll, TierBadge, cx } from '../components/common';
import { PHONE_HIDE, PPlayer, PStat, PTeam, PediaInput, Pager, STICKY_TD, STICKY_TH, safe } from '../components/PediaKit';

type Filter = 'all' | 'dota1' | 'backfill' | 'inducted' | 'summonable' | 'living';
const FILTERS: { key: Filter; label: string; title: string }[] = [
  { key: 'all', label: '全部', title: '全部名人堂成员' },
  { key: 'dota1', label: HOF_SOURCE_LABEL.seed, title: 'TI1 之前 DotA1 时代的传奇（初始成员）' },
  { key: 'backfill', label: HOF_SOURCE_LABEL.backfill, title: '开局届之前，真实数据中达到过 SS / SSR 的真实选手（开局时补录）' },
  { key: 'inducted', label: HOF_SOURCE_LABEL.inducted, title: '本局赛季结算时天梯等级为 SS / SSR 的选手' },
  { key: 'summonable', label: '可请神', title: '可作为新秀抽卡的请神原型' },
  { key: 'living', label: '有在役请神新秀', title: '联盟中有在役的请神新秀' },
];

/** 入选来源的徽章（DotA1 时代 / TI{n} · 真实数据补录 / TI{n} 入堂） */
function HofSourceBadge({ source, ti }: { source: HallOfFameRow['source']; ti: number }) {
  if (source === 'seed') return <Badge className="bg-gold/15 text-gold" title="TI1 之前 DotA1 时代的传奇（初始成员）">{HOF_SOURCE_LABEL.seed}</Badge>;
  if (source === 'backfill') {
    return (
      <Badge className="bg-info/15 text-[#b9d9ff]" title={`开局时补录：真实历史中 TI${ti} 首次达到 SS / SSR（开局届之前的真实数据）`}>
        TI{ti} · {HOF_SOURCE_LABEL.backfill}
      </Badge>
    );
  }
  return <Badge className="bg-panel-3 text-ink" title={`本局 TI${ti} 赛季结算时为 SS / SSR`}>TI{ti} {HOF_SOURCE_LABEL.inducted}</Badge>;
}
const PAGE = 40;

export default function PediaHallOfFame() {
  const game = useGame();
  const version = useGameStore((s) => s.version);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  // 手机：说明先显示三行，可展开（全文约 250px 高）
  const [about, setAbout] = useState(false);
  const rows = useMemo(() => safe(() => hallOfFameRows(game), [] as HallOfFameRow[]), [game, version]);
  const living = rows.reduce((a, r) => a + r.livingSummons, 0);
  const seeds = rows.filter((r) => r.source === 'seed').length;
  const backfilled = rows.filter((r) => r.source === 'backfill').length;
  const inducted = rows.length - seeds - backfilled;
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (needle && !r.handle.toLowerCase().includes(needle)) return false;
    switch (filter) {
      case 'dota1':
        return r.source === 'seed';
      case 'backfill':
        return r.source === 'backfill';
      case 'inducted':
        return r.source === 'inducted';
      case 'summonable':
        return r.summonable;
      case 'living':
        return r.livingSummons > 0;
      default:
        return true;
    }
  });
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const list = shown.slice(cur * PAGE, cur * PAGE + PAGE);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="grid grid-cols-3 gap-3 self-start">
          <PStat
            label="名人堂成员"
            value={rows.length}
            accent
            sub={`DotA1 ${seeds} · 补录 ${backfilled} · 本局 ${inducted}`}
            title={`DotA1 时代传奇 ${seeds} 名 · 真实数据补录 ${backfilled} 名 · 本局入堂 ${inducted} 名`}
          />
          <PStat label="可请神原型" value={rows.filter((r) => r.summonable).length} sub="按出道等级配卡" title="某等级的请神卡只匹配出道等级相同的原型" />
          <PStat label="在役请神新秀" value={living} sub="全联盟" title="全联盟在役的请神新秀人数" />
        </div>
        <div className="rounded-xl border border-line bg-panel/90 px-4 py-3 text-xs leading-relaxed text-mute">
          <div className="mb-1.5 text-[13px] font-semibold text-ink">名人堂与请神</div>
          <p className={cx(!about && 'max-sm:line-clamp-3')}>
            初始成员是 TI1 之前 DotA1 时代的传奇；开局届晚于 TI1 时，开局届之前在真实历史中达到过 SS / SSR 的真实选手在开局时<b className="text-[#b9d9ff]">补录</b>（登记首次达到的届次，巅峰等级只取开局届及之前的数据，不剧透）；之后每个赛季结算时，天梯等级为 SS / SSR 的在役选手全部入选。名人堂成员从下个赛季起成为新秀抽卡的<b className="text-[#c39cff]">请神</b>原型：某等级的请神卡只匹配出道等级相同的原型，请神新秀复制原型的出道能力、天赋与位置，之后的成长走势复制原型的生涯（真实选手按其真实历史；本局入选的虚构选手按本局记录）。同一原型每赛季至多 {CONFIG.gacha.summonMaxPerPrototype} 张；请神新秀入选名人堂后不再作为原型。
          </p>
          <button type="button" className="mt-1 min-h-9 cursor-pointer text-info hover:text-gold sm:hidden" onClick={() => setAbout((v) => !v)}>
            {about ? '收起说明 ▴' : '展开说明 ▾'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* 手机：筛选按钮一行横向滑动（不折成「全/部」逐字换行），触屏上按钮至少 36px 高 */}
        <div className="no-scrollbar inline-flex max-w-full overflow-x-auto rounded-md border border-line sm:flex-wrap sm:overflow-hidden">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setFilter(f.key);
                setPage(0);
              }}
              title={f.title}
              className={cx(
                'shrink-0 cursor-pointer whitespace-nowrap px-3 py-1 text-xs pointer-coarse:min-h-9',
                filter === f.key ? 'bg-panel-3 font-semibold text-ink' : 'bg-panel-2 text-mute hover:text-ink',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 max-sm:w-full">
          <PediaInput
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(0);
            }}
            placeholder="搜索选手 ID"
            className="w-full sm:w-44"
          />
          <Pager page={cur} pages={pages} onPage={setPage} total={shown.length} />
        </div>
      </div>

      <Card bodyClassName="p-0">
        {list.length === 0 ? (
          <EmptyState text="没有符合条件的名人堂成员" />
        ) : (
          // 手机（< sm）：选手列固定在左侧，赛区与「原型」列隐藏（来源一列已说明）
          <TableScroll>
            <table className="tbl">
              <thead>
                <tr>
                  <th className={STICKY_TH}>选手</th>
                  <th title="入选来源：DotA1 时代 / 真实数据补录（开局时）/ 本局入堂（赛季结算）">来源</th>
                  <th>位置</th>
                  <th className={PHONE_HIDE}>赛区</th>
                  <th title="出道等级：请神卡按此匹配">出道</th>
                  <th title="名人堂登记的生涯巅峰等级（真实选手只取截止届及之前的真实数据：DotA1 传奇与补录的选手截止到开局届，本局入堂的截止到入选届；在役时随本局等级更新。伍声（2009）按登记数据。与选手页信息框中本局的巅峰等级口径不同）">生涯巅峰</th>
                  <th className={PHONE_HIDE} title="能否作为请神原型">原型</th>
                  <th className="num">在役请神新秀</th>
                  <th>本局</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const expanded = open === r.id && r.livingSummons > 0;
                  return (
                    <HallRow key={r.id} r={r} expanded={expanded} onToggle={() => setOpen(expanded ? null : r.id)} />
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>
    </div>
  );
}

function HallRow({ r, expanded, onToggle }: { r: HallOfFameRow; expanded: boolean; onToggle: () => void }) {
  const game = useGame();
  const hasPage = safe(() => pediaHasPlayer(game, r.id), false);
  const summons = expanded ? safe(() => livingSummonsOf(game, r.id), []) : [];
  return (
    <>
      <tr>
        <td className={STICKY_TD}>
          <span className="inline-flex flex-wrap items-center gap-1.5 max-sm:max-w-[9rem]">
            {hasPage ? <PPlayer id={r.id} handle={r.handle} /> : <span className="font-medium" title="不在任何阵容数据中的传奇">{r.handle}</span>}
            {r.src === 'summon' && <Badge className="bg-[#7a4fb5]/20 text-[#c39cff]" title="请神新秀入选（不再作为原型）">请神 · {r.ofHandle}</Badge>}
          </span>
        </td>
        <td><HofSourceBadge source={r.source} ti={r.ti} /></td>
        <td><PosBadge pos={r.position} /></td>
        <td className={cx('text-xs text-mute', PHONE_HIDE)}>{REGION_LABEL[regionOfNationality(r.nationality)] ?? r.nationality}</td>
        <td><TierBadge tier={r.debutTier} /></td>
        <td><TierBadge tier={r.peakTier} /></td>
        <td className={cx('text-xs', PHONE_HIDE)}>{r.summonable ? <span className="text-[#c39cff]">可请神</span> : <span className="text-faint">—</span>}</td>
        <td className="num">
          {r.livingSummons > 0 ? (
            <button type="button" onClick={onToggle} className="cursor-pointer font-semibold text-[#c39cff] hover:underline pointer-coarse:min-h-9 pointer-coarse:px-2" title="展开在役的请神新秀">
              {r.livingSummons} {expanded ? '▴' : '▾'}
            </button>
          ) : (
            <span className="text-faint">0</span>
          )}
        </td>
        <td className="text-xs text-mute">{r.inGame === 'active' ? '在役' : r.inGame === 'retired' ? '已退役' : '不在本局'}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9} className="bg-panel-2/40 max-sm:whitespace-normal">
            <div className="flex flex-wrap gap-2 py-1 text-xs max-sm:max-w-[calc(100vw-3rem)]">
              {summons.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1 rounded border border-[#7a4fb5]/40 bg-[#7a4fb5]/10 px-1.5 py-0.5">
                  <PPlayer id={p.id} handle={p.handle} />
                  {p.teamId ? <PTeam id={p.teamId} /> : <span className="text-faint">自由选手</span>}
                  <span className="text-faint">TI{p.summon?.ti} 出道</span>
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

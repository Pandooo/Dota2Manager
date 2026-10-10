// 消息中心：待决策事件置顶 + 新闻流（全部 / 我的 / 世界 / 转会 / 赛事 / 周报 筛选、分类、未读、点击展开阅读）
// 新闻带战队/选手标签（NewsItem.teamIds / playerIds），点击打开详情弹窗。
import { useState } from 'react';
import { mpHumanTeamIds, useCall, useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import { type GameState, type NewsCategory, type NewsItem, type PendingDecision } from '../../engine';
import { newsIsMine } from '../../engine/news';
import { Badge, Button, Card, EmptyState, Hint, PageHeader, Tabs, cx } from '../components/common';
import { NEWS_CATEGORY_LABEL, NEWS_CATEGORY_STYLE, roundLabel } from '../components/ShellKit';
import { NewsChips } from '../components/WorldFeed';

type TabKey = 'all' | 'mine' | 'players' | 'world' | 'transfer' | 'tournament' | 'weekly';
const PAGE = 40;
const CATS: NewsCategory[] = ['event', 'match', 'tournament', 'transfer', 'finance', 'patch', 'season', 'system'];
const TAB_LABEL: Record<TabKey, string> = { all: '全部', mine: '我的', players: '其他玩家动态', world: '世界', transfer: '转会', tournament: '赛事', weekly: '周报' };
const TAB_HINT: Record<TabKey, string> = {
  all: '全部消息',
  mine: '与我的战队相关的消息',
  players: '多人对战中其他玩家战队的动态（转会、签约、赛果……）',
  world: '其他战队与社区的动态',
  transfer: '转会、签约、传闻',
  tournament: '赛事与比赛结果',
  weekly: '刀塔周报：实力榜、热门选手、转会动态',
};

function matchesTab(game: GameState, n: NewsItem, tab: TabKey): boolean {
  switch (tab) {
    case 'mine':
      return newsIsMine(game, n);
    case 'world':
      return !newsIsMine(game, n);
    case 'transfer':
      return n.category === 'transfer';
    case 'tournament':
      return n.category === 'tournament' || n.category === 'match';
    case 'weekly':
      return !!n.tags?.includes('weekly');
    default:
      return true;
  }
}

/** 决策只记录了创建回合：创建回合晚于当前回合 → 上赛季末产生（如合同到期、退役转教练） */
function decisionWhen(game: GameState, d: PendingDecision): string {
  const ti = game.season?.ti ?? 0;
  if (d.createdRound > game.roundIndex) return `TI${ti - 1} 赛季末`;
  return `TI${ti} · ${roundLabel(game, ti, d.createdRound)}`;
}

// ---------------------------------------------------------------------------
// 待决策事件卡片
// ---------------------------------------------------------------------------
function DecisionCard({ d, onChoose }: { d: PendingDecision; onChoose: (choiceId: string) => void }) {
  const game = useGame();
  const choices = d.choices?.length ? d.choices : [{ id: 'ack', label: '知道了' }];
  return (
    <div className="fade-up relative overflow-hidden rounded-xl border-2 border-dota/60 bg-gradient-to-br from-dota/15 via-panel to-panel shadow-lg shadow-dota/10">
      <span className="absolute inset-y-0 left-0 w-1 bg-dota-2" />
      <div className="flex flex-wrap items-center gap-2 border-b border-line/60 px-5 py-2.5">
        <span className="text-base font-semibold">{d.title}</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-faint">
          {d.blocking && <Badge className="bg-bad/20 text-bad" title="处理之前无法推进回合">需先处理</Badge>}
          {decisionWhen(game, d)}
        </span>
      </div>
      <div className="px-5 py-3">
        <p className="whitespace-pre-line text-sm leading-relaxed text-ink/90">{d.body}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {choices.map((c) => (
            <button
              key={c.id}
              onClick={() => onChoose(c.id)}
              className="group flex cursor-pointer flex-col rounded-lg border border-line bg-panel-2/80 px-3.5 py-2.5 text-left transition-all hover:border-gold/60 hover:bg-panel-3"
            >
              <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                {c.label}
                <span className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-gold">›</span>
              </span>
              {c.description && <span className="mt-0.5 text-xs leading-snug text-mute">{c.description}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新闻行
// ---------------------------------------------------------------------------
function NewsRow({ n, mine, open, onToggle }: { n: NewsItem; mine: boolean; open: boolean; onToggle: () => void }) {
  const weekly = !!n.tags?.includes('weekly');
  return (
    <div className={cx('relative border-b border-line/50 last:border-b-0', n.important && 'bg-gold/[0.04]', open && 'bg-panel-2/40')}>
      {mine && <span className="absolute inset-y-0 left-0 w-0.5 bg-gold/60" title="与我的战队相关" />}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-panel-2/60"
      >
        <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-transparent ring-1 ring-line' : 'bg-dota-2 shadow-[0_0_6px_rgba(226,82,59,0.7)]')} title={n.read ? '已读' : '未读'} />
        <span className="w-12 shrink-0 pt-0.5">
          <Badge className={weekly ? 'bg-gold/20 text-gold' : NEWS_CATEGORY_STYLE[n.category]}>{weekly ? '周报' : NEWS_CATEGORY_LABEL[n.category] ?? n.category}</Badge>
        </span>
        <span className="min-w-0 flex-1">
          <span className={cx('flex items-center gap-1.5 text-sm', n.read ? 'text-mute' : 'font-semibold text-ink')}>
            {n.important && (
              <span className="text-gold" title="重要">
                ★
              </span>
            )}
            <span className={cx(open ? 'whitespace-normal' : 'truncate')}>{n.title}</span>
          </span>
          {!open && n.body && <span className="mt-0.5 block truncate text-xs text-faint">{n.body.replace(/\s+/g, ' ')}</span>}
          <NewsChips n={n} className="mt-1" maxTeams={open ? 8 : 4} maxPlayers={open ? 8 : 3} />
        </span>
        <span className="shrink-0 pt-0.5 text-right text-[11px] tabular text-faint">{n.date}</span>
        <span className={cx('shrink-0 pt-0.5 text-xs text-faint transition-transform', open && 'rotate-90 text-gold')}>›</span>
      </div>
      {open && (
        <div className="fade-up px-4 pb-3.5 pl-[5.25rem]">
          <p className="whitespace-pre-line rounded-lg border border-line/70 bg-panel/80 px-4 py-3 text-sm leading-relaxed text-ink/90">{n.body || '（无正文）'}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
export default function Inbox() {
  const game = useGame();
  const call = useCall();
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const toast = useGameStore((s) => s.toast);
  const multi = useGameStore((s) => s.mode === 'multi');
  const roundStatus = useGameStore((s) => s.mp.roundStatus);
  const room = useGameStore((s) => s.mp.room);

  const [tab, setTab] = useState<TabKey>('all');
  const [cat, setCat] = useState<NewsCategory | 'all'>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [limit, setLimit] = useState(PAGE);

  const news = game.news ?? [];
  const decisions = game.pendingDecisions ?? [];
  const unread = news.filter((n) => !n.read).length;

  // 新闻 ≤ CONFIG.newsroom.maxNews 条，每次渲染现算（引擎原地修改数组，避免 memo 失效问题）
  // 多人：其他玩家（人类）战队——「其他玩家动态」筛选
  const me = game.settings.playerTeamId;
  const others = new Set(multi ? mpHumanTeamIds({ roundStatus, room }, game).filter((id) => id !== me) : []);
  const isOthers = (n: NewsItem) =>
    others.size > 0 && ((!!n.actorTeamId && others.has(n.actorTeamId)) || (n.teamIds ?? []).some((id) => others.has(id)));
  const tabKeys: TabKey[] = multi
    ? ['all', 'mine', 'players', 'world', 'transfer', 'tournament', 'weekly']
    : ['all', 'mine', 'world', 'transfer', 'tournament', 'weekly'];
  const othersIds = new Set<string>();
  const unreadBy = new Map<TabKey, number>();
  const totalBy = new Map<TabKey, number>();
  const catTotal = new Map<NewsCategory, number>();
  const mineIds = new Set<string>();
  for (const n of news) {
    // 「我的」按当前座位判断（单机 = 玩家战队；多人模式下其他玩家的消息归入「世界」）
    const isMine = newsIsMine(game, n);
    if (isMine) mineIds.add(n.id);
    const isOther = multi && isOthers(n);
    if (isOther) othersIds.add(n.id);
    catTotal.set(n.category, (catTotal.get(n.category) ?? 0) + 1);
    for (const k of tabKeys) {
      const hit = k === 'mine' ? isMine : k === 'world' ? !isMine : k === 'players' ? isOther : matchesTab(game, n, k);
      if (!hit) continue;
      totalBy.set(k, (totalBy.get(k) ?? 0) + 1);
      if (!n.read) unreadBy.set(k, (unreadBy.get(k) ?? 0) + 1);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = news.filter(
    (n) =>
      (tab === 'all' ||
        (tab === 'mine' ? mineIds.has(n.id) : tab === 'world' ? !mineIds.has(n.id) : tab === 'players' ? othersIds.has(n.id) : matchesTab(game, n, tab))) &&
      (cat === 'all' || n.category === cat) &&
      (!unreadOnly || !n.read) &&
      (!q || n.title.toLowerCase().includes(q) || (n.body ?? '').toLowerCase().includes(q)),
  );
  const shown = filtered.slice(0, limit);
  const catKeys = CATS.filter((c) => (catTotal.get(c) ?? 0) > 0 || c === cat);

  const toggle = (n: NewsItem) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(n.id)) next.delete(n.id);
      else next.add(n.id);
      return next;
    });
    if (!n.read) {
      void callSilent('markNewsRead', n.id);
    }
  };

  const choose = (d: PendingDecision, choiceId: string) => {
    void call('resolveDecision', d.id, choiceId).then((res) => {
      // 签证问题需要野外替补时（主动选择或现有替补不足），候选已生成：直接带玩家去转会市场雇佣
      if (res?.ok && d.kind === 'visa' && (choiceId === 'temp_sub' || res.message.includes('临时替补'))) setView('market');
    });
  };

  const markAll = () => {
    void callSilent('markAllNewsRead');
    toast('已将全部消息标为已读');
  };

  // 分组：赛季 + 回合变化时插入分组标题
  const rows: ({ type: 'head'; key: string; label: string; date: string } | { type: 'item'; n: NewsItem })[] = [];
  let lastKey = '';
  for (const n of shown) {
    const key = `${n.season}-${n.round}`;
    if (key !== lastKey) {
      // 同一 (赛季, 回合) 理论上连续出现；附加序号防止极端情况下 key 重复
      rows.push({ type: 'head', key: `${key}-${rows.length}`, label: `TI${n.season} 赛季 · ${roundLabel(game, n.season, n.round)}`, date: n.date });
      lastKey = key;
    }
    rows.push({ type: 'item', n });
  }

  return (
    <div>
      <PageHeader
        title="消息中心"
        subtitle={
          <span>
            待处理 <b className={cx(decisions.length ? 'text-dota-2' : 'text-ink')}>{decisions.length}</b> · 未读 <b className="text-ink">{unread}</b> · 共 {news.length} 条消息
          </span>
        }
        actions={
          <Button onClick={markAll} disabled={unread === 0} title={unread === 0 ? '没有未读消息' : undefined}>
            ✓ 全部标为已读
          </Button>
        }
      />

      {/* ---------- 待决策 ---------- */}
      {decisions.length > 0 && (
        <div className="mb-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-dota-2" />
            <span className="text-sm font-semibold">待你决策（{decisions.length}）</span>
            <Hint>标有「需先处理」的事件，做出选择之前无法进入下一回合。</Hint>
          </div>
          {decisions.map((d) => (
            <DecisionCard key={d.id} d={d} onChoose={(cid) => choose(d, cid)} />
          ))}
        </div>
      )}

      {/* ---------- 新闻 ---------- */}
      <Card bodyClassName="p-0">
        <div className="px-4 pt-2">
          <Tabs
            tabs={tabKeys.map((k) => {
              const u = unreadBy.get(k) ?? 0;
              return {
                key: k,
                label: <span title={TAB_HINT[k]}>{TAB_LABEL[k]}</span>,
                badge: u > 0 ? <span className="rounded-full bg-dota px-1.5 text-[10px] font-bold leading-4 text-white">{u > 99 ? '99+' : u}</span> : undefined,
              };
            })}
            value={tab}
            onChange={(k) => {
              setTab(k);
              setLimit(PAGE);
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="搜索标题或内容…"
            className="w-56 rounded-md border border-line bg-panel-2 px-2.5 py-1 text-xs text-ink outline-none placeholder:text-faint focus:border-gold/60"
          />
          <select
            value={cat}
            onChange={(e) => {
              setCat(e.target.value as NewsCategory | 'all');
              setLimit(PAGE);
            }}
            className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-ink outline-none focus:border-gold/60"
            title="按分类筛选"
          >
            <option value="all">全部分类</option>
            {catKeys.map((c) => (
              <option key={c} value={c}>
                {NEWS_CATEGORY_LABEL[c]}（{catTotal.get(c) ?? 0}）
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-mute">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => {
                setUnreadOnly(e.target.checked);
                setLimit(PAGE);
              }}
              className="accent-[#c23c2a]"
            />
            仅未读
          </label>
          <span className="ml-auto text-[11px] text-faint">
            {filtered.length} 条
            {openIds.size > 0 && (
              <button className="ml-2 cursor-pointer text-mute hover:text-ink" onClick={() => setOpenIds(new Set())}>
                全部收起
              </button>
            )}
          </span>
        </div>

        {filtered.length === 0 ? (
          <EmptyState text={news.length === 0 ? '还没有任何消息。推进回合后，赛事、转会、事件与版本更新都会出现在这里。' : '没有符合条件的消息'} />
        ) : (
          <div>
            {rows.map((r) =>
              r.type === 'head' ? (
                <div key={`h-${r.key}`} className="flex items-center justify-between border-b border-line/60 bg-panel-2/60 px-4 py-1 text-[11px] font-semibold tracking-wide text-faint">
                  <span>{r.label}</span>
                  <span className="font-normal">{r.date}</span>
                </div>
              ) : (
                <NewsRow key={r.n.id} n={r.n} mine={mineIds.has(r.n.id)} open={openIds.has(r.n.id)} onToggle={() => toggle(r.n)} />
              ),
            )}
            {filtered.length > shown.length && (
              <div className="flex justify-center border-t border-line py-3">
                <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                  加载更多（还有 {filtered.length - shown.length} 条）
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

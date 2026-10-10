// ============================================================================
// 比赛页 · 大老师胜率 + 文字直播 + 赛果
// 直播播放进度完全是本地 UI 状态，不修改游戏状态。「跳过 / 继续」在底部吸附操作栏（MatchDock）。
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameRecord, GameState, InMatchEvent, LiveEvent, LiveEventType } from '../../engine/types';
import { POSITIONS } from '../../engine/types';
import { CONFIG } from '../../engine';
import { Badge, Button, Card, Hint, PosBadge, TeamTag, cx } from './common';
import { HeroAvatar, heroCn } from './MatchHero';
import MatchGoldChart, { type GoldPoint } from './MatchGoldChart';
import {
  FACTION_HEX,
  FACTION_LABEL,
  FactionBadge,
  MineBadge,
  factionOf,
  fmtClock,
  fmtDuration,
  fmtGoldK,
  otherSide,
  pct,
  strengthShare,
  teamOrStub,
  type Side,
} from './MatchShared';

// ---------------------------------------------------------------------------
// 播放控制（本地状态；切换页面后回来可继续）
// ---------------------------------------------------------------------------
export type Speed = 1 | 2 | 4;
/** 1x 每条事件间隔（毫秒） */
const BASE_MS = 1100;
/** 1x 下第一条事件前的停顿：留时间看大老师胜率 */
const FIRST_DELAY_MS = 1800;
/**
 * 播放进度记忆：以对局记录对象本身为键（引擎原地修改 state，pendingGame 在提交前保持同一对象）。
 * 切页再回来可续播；读档/重开后是新对象，不会误判为「已播完」而提前剧透赛果。
 */
const playbackMemory = new WeakMap<GameRecord, number>();
let rememberedSpeed: Speed = 1;

export interface Playback {
  n: number;
  total: number;
  done: boolean;
  speed: Speed;
  paused: boolean;
  setSpeed: (s: Speed) => void;
  togglePause: () => void;
  skip: () => void;
}

const liveLength = (rec: GameRecord | null) => (rec && Array.isArray(rec.live) ? rec.live.length : 0);

/**
 * 直播播放进度（纯本地 UI 状态，不修改游戏状态）。
 * rec=null 表示当前不在直播阶段；startDone=true 时直接显示到结尾。
 */
export function useLivePlayback(rec: GameRecord | null | undefined, startDone: boolean): Playback {
  const cur = rec ?? null;
  const total = liveLength(cur);
  const initial = (r: GameRecord | null) => (!r ? 0 : startDone ? liveLength(r) : Math.min(liveLength(r), playbackMemory.get(r) ?? 0));
  const [state, setState] = useState(() => ({ rec: cur, n: initial(cur) }));
  const [speed, setSpeedState] = useState<Speed>(rememberedSpeed);
  const [paused, setPaused] = useState(false);

  let n = state.n;
  if (state.rec !== cur) {
    // 换局：重置进度（渲染期派生状态更新，React 会立即重渲染）
    n = initial(cur);
    setState({ rec: cur, n });
    if (paused) setPaused(false);
  } else if (startDone && n < total) {
    n = total;
    setState({ rec: cur, n });
  }

  useEffect(() => {
    if (!cur || paused || n >= total) return;
    const delay = Math.round((n === 0 ? FIRST_DELAY_MS : BASE_MS) / speed);
    const t = window.setTimeout(() => {
      setState((s) => (s.rec === cur ? { rec: cur, n: Math.min(total, s.n + 1) } : s));
    }, delay);
    return () => window.clearTimeout(t);
  }, [cur, n, total, speed, paused]);

  useEffect(() => {
    if (cur) playbackMemory.set(cur, n);
  }, [cur, n]);

  const setSpeed = useCallback((s: Speed) => {
    rememberedSpeed = s;
    setSpeedState(s);
    setPaused(false);
  }, []);
  const togglePause = useCallback(() => setPaused((p) => !p), []);
  const skip = useCallback(() => setState((s) => ({ rec: s.rec, n: liveLength(s.rec) })), []);

  return { n, total, done: total === 0 || n >= total, speed, paused, setSpeed, togglePause, skip };
}

// ---------------------------------------------------------------------------
// 事件样式
// ---------------------------------------------------------------------------
const EVENT_STYLE: Record<LiveEventType, { label: string; icon: string; cls: string; strong?: boolean }> = {
  start: { label: '开局', icon: '▶', cls: 'border-info/40 bg-info/15 text-info' },
  firstblood: { label: '一血', icon: '✚', cls: 'border-dota/50 bg-dota/20 text-dota-2', strong: true },
  kill: { label: '击杀', icon: '✕', cls: 'border-line bg-panel-3 text-ink' },
  teamfight: { label: '团战', icon: '⚔', cls: 'border-[#ff7a45]/40 bg-[#ff7a45]/15 text-[#ff9c6e]', strong: true },
  tower: { label: '推塔', icon: '♜', cls: 'border-[#8a5a2b]/50 bg-[#8a5a2b]/25 text-[#e0a35f]' },
  roshan: { label: '肉山', icon: '◆', cls: 'border-tier-s/40 bg-tier-s/15 text-tier-s', strong: true },
  barracks: { label: '兵营', icon: '▣', cls: 'border-[#b0703a]/50 bg-[#b0703a]/20 text-[#f0a868]' },
  buyback: { label: '买活', icon: '↺', cls: 'border-gold/40 bg-gold/10 text-gold' },
  rampage: { label: '暴走', icon: '★', cls: 'border-[#ff4d6d]/50 bg-[#ff4d6d]/20 text-[#ff8fa3]', strong: true },
  godlike: { label: '超神', icon: '✦', cls: 'border-[#c77dff]/50 bg-[#c77dff]/20 text-[#e0aaff]', strong: true },
  highground: { label: '高地', icon: '▲', cls: 'border-[#ff9f1a]/40 bg-[#ff9f1a]/15 text-[#ffbf5e]', strong: true },
  comeback: { label: '翻盘', icon: '⇅', cls: 'border-tier-ss/50 bg-tier-ss/15 text-tier-ss', strong: true },
  incident: { label: '突发', icon: '!', cls: 'border-gold/60 bg-gold/20 text-gold', strong: true },
  gg: { label: 'GG', icon: '■', cls: 'border-gold bg-gold text-black', strong: true },
  info: { label: '解说', icon: '·', cls: 'border-line bg-panel-2 text-mute' },
};
const styleOf = (t: LiveEventType) => EVENT_STYLE[t] ?? EVENT_STYLE.info;

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------
export default function MatchLive({
  game,
  rec,
  mySide,
  playback,
  scoreBefore,
  gameNo,
}: {
  game: GameState;
  rec: GameRecord;
  /** 本局是系列赛第几局（1 起） */
  gameNo: number;
  /** 玩家在本局记录中的 A/B 方 */
  mySide: Side;
  playback: Playback;
  /** 本局开始前的系列赛比分（我方 / 对手） */
  scoreBefore: { mine: number; opp: number };
}) {
  const teamA = teamOrStub(game, rec.teamA);
  const teamB = teamOrStub(game, rec.teamB);
  const teams = { A: teamA, B: teamB };
  const oppSide = otherSide(mySide);
  const live = Array.isArray(rec.live) ? rec.live : [];
  const revealed = live.slice(0, playback.n);
  const latest: LiveEvent | undefined = revealed[revealed.length - 1];
  const facA = factionOf(rec.radiant, 'A');
  const facB = factionOf(rec.radiant, 'B');
  const colorA = facA ? FACTION_HEX[facA] : '#4ea1ff';
  const colorB = facB ? FACTION_HEX[facB] : '#d9473a';
  const sideColor = (s: Side | undefined) => (s === 'A' ? colorA : s === 'B' ? colorB : undefined);

  const { done } = playback;

  // ---- 空格 = 跳过 ----
  const { skip } = playback;
  useEffect(() => {
    if (done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, skip]);

  // ---- 自动滚动直播（玩家向上翻看时不强行拉回，跳过时直接到底） ----
  const feedRef = useRef<HTMLOListElement>(null);
  const prevN = useRef(playback.n);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const onFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (atBottom !== followRef.current) {
      followRef.current = atBottom;
      setFollow(atBottom);
    }
  };
  const scrollToLatest = () => {
    followRef.current = true;
    setFollow(true);
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  };
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const jump = Math.abs(playback.n - prevN.current) > 2;
    prevN.current = playback.n;
    if (!followRef.current && !jump) return;
    if (jump) {
      followRef.current = true;
      setFollow(true);
    }
    el.scrollTo({ top: el.scrollHeight, behavior: jump ? 'auto' : 'smooth' });
  }, [playback.n]);

  // ---- 结束后滚动到赛果 ----
  const resultRef = useRef<HTMLDivElement>(null);
  const wasDone = useRef(done);
  useEffect(() => {
    if (done && !wasDone.current) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    wasDone.current = done;
  }, [done]);

  const killsA = done ? rec.killsA : latest?.killsA ?? 0;
  const killsB = done ? rec.killsB : latest?.killsB ?? 0;
  const goldDiff = latest?.goldDiff ?? 0;
  const clockMin = latest?.minute ?? 0;
  const clock = latest ? fmtClock(latest.minute, latest.second) : '00:00';
  const goldPoints: GoldPoint[] = [{ t: 0, v: 0 }, ...revealed.map((e) => ({ t: e.minute + (e.second || 0) / 60, v: e.goldDiff || 0 }))];
  const goldLeader: Side | null = goldDiff > 0 ? 'A' : goldDiff < 0 ? 'B' : null;

  // 突发事件卡片与直播中对应的「突发」条目同步出现
  const incidents = incidentTimeline(rec, live).filter((x) =>
    done ? true : x.idx >= 0 ? x.idx < playback.n : playback.n > 0 && x.inc.minute <= clockMin,
  );

  const stats = keyStats(revealed);

  return (
    <div className="space-y-4">
      {done && (
        <div ref={resultRef}>
          <ResultBanner game={game} rec={rec} gameNo={gameNo} mySide={mySide} scoreBefore={scoreBefore} />
        </div>
      )}

      {/* ------------------------- 大老师胜率 + 双方阵容 ------------------------- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <DotaPlusCard rec={rec} mySide={mySide} teams={teams} />
        <Card title="双方阵容" subtitle={facA ? `${teamA.tag}：${FACTION_LABEL[facA]} · ${teamB.tag}：${facB ? FACTION_LABEL[facB] : ''}` : undefined} bodyClassName="p-3 space-y-3">
          {(['A', 'B'] as Side[]).map((s) => (
            <DraftRecap key={s} game={game} rec={rec} side={s} team={teams[s]} mine={s === mySide} />
          ))}
        </Card>
      </div>

      {/* ------------------------------ 记分板 ------------------------------ */}
      <section className="overflow-hidden rounded-xl border border-line bg-panel/90 shadow-lg shadow-black/20">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-5 py-4">
          <ScoreSide team={teamA} faction={facA} kills={killsA} mine={mySide === 'A'} color={colorA} />
          <div className="text-center">
            <div className="font-mono text-3xl font-bold tabular tracking-wider">{done ? fmtDuration(rec.durationMin) : clock}</div>
            <div className="mt-0.5 flex items-center justify-center gap-1.5 text-[11px]">
              {done ? (
                <span className="text-gold">比赛结束</span>
              ) : playback.paused ? (
                <span className="text-mute">已暂停</span>
              ) : (
                <>
                  <span className="h-2 w-2 animate-pulse rounded-full bg-dota-2" />
                  <span className="text-dota-2">直播中</span>
                </>
              )}
            </div>
          </div>
          <ScoreSide team={teamB} faction={facB} kills={killsB} mine={mySide === 'B'} color={colorB} right />
        </div>
        <div className="border-t border-line px-5 pb-2 pt-3">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-mute">经济差</span>
            <span className="tabular font-semibold" style={{ color: goldLeader ? sideColor(goldLeader) : undefined }}>
              {goldLeader ? `${teams[goldLeader].tag} 领先 ${fmtGoldK(goldDiff)}` : '经济持平'}
            </span>
          </div>
          <MatchGoldChart points={goldPoints} colorA={colorA} colorB={colorB} height={92} />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel-2/40 px-5 py-2">
          <span className="text-xs text-faint">播放速度</span>
          {([1, 2, 4] as const).map((s) => (
            <Button
              key={s}
              size="xs"
              variant={playback.speed === s && !playback.paused ? 'primary' : 'secondary'}
              disabled={done}
              title={done ? '直播已结束' : `${s} 倍速`}
              onClick={() => playback.setSpeed(s)}
            >
              {s}x
            </Button>
          ))}
          <Button size="xs" variant="ghost" disabled={done} title={done ? '直播已结束' : '暂停/继续播放'} onClick={playback.togglePause}>
            {playback.paused ? '▶ 继续' : '❚❚ 暂停'}
          </Button>
          <span className="ml-auto text-[11px] text-faint">
            <kbd className="rounded border border-line bg-panel-3 px-1 font-mono text-[10px]">Space</kbd> 跳过
          </span>
          <div className="h-1 w-full overflow-hidden rounded-full bg-panel-3">
            <div className="h-full bg-gold/70 transition-all duration-300" style={{ width: `${playback.total ? (playback.n / playback.total) * 100 : 100}%` }} />
          </div>
        </div>
      </section>

      {/* ------------------------------ 直播 + 侧栏 ------------------------------ */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card
          title="文字直播"
          subtitle={`${teamA.tag} vs ${teamB.tag} · 第 ${gameNo} 局`}
          bodyClassName="p-0"
          actions={<span className="text-[11px] tabular text-faint">{playback.n}/{playback.total}</span>}
        >
          {live.length === 0 ? (
            <div className="p-4">
              <Hint>本局没有文字直播数据，已直接给出赛果。</Hint>
            </div>
          ) : (
            <div className="relative">
              <ol ref={feedRef} onScroll={onFeedScroll} className="h-[440px] space-y-0.5 overflow-y-auto px-3 py-2">
                {revealed.length === 0 && (
                  <li className="flex h-full flex-col items-center justify-center gap-1 text-sm text-mute">
                    <span className="animate-pulse">选手入场，比赛即将开始…</span>
                    <span className="text-[11px] text-faint">先看看上方的大老师胜率预测</span>
                  </li>
                )}
                {revealed.map((e, i) => (
                  <FeedRow key={i} e={e} color={sideColor(e.side)} teams={teams} latest={i === revealed.length - 1 && !done} />
                ))}
              </ol>
              {!follow && !done && revealed.length > 0 && (
                <button
                  onClick={scrollToLatest}
                  className="fade-up absolute bottom-3 left-1/2 -translate-x-1/2 cursor-pointer rounded-full border border-gold/50 bg-panel-3/95 px-3 py-1 text-xs text-gold shadow-lg hover:bg-panel-3"
                >
                  ↓ 回到最新
                </button>
              )}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="关键数据" bodyClassName="p-3">
            <div className="mb-1.5 grid grid-cols-[1fr_auto_1fr] text-[11px] text-faint">
              <span className="truncate font-semibold" style={{ color: colorA }}>
                {teamA.tag}
              </span>
              <span />
              <span className="truncate text-right font-semibold" style={{ color: colorB }}>
                {teamB.tag}
              </span>
            </div>
            <div className="space-y-1">
              {STAT_ROWS.map(([type, label]) => (
                <div key={type} className="grid grid-cols-[1fr_auto_1fr] items-center text-sm">
                  <span className="tabular font-semibold">{stats[type].A}</span>
                  <span className="text-[11px] text-mute">{label}</span>
                  <span className="text-right tabular font-semibold">{stats[type].B}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="局内突发" subtitle={incidents.length ? undefined : '暂无'} bodyClassName="p-3 space-y-2">
            {incidents.length === 0 ? (
              <Hint>{done ? '本局没有发生突发事件。' : '突发事件会在发生时出现在这里。'}</Hint>
            ) : (
              incidents.map(({ inc, ev }, i) => {
                const p = game.players[inc.playerId];
                const t = game.teams[inc.teamId];
                const up = inc.powerMult >= 1;
                return (
                  <div key={i} className={cx('fade-up rounded-lg border p-2.5', up ? 'border-good/40 bg-good/5' : 'border-gold/40 bg-gold/5')}>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className={cx('rounded px-1 font-bold text-black', up ? 'bg-good' : 'bg-gold')}>{up ? '高光' : '突发'}</span>
                      <span className="font-mono tabular text-faint">{ev ? fmtClock(ev.minute, ev.second) : `${inc.minute}'`}</span>
                      {t && <TeamTag color={t.color} tag={t.tag} />}
                      <span className="font-semibold">{p?.handle ?? '某选手'}</span>
                    </div>
                    <div className="mt-1 text-[13px] leading-snug">{inc.text}</div>
                    {Number.isFinite(inc.powerMult) && inc.powerMult !== 1 && (
                      <div className={cx('mt-1 text-[11px] tabular', up ? 'text-good' : 'text-bad')}>
                        本局战力 ×{inc.powerMult.toFixed(2)}（{up ? '+' : ''}
                        {((inc.powerMult - 1) * 100).toFixed(0)}%）
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------
const STAT_ROWS: [LiveEventType, string][] = [
  ['tower', '推塔'],
  ['barracks', '兵营'],
  ['roshan', '肉山'],
  ['teamfight', '团战'],
  ['buyback', '买活'],
  ['rampage', '暴走'],
  ['godlike', '超神'],
];

/**
 * 将局内突发事件与直播中对应的「突发」条目配对：
 * idx = 对应直播条目下标（找不到则 -1，按分钟显示）。
 */
function incidentTimeline(rec: GameRecord, live: LiveEvent[]): { inc: InMatchEvent; ev: LiveEvent | null; idx: number }[] {
  const used = new Set<number>();
  return (rec.incidents ?? []).map((inc) => {
    let idx = live.findIndex((e, i) => !used.has(i) && e.type === 'incident' && e.minute === inc.minute);
    if (idx < 0) idx = live.findIndex((e, i) => !used.has(i) && e.type === 'incident' && Math.abs(e.minute - inc.minute) <= 2);
    if (idx >= 0) used.add(idx);
    return { inc, ev: idx >= 0 ? live[idx] : null, idx };
  });
}

function keyStats(events: LiveEvent[]): Record<LiveEventType, { A: number; B: number }> {
  const out = {} as Record<LiveEventType, { A: number; B: number }>;
  for (const [t] of STAT_ROWS) out[t] = { A: 0, B: 0 };
  for (const e of events) {
    if (!e.side || !out[e.type]) continue;
    out[e.type][e.side] += 1;
  }
  return out;
}

function ScoreSide({
  team,
  faction,
  kills,
  mine,
  color,
  right,
}: {
  team: { name: string; tag: string; color: string };
  faction: ReturnType<typeof factionOf>;
  kills: number;
  mine: boolean;
  color: string;
  right?: boolean;
}) {
  return (
    <div className={cx('flex min-w-0 items-center gap-4', right && 'flex-row-reverse text-right')}>
      <div className="min-w-0">
        <div className={cx('flex items-center gap-1.5', right && 'flex-row-reverse')}>
          <FactionBadge faction={faction} />
          {mine && <MineBadge />}
        </div>
        <div className="mt-1 truncate text-base font-bold">{team.name}</div>
        <div className="text-[11px] text-faint">
          <TeamTag color={team.color} tag={team.tag} />
        </div>
      </div>
      <div key={kills} className="fade-up text-5xl font-black tabular" style={{ color }}>
        {kills}
      </div>
    </div>
  );
}

function FeedRow({
  e,
  color,
  teams,
  latest,
}: {
  e: LiveEvent;
  color: string | undefined;
  teams: Record<Side, { tag: string }>;
  latest: boolean;
}) {
  const st = styleOf(e.type);
  return (
    <li
      className={cx(
        'fade-up flex items-start gap-2.5 rounded-r-md border-l-2 py-1.5 pl-2.5 pr-2',
        e.type === 'incident' && 'bg-gold/5',
        e.type === 'gg' && 'bg-gold/10',
        latest && 'bg-panel-2/70',
      )}
      style={{ borderColor: color ?? 'transparent' }}
    >
      <span className="w-11 shrink-0 pt-0.5 font-mono text-[11px] tabular text-faint">{fmtClock(e.minute, e.second)}</span>
      <span className={cx('mt-0.5 inline-flex shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-bold leading-4', st.cls)}>
        <span>{st.icon}</span>
        {st.label}
      </span>
      <span className={cx('min-w-0 flex-1 text-[13px] leading-5', st.strong ? 'font-semibold text-ink' : 'text-ink/90')}>
        {e.side && (
          <span className="mr-1 text-[11px] font-bold" style={{ color }}>
            [{teams[e.side].tag}]
          </span>
        )}
        {e.text}
      </span>
      <span className="shrink-0 pt-0.5 text-[11px] tabular text-faint">
        {e.killsA}–{e.killsB}
      </span>
    </li>
  );
}

/** 大老师胜率（玩家视角）：大号双色条 + 点评 */
function DotaPlusCard({ rec, mySide, teams }: { rec: GameRecord; mySide: Side; teams: Record<Side, { tag: string; name: string; color: string }> }) {
  const ev = rec.eval;
  const dpA = Number.isFinite(ev?.dotaPlusWinRateA) ? ev.dotaPlusWinRateA : 0.5;
  const mine = mySide === 'A' ? dpA : 1 - dpA;
  // 两侧百分比之和恒为 100
  const minePct = Math.round(Math.max(0, Math.min(1, mine)) * 100);
  const oppPct = 100 - minePct;
  const myScore = mySide === 'A' ? ev?.scoreA : ev?.scoreB;
  const oppScore = mySide === 'A' ? ev?.scoreB : ev?.scoreA;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), 80);
    return () => window.clearTimeout(t);
  }, [rec]);
  const w = shown ? mine : 0.5;
  const myTeam = teams[mySide];
  const oppTeam = teams[otherSide(mySide)];
  return (
    <Card title="大老师胜率预测" subtitle="Dota Plus · 基于双方 BP 与战队灵性">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs text-mute">
            <TeamTag color={myTeam.color} tag={myTeam.tag} />
            <MineBadge />
          </div>
          <div className={cx('mt-0.5 text-5xl font-black tabular', mine >= 0.5 ? 'text-good' : 'text-bad')}>{minePct}%</div>
        </div>
        <div className="pb-1 text-center text-[11px] text-faint">
          {Math.abs(mine - 0.5) < 0.03 ? '势均力敌' : mine > 0.5 ? '我方 BP 占优' : '对手 BP 占优'}
        </div>
        <div className="text-right">
          <div className="text-xs text-mute">
            <TeamTag color={oppTeam.color} tag={oppTeam.tag} />
          </div>
          <div className="mt-0.5 text-3xl font-bold tabular text-mute">{oppPct}%</div>
        </div>
      </div>
      <div className="relative mt-3 flex h-4 overflow-hidden rounded-full bg-panel-3 ring-1 ring-black/30">
        <div className="h-full bg-gradient-to-r from-good/60 to-good transition-[width] duration-1000 ease-out" style={{ width: `${w * 100}%` }} />
        <div className="h-full flex-1 bg-gradient-to-r from-bad to-bad/60" />
        <span className="absolute left-1/2 top-0 h-full w-px bg-white/40" />
      </div>
      <ul className="mt-3 space-y-1.5">
        {(ev?.notes ?? []).map((n, i) => (
          <li key={i} className="fade-up flex gap-2 text-[13px] leading-snug" style={{ animationDelay: `${i * 120}ms` }}>
            <span className="mt-0.5 text-[10px] text-gold">◆</span>
            <span>{n}</span>
          </li>
        ))}
      </ul>
      {Number.isFinite(myScore) && Number.isFinite(oppScore) && (
        <div className="mt-3 text-[11px] tabular text-faint">
          BP 评分 · 我方 {Number(myScore).toFixed(1)} : 对手 {Number(oppScore).toFixed(1)}
        </div>
      )}
    </Card>
  );
}

function DraftRecap({ game, rec, side, team, mine }: { game: GameState; rec: GameRecord; side: Side; team: { tag: string; name: string; color: string }; mine: boolean }) {
  const draft = Array.isArray(rec.draft) ? rec.draft : [];
  const picks = draft
    .filter((a) => a.side === side && a.type === 'pick')
    .sort((a, b) => POSITIONS.indexOf(a.position ?? 'HS') - POSITIONS.indexOf(b.position ?? 'HS'));
  const bans = draft.filter((a) => a.side === side && a.type === 'ban');
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs">
        <FactionBadge faction={factionOf(rec.radiant, side)} />
        <TeamTag color={team.color} tag={team.tag} />
        {mine && <MineBadge />}
        <span className="ml-auto flex items-center gap-0.5">
          {bans.map((b, i) => (
            <HeroAvatar key={i} heroId={b.heroId} size="xs" banned />
          ))}
        </span>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {picks.map((a, i) => {
          const p = a.playerId ? game.players[a.playerId] : undefined;
          return (
            <div key={i} className="flex min-w-0 flex-col items-center gap-0.5 rounded-md bg-panel-2/60 px-1 py-1.5 text-center">
              <HeroAvatar heroId={a.heroId} size="md" />
              <span className="w-full truncate text-[11px] font-medium">{heroCn(a.heroId)}</span>
              {a.position && <PosBadge pos={a.position} />}
              <span className="w-full truncate text-[10px] text-mute">{p?.handle ?? '—'}</span>
            </div>
          );
        })}
        {picks.length === 0 && <span className="col-span-5 text-xs text-faint">无阵容数据</span>}
      </div>
    </div>
  );
}

/** 赛果横幅：胜负、比分、时长、MVP、最终胜率揭晓 */
function ResultBanner({
  game,
  rec,
  gameNo,
  mySide,
  scoreBefore,
}: {
  game: GameState;
  rec: GameRecord;
  gameNo: number;
  mySide: Side;
  scoreBefore: { mine: number; opp: number };
}) {
  const win = rec.winner === mySide;
  const winner = teamOrStub(game, rec.winner === 'A' ? rec.teamA : rec.teamB);
  const loser = teamOrStub(game, rec.winner === 'A' ? rec.teamB : rec.teamA);
  const probA = Number.isFinite(rec.winProbA) ? rec.winProbA : 0.5;
  const myProb = mySide === 'A' ? probA : 1 - probA;
  const dpA = Number.isFinite(rec.eval?.dotaPlusWinRateA) ? rec.eval.dotaPlusWinRateA : 0.5;
  const myDp = mySide === 'A' ? dpA : 1 - dpA;
  const myStr = Number(mySide === 'A' ? rec.strengthA : rec.strengthB) || 0;
  const oppStr = Number(mySide === 'A' ? rec.strengthB : rec.strengthA) || 0;
  const myShare = strengthShare(myStr, oppStr);
  const winnerProb = win ? myProb : 1 - myProb;
  const upset = winnerProb < 0.4;
  const mvp = rec.mvpPlayerId ? game.players[rec.mvpPlayerId] : undefined;
  const mvpTeam = mvp?.teamId ? game.teams[mvp.teamId] : undefined;
  const mvpHero = rec.mvpPlayerId ? rec.draft?.find((a) => a.type === 'pick' && a.playerId === rec.mvpPlayerId)?.heroId : undefined;
  const after = { mine: scoreBefore.mine + (win ? 1 : 0), opp: scoreBefore.opp + (win ? 0 : 1) };
  const myKills = mySide === 'A' ? rec.killsA : rec.killsB;
  const oppKills = mySide === 'A' ? rec.killsB : rec.killsA;

  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), 250);
    return () => window.clearTimeout(t);
  }, [rec]);

  return (
    <section
      className={cx(
        'fade-up relative overflow-hidden rounded-xl border p-5 shadow-xl shadow-black/30',
        win ? 'border-gold/60 bg-gradient-to-r from-gold/20 via-panel to-panel' : 'border-bad/50 bg-gradient-to-r from-bad/20 via-panel to-panel',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <div>
          <div className="text-[11px] tracking-[0.3em] text-faint">第 {gameNo} 局 · 赛果</div>
          <div className={cx('pop-in text-5xl font-black tracking-[0.2em]', win ? 'text-gold' : 'text-bad')}>{win ? '胜利' : '失败'}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-mute">
            <TeamTag color={winner.color} tag={winner.tag} /> 击败 <TeamTag color={loser.color} tag={loser.tag} />
            {upset && <Badge className="bg-tier-ss/20 text-tier-ss">爆冷</Badge>}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-[11px] text-faint">击杀</div>
            <div className="text-2xl font-bold tabular">
              <span className={win ? 'text-gold' : 'text-ink'}>{myKills}</span>
              <span className="mx-1 text-faint">:</span>
              <span>{oppKills}</span>
            </div>
          </div>
          <div>
            <div className="text-[11px] text-faint">时长</div>
            <div className="text-2xl font-bold tabular">{fmtDuration(rec.durationMin)}</div>
          </div>
          <div>
            <div className="text-[11px] text-faint">系列赛</div>
            <div className="text-2xl font-bold tabular">
              {after.mine} : {after.opp}
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-[11px] text-faint">本局 MVP</div>
          {mvp ? (
            <div className="mt-0.5 flex items-center gap-2">
              {mvpHero && <HeroAvatar heroId={mvpHero} size="md" />}
              <div className="min-w-0">
                <div className="truncate text-base font-bold text-gold">{mvp.handle}</div>
                <div className="truncate text-[11px] text-mute">
                  {mvpTeam?.tag ?? ''}
                  {mvpHero ? ` · ${heroCn(mvpHero)}` : ''}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-0.5 text-sm text-mute">—</div>
          )}
        </div>

        <div className="min-w-[240px] flex-1">
          <div className="flex items-baseline justify-between text-[11px] text-faint">
            <span>赛前综合胜率揭晓（我方）</span>
            <span className={cx('text-lg font-black tabular transition-opacity duration-700', shown ? 'opacity-100' : 'opacity-0', myProb >= 0.5 ? 'text-good' : 'text-bad')}>
              {pct(myProb, 1)}
            </span>
          </div>
          <div className="relative mt-1 flex h-2.5 overflow-hidden rounded-full bg-panel-3">
            <div className="h-full bg-good transition-[width] duration-1000 ease-out" style={{ width: `${(shown ? myProb : 0.5) * 100}%` }} />
            <div className="h-full flex-1 bg-bad/70" />
            <span className="absolute left-1/2 top-0 h-full w-px bg-white/40" />
          </div>
          <div className="mt-1 text-[11px] tabular text-faint">
            大老师 {pct(myDp)} × {Math.round(CONFIG.match.wDraft * 100)}% + 实力占比 {pct(myShare)} × {Math.round(CONFIG.match.wStrength * 100)}% · 战力 {myStr.toFixed(0)} vs{' '}
            {oppStr.toFixed(0)}
          </div>
        </div>

      </div>
    </section>
  );
}

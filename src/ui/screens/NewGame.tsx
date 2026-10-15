// 新游戏向导：① 时代与设定 → ② 选择 / 新建俱乐部 → ③ 确认
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import {
  CONFIG, MAX_TI, POSITIONS, REGIONS, REGION_LABEL, estimateNewClubStart, formatGold, formatRank, gachaPriceForTi, newClubStartingFunds, seedTeamStartingFunds, tierOf,
  tiYear, type NewGameOptions, type Region, type RosterFile, type SeedPlayer, type SeedTeam, type TiInfo,
} from '../../engine';
import { availableStartTis, getAllTiInfo, loadRoster } from '../../data/index';
import {
  Badge, Button, Card, EmptyState, Hint, PosBadge, RegionBadge, TableScroll, TeamTag, TierBadge, cx,
} from '../components/common';
import { TeamEmblem } from '../components/TeamEmblem';
import { DIFFICULTY_LABEL, MiniTitle, Spinner, prettySlug, safe, type Difficulty } from '../components/ShellKit';

// ---------------------------------------------------------------------------
// 常量 & 工具
// ---------------------------------------------------------------------------
const rosterCache = new Map<number, RosterFile>();

const STEPS = ['时代与设定', '选择俱乐部', '确认开局'] as const;

const SWATCHES = ['#c23c2a', '#e5b24d', '#3d8bfd', '#4cc38a', '#a970ff', '#ff9f1a', '#ff4d6d', '#22c3c3', '#e7eaf1', '#8a5a2b', '#5b6bff', '#2f2f3a'];

/** 难度倍数作用于事件：负面事件概率 × d，正面事件概率 ÷ d（见 engine/events.ts） */
function eventLine(d: Difficulty): string {
  const m = CONFIG.events.difficultyMult[d] ?? 1;
  if (m < 1) return `负面事件概率 ×${m}，正面事件更常见`;
  if (m > 1) return `负面事件概率 ×${m}，正面事件更少`;
  return '随机事件概率标准';
}

const DIFF_TONE: Record<Difficulty, string> = { easy: 'text-good', normal: 'text-info', hard: 'text-bad' };

/** 难度说明（启动资金按所选起始届从引擎读取：economy.newClubStartingFunds，与开局同一函数） */
function diffLines(d: Difficulty, startTi: number | null): string[] {
  return [
    `真实俱乐部资金 ×${CONFIG.team.realClubFundsMult[d] ?? 1}`,
    `新俱乐部启动资金 ${formatGold(newClubStartingFunds(startTi || 1, d))}，初始 ${CONFIG.season.newClubSTierCount[d] ?? 1} 名 S 级 + ${CONFIG.season.newClubATierCount[d] ?? 3} 名 A 级选手`,
    eventLine(d),
  ];
}

function tiResultText(r?: string): { text: string; cls: string } {
  if (!r) return { text: '未进 TI', cls: 'text-faint' };
  const s = r.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return { text: n === 1 ? 'TI 冠军' : `TI ${formatRank(n, n)}`, cls: n === 1 ? 'text-gold font-semibold' : n <= 4 ? 'text-ink' : 'text-mute' };
  }
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
  if (m) return { text: `TI ${formatRank(Number(m[1]), Number(m[2]))}`, cls: Number(m[1]) <= 4 ? 'text-ink' : 'text-mute' };
  if (/dnq/i.test(s)) return { text: '未进 TI', cls: 'text-faint' };
  return { text: s, cls: 'text-mute' };
}

/** 首发 5 人（每位置取第一名），其余为替补 */
function splitRoster(team: SeedTeam): { starters: SeedPlayer[]; subs: SeedPlayer[] } {
  const players = team.players ?? [];
  const used = new Set<SeedPlayer>();
  const starters: SeedPlayer[] = [];
  for (const pos of POSITIONS) {
    const p = players.find((x) => x.position === pos && !used.has(x));
    if (p) {
      used.add(p);
      starters.push(p);
    }
  }
  for (const p of players) {
    if (starters.length >= 5) break;
    if (!used.has(p)) {
      used.add(p);
      starters.push(p);
    }
  }
  return { starters, subs: players.filter((p) => !used.has(p)) };
}

function avgPower(team: SeedTeam): number {
  const { starters } = splitRoster(team);
  if (!starters.length) return 0;
  return starters.reduce((s, p) => s + (p.power || 0), 0) / starters.length;
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------
function StepIndicator({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-1.5 sm:gap-2">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < step;
        const active = n === step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cx(
                'grid h-7 w-7 place-items-center rounded-full border text-xs font-bold transition-colors',
                active ? 'border-dota-2 bg-dota text-white shadow-md shadow-dota/40' : done ? 'border-gold/60 bg-gold/15 text-gold' : 'border-line bg-panel-2 text-faint',
              )}
            >
              {done ? '✓' : n}
            </span>
            <span className={cx('hidden text-sm sm:inline', active ? 'font-semibold text-ink' : done ? 'text-mute' : 'text-faint')}>{label}</span>
            {n < STEPS.length && <span className={cx('h-px w-4 sm:mx-1 sm:w-6 md:w-12', done ? 'bg-gold/50' : 'bg-line')} />}
          </li>
        );
      })}
    </ol>
  );
}

function TiCard({ info, available, selected, onSelect }: { info: TiInfo; available: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={available ? onSelect : undefined}
      disabled={!available}
      title={available ? `${info.name}（${info.city}）` : '暂无该届阵容数据，无法作为起点'}
      className={cx(
        'group relative flex flex-col overflow-hidden rounded-lg border p-3 text-left transition-all',
        'disabled:cursor-not-allowed disabled:opacity-35',
        selected
          ? 'border-gold bg-gradient-to-br from-gold/15 via-panel-2 to-panel-2 shadow-lg shadow-gold/10'
          : 'cursor-pointer border-line bg-panel-2/60 enabled:hover:border-gold/40 enabled:hover:bg-panel-2',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={cx('text-xl font-black italic tracking-tight', selected ? 'text-gold' : 'text-ink')}>TI{info.ti}</span>
        <span className="text-xs tabular text-mute">{info.year}</span>
      </div>
      <div className="mt-0.5 truncate text-xs text-mute">
        {info.city}
        {info.country && info.country !== info.city ? ` · ${info.country}` : ''}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-faint">
          冠军 <span className="text-ink">{info.champion ? prettySlug(info.champion) : info.projected ? '待揭晓' : '—'}</span>
        </span>
      </div>
      <div className="text-[11px] text-faint">
        奖金池 <span className="tabular text-gold">{formatGold(info.prizePool)}</span> 美元
      </div>
      {selected && <span className="absolute right-0 top-0 h-0 w-0 border-l-[18px] border-t-[18px] border-l-transparent border-t-gold" />}
    </button>
  );
}

function SeedTeamCard({
  team,
  startTi,
  difficulty,
  rank,
  selected,
  onSelect,
}: {
  team: SeedTeam;
  /** 起始届（资金按该届年代计算：economy.seedTeamStartingFunds，与开局同一函数） */
  startTi: number;
  difficulty: Difficulty;
  rank: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { starters, subs } = splitRoster(team);
  const avg = avgPower(team);
  const res = tiResultText(team.atTI ? team.tiResult : undefined);
  const color = team.color || '#8b96ab';
  return (
    <button
      onClick={onSelect}
      className={cx(
        'relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-panel/90 text-left transition-all',
        selected ? 'border-gold shadow-lg shadow-gold/15 ring-1 ring-gold/50' : 'border-line hover:border-gold/40 hover:bg-panel-2/70',
      )}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: color }} />
      <div className="flex items-start justify-between gap-2 border-b border-line/70 px-4 py-2.5 pl-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TeamTag color={color} tag={team.tag} teamId={team.id} />
            <RegionBadge region={team.region} />
            {team.atTI ? <Badge className="bg-gold/15 text-gold">TI 参赛</Badge> : <Badge>非 TI 队</Badge>}
            {selected && <Badge className="bg-gold font-bold text-black">✓ 已选</Badge>}
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold">{team.name}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] text-faint">实力排名</div>
          <div className="text-sm font-bold tabular">#{rank}</div>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 px-4 py-2 pl-5 text-xs">
        <div>
          <div className="text-faint">荣誉</div>
          <div className="font-semibold tabular">{Math.round(team.honor)}</div>
        </div>
        <div>
          <div className="text-faint">资金</div>
          <div className="font-semibold tabular text-gold">{formatGold(seedTeamStartingFunds(team, startTi, difficulty))}</div>
        </div>
        <div>
          <div className="text-faint">平均战力</div>
          <div className="font-semibold tabular">{avg.toFixed(1)}</div>
        </div>
        <div>
          <div className="text-faint">真实战绩</div>
          <div className={cx('truncate font-semibold', res.cls)}>{res.text}</div>
        </div>
      </div>
      <div className="space-y-1 px-4 pb-3 pl-5">
        {starters.length === 0 && <div className="py-2 text-xs text-faint">暂无选手数据</div>}
        {starters.map((p) => (
          <div key={p.id} className="flex items-center gap-2 text-xs">
            <PosBadge pos={p.position} />
            <span className="min-w-0 flex-1 truncate font-medium">{p.handle}</span>
            <TierBadge tier={tierOf(p.mmr)} />
            <span className="w-9 text-right tabular text-mute">{Math.round(p.power)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between pt-1 text-[11px] text-faint">
          <span>{subs.length ? `替补 ${subs.length} 人` : '无替补'}</span>
          <span className="truncate">{team.coach ? `教练 ${team.coach.name}` : '无教练'}</span>
        </div>
      </div>
    </button>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-mute">{label}</div>
      {children}
      {error ? <div className="mt-1 text-[11px] text-bad">{error}</div> : hint ? <div className="mt-1 text-[11px] text-faint">{hint}</div> : null}
    </label>
  );
}

/** 输入框基础样式（不含宽度，避免 w-full 与自定义宽度冲突） */
const inputBase =
  'rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-gold/60 focus:bg-panel-3';
const inputCls = cx('w-full', inputBase);

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------
export default function NewGame() {
  const setScreen = useGameStore((s) => s.setScreen);
  const newGame = useGameStore((s) => s.newGame);
  const busy = useGameStore((s) => s.busy);

  const allTis = useMemo(() => safe(() => getAllTiInfo(), [] as TiInfo[]).filter((t) => t.ti >= 1 && t.ti <= MAX_TI - 1), []);
  const startTis = useMemo(() => safe(() => availableStartTis(), [] as number[]).filter((t) => t >= 1 && t <= MAX_TI - 1), []);

  const [step, setStep] = useState(1);
  // 换步骤时回到顶部（否则第 2 步会停在上一步的滚动位置，打开时就在战队列表中间）
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [step]);
  // 默认起止：TI1 → TI16
  const [startTi, setStartTi] = useState<number | null>(() => (startTis.includes(1) ? 1 : startTis.length ? startTis[0] : null));
  const [endPick, setEndPick] = useState<number>(MAX_TI);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [managerName, setManagerName] = useState('新人经理');

  const [roster, setRoster] = useState<RosterFile | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [mode, setMode] = useState<'real' | 'new'>('real');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState<Region | 'ALL'>('ALL');
  const [tiOnly, setTiOnly] = useState(false);

  const [clubName, setClubName] = useState('');
  const [clubTag, setClubTag] = useState('');
  const [clubRegion, setClubRegion] = useState<Region>('CN');
  const [clubColor, setClubColor] = useState(SWATCHES[0]);

  const progress = useGameStore((s) => s.progress);

  const endTi = startTi ? Math.max(startTi, Math.min(MAX_TI, endPick)) : null;
  const effSeasons = startTi && endTi ? endTi - startTi + 1 : 1;
  const tiInfo = startTi ? allTis.find((t) => t.ti === startTi) ?? null : null;
  const endInfo = endTi ? safe(() => getAllTiInfo().find((t) => t.ti === endTi) ?? null, null) : null;

  // 选中 TI 后后台预加载阵容
  useEffect(() => {
    if (!startTi) return;
    const cached = rosterCache.get(startTi);
    if (cached) {
      setRoster(cached);
      setRosterError(null);
      setRosterLoading(false);
      return;
    }
    let cancelled = false;
    setRoster(null);
    setRosterLoading(true);
    setRosterError(null);
    loadRoster(startTi)
      .then((r) => {
        if (cancelled) return;
        rosterCache.set(startTi, r);
        setRoster(r);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRosterError((err as Error)?.message || '阵容数据加载失败');
      })
      .finally(() => {
        if (!cancelled) setRosterLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [startTi, reloadKey]);

  // 换届后清空已选战队
  useEffect(() => {
    setTeamId(null);
  }, [startTi]);

  const teams = useMemo(() => (roster?.teams ?? []).filter((t) => t && t.id), [roster]);
  const powerRank = useMemo(() => {
    const ids = teams.slice().sort((a, b) => avgPower(b) - avgPower(a)).map((t) => t.id);
    return new Map(ids.map((id, i) => [id, i + 1]));
  }, [teams]);
  const regionCounts = useMemo(() => {
    const m = new Map<Region, number>();
    for (const t of teams) m.set(t.region, (m.get(t.region) ?? 0) + 1);
    return m;
  }, [teams]);

  const filteredTeams = useMemo(() => {
    const q = search.trim().toLowerCase();
    return teams
      .filter((t) => (regionFilter === 'ALL' ? true : t.region === regionFilter))
      .filter((t) => (tiOnly ? t.atTI : true))
      .filter((t) => {
        if (!q) return true;
        if (t.name.toLowerCase().includes(q) || t.tag.toLowerCase().includes(q) || t.id.includes(q)) return true;
        return (t.players ?? []).some((p) => p.handle.toLowerCase().includes(q) || p.id.includes(q));
      })
      .sort((a, b) => Number(b.atTI) - Number(a.atTI) || avgPower(b) - avgPower(a));
  }, [teams, search, regionFilter, tiOnly]);

  const selectedTeam = teamId ? teams.find((t) => t.id === teamId) ?? null : null;

  // ---------------- 校验 ----------------
  const nameTrim = managerName.trim();
  const step1Error = !startTis.length
    ? '暂无可用的阵容数据，无法开始新游戏'
    : !startTi || !startTis.includes(startTi)
      ? '请选择一届有阵容数据的 TI 作为起点'
      : !nameTrim
        ? '请填写经理名称'
        : nameTrim.length > 16
          ? '经理名称最多 16 个字'
          : null;

  const clubNameTrim = clubName.trim();
  const tagConflict = clubTag ? teams.find((t) => t.tag.toUpperCase() === clubTag.toUpperCase()) : undefined;
  const nameConflict = clubNameTrim ? teams.find((t) => t.name.toLowerCase() === clubNameTrim.toLowerCase()) : undefined;
  const clubNameError = !clubNameTrim ? '请填写俱乐部名称' : clubNameTrim.length > 24 ? '名称最多 24 个字' : nameConflict ? `与现有战队「${nameConflict.name}」重名` : null;
  const clubTagError = clubTag.length < 2 ? '简称需 2–5 个字母或数字' : tagConflict ? `与现有战队「${tagConflict.name}」的简称重复` : null;

  const step2Error =
    mode === 'real'
      ? rosterLoading
        ? '阵容数据加载中…'
        : rosterError
          ? '阵容数据加载失败，请重试或选择其他 TI'
          : !selectedTeam
            ? '请选择一支要接管的战队'
            : null
      : clubNameError ?? clubTagError;

  const canNext = step === 1 ? !step1Error : step === 2 ? !step2Error : !busy;

  const start = async () => {
    if (!startTi || busy) return;
    const opts: NewGameOptions = {
      startTi,
      seasons: effSeasons,
      difficulty,
      managerName: nameTrim,
      ...(mode === 'real' && selectedTeam
        ? { teamId: selectedTeam.id }
        : { newClub: { name: clubNameTrim, tag: clubTag.toUpperCase(), region: clubRegion, color: clubColor } }),
    };
    await newGame(opts);
  };

  const onNext = () => {
    if (!canNext) return;
    if (step < 3) setStep(step + 1);
    else void start();
  };
  const onBack = () => {
    if (busy) return;
    if (step === 1) setScreen('menu');
    else setStep(step - 1);
  };

  // ---------------------------------------------------------------------------
  // 渲染各步骤
  // ---------------------------------------------------------------------------
  const renderStep1 = () => (
    // 单列也写 minmax(0,1fr)：隐式 auto 列会按截断文字 / 表格的最小内容宽度撑出屏幕（docs/UI.md「手机适配」）
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card
        title="选择起始 TI"
        subtitle="你的生涯从该届 TI 的赛季开始，各战队使用该届 TI 参赛时的真实阵容"
        actions={startTis.length ? <span className="text-xs text-mute">可选 {startTis.length} 届</span> : undefined}
      >
        {!startTis.length && (
          <div className="mb-4 rounded-lg border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-[#ffb4b4]">
            未找到任何一届的阵容数据，暂时无法开始新游戏。可以返回主菜单导入存档继续游戏。
          </div>
        )}
        {allTis.length === 0 ? (
          <EmptyState text="暂无 TI 数据" />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
            {allTis.map((info) => (
              <TiCard
                key={info.ti}
                info={info}
                available={startTis.includes(info.ti)}
                selected={startTi === info.ti}
                onSelect={() => setStartTi(info.ti)}
              />
            ))}
          </div>
        )}
        {tiInfo && (
          <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-line bg-panel-2/50 p-3 text-xs sm:grid-cols-4">
            <div>
              <div className="text-faint">赛事</div>
              <div className="font-semibold text-ink">{tiInfo.name}</div>
            </div>
            <div>
              <div className="text-faint">举办地 · 日期</div>
              <div className="text-ink">
                {tiInfo.city} · {tiInfo.startDate}
              </div>
            </div>
            <div>
              <div className="text-faint">参赛规模</div>
              <div className="text-ink">
                {tiInfo.teams} 队 · 直邀 {tiInfo.directInvites}
              </div>
            </div>
            <div>
              <div className="text-faint">冠军 / 亚军</div>
              <div className="truncate text-ink">
                <span className="text-gold">{prettySlug(tiInfo.champion)}</span> / {prettySlug(tiInfo.runnerUp)}
              </div>
            </div>
          </div>
        )}
      </Card>

      <div className="space-y-4">
        <Card title="终点 TI" subtitle={startTi ? `起点 TI${startTi} · 共 ${effSeasons} 个赛季，终点 TI 结算后生涯结束` : '请先选择起点 TI'}>
          {startTi ? (
            <div className="grid grid-cols-4 gap-1.5">
              {Array.from({ length: MAX_TI - startTi + 1 }, (_, i) => startTi + i).map((ti) => {
                const sel = ti === endTi;
                return (
                  <button
                    key={ti}
                    onClick={() => setEndPick(ti)}
                    className={cx(
                      'cursor-pointer rounded-md border px-2 py-1.5 text-left transition-colors max-sm:px-1.5',
                      sel ? 'border-gold bg-gold/15' : 'border-line bg-panel-2/50 hover:border-gold/40',
                    )}
                  >
                    <div className={cx('text-sm font-black', sel ? 'text-gold' : 'text-ink')}>TI{ti}</div>
                    {/* 360px 宽时四列格子只剩约 60px：年份与「推演」不折行 */}
                    <div className="whitespace-nowrap text-[10px] text-faint">{tiYear(ti)}{ti === MAX_TI ? ' · 推演' : ''}</div>
                  </button>
                );
              })}
            </div>
          ) : (
            <Hint>请先在左侧选择起点 TI。</Hint>
          )}
        </Card>

        <Card title="难度">
          <div className="space-y-2">
            {(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => (
              <button
                key={d}
                onClick={() => setDifficulty(d)}
                className={cx(
                  'w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors',
                  difficulty === d ? 'border-gold/70 bg-gold/10' : 'border-line bg-panel-2/50 hover:border-gold/30',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cx('h-3 w-3 rounded-full border-2', difficulty === d ? 'border-gold bg-gold' : 'border-faint')} />
                  <span className={cx('text-sm font-semibold', DIFF_TONE[d])}>{DIFFICULTY_LABEL[d]}</span>
                </div>
                <ul className="mt-1 space-y-0.5 pl-5 text-[11px] text-mute">
                  {diffLines(d, startTi).map((l) => (
                    <li key={l}>· {l}</li>
                  ))}
                </ul>
              </button>
            ))}
          </div>
        </Card>

        <Card title="经理">
          <Field label="经理名称" hint="将显示在顶栏与新闻中" error={!nameTrim ? '请填写经理名称' : nameTrim.length > 16 ? '最多 16 个字' : null}>
            <input className={inputCls} value={managerName} maxLength={20} onChange={(e) => setManagerName(e.target.value)} placeholder="例如：老陈" />
          </Field>
        </Card>
      </div>
    </div>
  );

  const renderRealClubs = () => {
    if (rosterLoading) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-sm text-mute">
          <Spinner className="h-6 w-6 text-gold" />
          正在加载 TI{startTi} 阵容数据…
        </div>
      );
    }
    if (rosterError) {
      return (
        <EmptyState text={`阵容数据加载失败：${rosterError}`}>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              重试
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStep(1)}>
              换一届 TI
            </Button>
          </div>
        </EmptyState>
      );
    }
    if (!teams.length) {
      return (
        <EmptyState text="该届暂无可接管的战队数据。">
          <Button size="sm" onClick={() => setMode('new')}>
            改为新建俱乐部
          </Button>
        </EmptyState>
      );
    }
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input className={cx(inputBase, 'w-full sm:w-64 sm:max-w-full')} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索战队 / 简称 / 选手 ID" />
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setRegionFilter('ALL')}
              className={cx('cursor-pointer rounded-md border px-2.5 py-1 text-xs pointer-coarse:min-h-9', regionFilter === 'ALL' ? 'border-gold/60 bg-gold/15 text-gold' : 'border-line text-mute hover:text-ink')}
            >
              全部 {teams.length}
            </button>
            {REGIONS.filter((r) => regionCounts.get(r)).map((r) => (
              <button
                key={r}
                onClick={() => setRegionFilter(r)}
                title={REGION_LABEL[r]}
                className={cx('cursor-pointer rounded-md border px-2.5 py-1 text-xs pointer-coarse:min-h-9', regionFilter === r ? 'border-gold/60 bg-gold/15 text-gold' : 'border-line text-mute hover:text-ink')}
              >
                {REGION_LABEL[r]} {regionCounts.get(r)}
              </button>
            ))}
          </div>
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-mute pointer-coarse:min-h-9">
            <input type="checkbox" checked={tiOnly} onChange={(e) => setTiOnly(e.target.checked)} className="accent-[#e5b24d]" />
            仅 TI 参赛队
          </label>
        </div>
        {filteredTeams.length === 0 ? (
          <EmptyState text="没有符合条件的战队，试试清空搜索或切换赛区。" />
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {filteredTeams.map((t) => (
              <SeedTeamCard
                key={t.id}
                team={t}
                startTi={startTi || 1}
                difficulty={difficulty}
                rank={powerRank.get(t.id) ?? 0}
                selected={teamId === t.id}
                onSelect={() => setTeamId(t.id)}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  // 与引擎 game.createNewClub 同一函数的开局资金（economy.estimateNewClubStart → newClubStartingFunds；预览 = 实际）
  const newClubStart = estimateNewClubStart(startTi || 1, difficulty);
  const newClubFunds = newClubStart.funds;
  const aCount = CONFIG.season.newClubATierCount[difficulty] ?? 3;
  const sCount = CONFIG.season.newClubSTierCount[difficulty] ?? 1;

  const renderNewClub = () => (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <Field label="俱乐部名称" error={clubName ? clubNameError : null} hint="最多 24 个字">
          <input className={inputCls} value={clubName} maxLength={30} onChange={(e) => setClubName(e.target.value)} placeholder="例如：Phoenix Gaming" />
        </Field>
        <Field label="简称（TAG）" error={clubTag ? clubTagError : null} hint="2–5 个大写字母或数字，用于赛程与比分">
          <input
            className={cx(inputBase, 'w-40 font-semibold uppercase tracking-widest')}
            value={clubTag}
            maxLength={5}
            onChange={(e) => setClubTag(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
            placeholder="PHX"
          />
        </Field>
        <div>
          <div className="mb-1 text-xs font-medium text-mute">所属赛区</div>
          <div className="flex flex-wrap gap-1.5">
            {REGIONS.map((r) => (
              <button
                key={r}
                onClick={() => setClubRegion(r)}
                className={cx(
                  'cursor-pointer rounded-md border px-3 py-1.5 text-xs transition-colors pointer-coarse:min-h-9',
                  clubRegion === r ? 'border-gold/60 bg-gold/15 text-gold' : 'border-line bg-panel-2/50 text-mute hover:text-ink',
                )}
              >
                <span className="font-semibold">{r}</span> <span className="opacity-80">{REGION_LABEL[r]}</span>
              </button>
            ))}
          </div>
          <Hint className="mt-1">赛区决定你能参加的地区联赛与 TI 预选赛区。</Hint>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-mute">主色</div>
          <div className="flex flex-wrap items-center gap-2">
            {SWATCHES.map((c) => (
              <button
                key={c}
                onClick={() => setClubColor(c)}
                title={c}
                className={cx('h-7 w-7 cursor-pointer rounded-md border-2 transition-transform hover:scale-110 pointer-coarse:h-9 pointer-coarse:w-9', clubColor === c ? 'border-white' : 'border-transparent')}
                style={{ background: c }}
              />
            ))}
            <label className="flex cursor-pointer items-center gap-1 text-xs text-mute" title="自定义颜色">
              <input type="color" value={clubColor} onChange={(e) => setClubColor(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent pointer-coarse:h-9 pointer-coarse:w-11" />
              自定义
            </label>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="overflow-hidden rounded-xl border border-line bg-panel-2/60">
          <div className="h-16" style={{ background: `linear-gradient(120deg, ${clubColor}, transparent 85%)` }} />
          <div className="-mt-7 px-4 pb-4">
            <div className="grid h-14 w-14 place-items-center rounded-xl border-2 border-panel text-lg font-black tracking-wide text-white shadow-lg" style={{ background: clubColor }}>
              <span className="drop-shadow">{(clubTag || '??').slice(0, 3)}</span>
            </div>
            <div className="mt-2 text-base font-bold">{clubNameTrim || '未命名俱乐部'}</div>
            <div className="text-xs text-mute">
              {clubTag || 'TAG'} · {REGION_LABEL[clubRegion]}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-md border border-line bg-panel px-2.5 py-1.5">
                <div className="text-[10px] text-faint">初始荣誉</div>
                <div className="font-semibold tabular">{CONFIG.team.newClubHonor}</div>
              </div>
              <div className="rounded-md border border-line bg-panel px-2.5 py-1.5">
                <div className="text-[10px] text-faint">启动资金</div>
                <div className="font-semibold tabular text-gold">{formatGold(newClubFunds)}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-lg border border-line bg-panel-2/40 p-3 text-xs leading-relaxed text-mute">
          <MiniTitle>开局配置</MiniTitle>
          <div>· 5 名程序化选手：{sCount > 0 ? `${sCount} 名 S 级、` : ''}{aCount} 名 A 级，其余 B 级</div>
          <div>· 启动资金 {formatGold(newClubFunds)}（约为初始阵容 {newClubStart.wagePerRound > 0 ? Math.round(newClubFunds / newClubStart.wagePerRound) : '—'} 回合的工资），每回合另有赞助、直播与周边收入</div>
          <div>· 赛事奖金默认 {Math.round(CONFIG.prizeShare.initial * 100)}% 分给队员、其余归俱乐部（可在「俱乐部 › 财务」调整）；队员分到的奖金计入其收入，奖金越多越不容易对薪资不满</div>
          <div>· 每个赛季（含第一个赛季）开放新秀卡池：真实新秀、请神新秀与虚构新秀，所有战队共享、先到先得（单抽价格 {formatGold(gachaPriceForTi(startTi || 1).single)} 起，随年代变化）</div>
          <div>· 荣誉从 {CONFIG.team.newClubHonor} 起步，前期多数赛事需要打预选</div>
          <div className="mt-1 text-faint">白手起家难度较高，但每一座奖杯都是你亲手打造的。</div>
        </div>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <Card
      title={
        <span>
          选择俱乐部 <span className="ml-1 text-xs font-normal text-mute">TI{startTi} · {startTi ? tiYear(startTi) : ''} 赛季</span>
        </span>
      }
      actions={
        <div className="flex rounded-lg border border-line bg-panel-2 p-0.5">
          {(['real', 'new'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cx('cursor-pointer whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-colors pointer-coarse:min-h-9', mode === m ? 'bg-dota text-white' : 'text-mute hover:text-ink')}
            >
              {m === 'real' ? '接管真实战队' : '新建俱乐部'}
            </button>
          ))}
        </div>
      }
    >
      {mode === 'real' ? renderRealClubs() : renderNewClub()}
    </Card>
  );

  const renderConfirmClub = () => {
    if (mode === 'real' && selectedTeam) {
      const { starters, subs } = splitRoster(selectedTeam);
      const res = tiResultText(selectedTeam.atTI ? selectedTeam.tiResult : undefined);
      return (
        <div>
          <div className="flex items-center gap-3">
            <TeamEmblem tag={selectedTeam.tag} color={selectedTeam.color || '#8b96ab'} teamId={selectedTeam.id} size={48} className="drop-shadow" />
            <div>
              <div className="text-lg font-bold">{selectedTeam.name}</div>
              <div className="flex items-center gap-2 text-xs text-mute">
                <RegionBadge region={selectedTeam.region} /> {REGION_LABEL[selectedTeam.region]} · 真实战绩 <span className={res.cls}>{res.text}</span>
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="rounded-md border border-line bg-panel-2/60 px-3 py-2">
              <div className="text-[10px] text-faint">荣誉</div>
              <div className="font-semibold tabular">{Math.round(selectedTeam.honor)}</div>
            </div>
            <div className="rounded-md border border-line bg-panel-2/60 px-3 py-2">
              <div className="text-[10px] text-faint">资金</div>
              <div className="font-semibold tabular text-gold">{formatGold(seedTeamStartingFunds(selectedTeam, startTi || 1, difficulty))}</div>
            </div>
            <div className="rounded-md border border-line bg-panel-2/60 px-3 py-2">
              <div className="text-[10px] text-faint">平均战力</div>
              <div className="font-semibold tabular">{avgPower(selectedTeam).toFixed(1)}</div>
            </div>
          </div>
          <TableScroll className="mt-3">
          <table className="tbl">
            <thead>
              <tr>
                <th>位置</th>
                <th>选手</th>
                <th>等级</th>
                <th className="num">战力</th>
                <th className="num">天赋</th>
                <th className="num">年龄</th>
              </tr>
            </thead>
            <tbody>
              {[...starters, ...subs].map((p, i) => (
                <tr key={p.id} className={i >= starters.length ? 'opacity-60' : undefined}>
                  <td>
                    <PosBadge pos={p.position} />
                  </td>
                  <td className="font-medium">
                    {p.handle}
                    {i >= starters.length && <span className="ml-1 text-[10px] text-faint">替补</span>}
                  </td>
                  <td>
                    <TierBadge tier={tierOf(p.mmr)} />
                  </td>
                  <td className="num">{Math.round(p.power)}</td>
                  <td className="num">{Math.round(p.talent)}</td>
                  <td className="num">{startTi ? tiYear(startTi) - p.birthYear : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </TableScroll>
          {selectedTeam.coach && <div className="mt-2 text-xs text-mute">教练：{selectedTeam.coach.name}（{selectedTeam.coach.tier} 级）</div>}
        </div>
      );
    }
    return (
      <div>
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-lg text-sm font-black text-white shadow" style={{ background: clubColor }}>
            {clubTag.slice(0, 4)}
          </div>
          <div>
            <div className="text-lg font-bold">{clubNameTrim}</div>
            <div className="text-xs text-mute">
              新建俱乐部 · {clubTag} · {REGION_LABEL[clubRegion]}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-md border border-line bg-panel-2/60 px-3 py-2">
            <div className="text-[10px] text-faint">初始荣誉</div>
            <div className="font-semibold tabular">{CONFIG.team.newClubHonor}</div>
          </div>
          <div className="rounded-md border border-line bg-panel-2/60 px-3 py-2">
            <div className="text-[10px] text-faint">启动资金</div>
            <div className="font-semibold tabular text-gold">{formatGold(newClubFunds)}</div>
          </div>
        </div>
        <Hint className="mt-3">
          开局将获得 5 名程序化选手（{sCount > 0 ? `${sCount} 名 S 级、` : ''}{aCount} 名 A 级，其余 B 级）
          ；第一个赛季初同样开放新秀卡池，新俱乐部可以抽卡补充新秀。
        </Hint>
      </div>
    );
  };

  const renderStep3 = () => (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
      <Card title="生涯设定">
        <div className="divide-y divide-line/60 text-sm">
          {[
            ['经理', nameTrim],
            ['起始', tiInfo ? `TI${tiInfo.ti} · ${tiInfo.year} · ${tiInfo.city}` : `TI${startTi}`],
            ['终点', endTi ? `TI${endTi} · ${tiYear(endTi)}${endInfo?.projected ? '（推演）' : ''}` : '—'],
            ['赛季数', `${effSeasons} 个赛季`],
            ['难度', DIFFICULTY_LABEL[difficulty]],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-2">
              <span className="text-mute">{k}</span>
              <span className="text-right font-medium">{v}</span>
            </div>
          ))}
        </div>
        <ul className="mt-3 space-y-0.5 text-[11px] text-mute">
          {diffLines(difficulty, startTi).map((l) => (
            <li key={l}>· {l}</li>
          ))}
        </ul>
        <div className="mt-4 rounded-lg border border-gold/40 bg-gradient-to-br from-gold/15 to-transparent p-3">
          <div className="text-xs font-semibold text-gold">生涯目标</div>
          <div className="mt-1 text-sm">在 TI{endTi} 结束前，至少夺得一次 TI 冠军。</div>
          <div className="mt-1 text-[11px] text-mute">荣誉跌破 0 将导致战队解散、游戏提前结束。</div>
        </div>
        {progress && !progress.gameOver && (
          <div className="mt-3 rounded-lg border border-bad/40 bg-bad/10 p-3 text-xs leading-relaxed text-[#ffb4b4]">
            当前会话已有进度（{progress.teamName} · TI{progress.ti}）。开始新生涯后，这份进度会被<b>覆盖</b>。
          </div>
        )}
        <Hint className="mt-3">游戏进度会自动保存在本浏览器的匿名会话中，下次打开可在主菜单「继续游戏」。</Hint>
      </Card>
      <Card title="你的俱乐部">{renderConfirmClub()}</Card>
    </div>
  );

  const nextLabel = step === 3 ? (busy ? '正在生成世界…' : '开始生涯 ▶') : '下一步 ▶';
  const nextTitle = step === 1 ? step1Error : step === 2 ? step2Error : busy ? '正在创建游戏' : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* 手机（< sm）：标志、步骤、关闭按钮排成一行（副标题与「返回主菜单」文字隐藏，关闭按钮只留 ✕） */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-panel/90 px-3 py-2 backdrop-blur sm:gap-3 sm:px-6 sm:py-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-dota text-xs font-black italic text-white sm:h-9 sm:w-9 sm:text-sm">D2</div>
          <div className="leading-tight">
            <div className="text-sm font-bold">新游戏</div>
            <div className="hidden text-[11px] text-faint sm:block">刀塔经理 · 生涯创建</div>
          </div>
        </div>
        <StepIndicator step={step} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setScreen('menu')}
          disabled={busy}
          title={busy ? '正在创建游戏' : '返回主菜单'}
          aria-label="返回主菜单"
          className="max-sm:min-w-9"
        >
          {/* 两套文字而不是「✕ + 隐藏的文字」：按钮是 inline-flex，拆开的文字之间会多出 gap，桌面宽度会变 */}
          <span className="sm:hidden">✕</span>
          <span className="hidden sm:inline">✕ 返回主菜单</span>
        </Button>
      </header>

      <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 sm:py-5">
        <div className="mx-auto max-w-[1400px]">
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
        </div>
      </main>

      {/* 底部吸附操作栏：占满一整行，主按钮居中加宽（与游戏内底栏一致）。
          手机（< sm）：上方一行小字写当前步骤与未完成项（右侧提示列不显示），下方「返回」+ 通栏主按钮；
          右侧让出右下角浮动的背景音乐按钮（App 的 MusicControl floating="bottom"），底部让出 Home 横条 */}
      <footer className="shrink-0 border-t border-line bg-panel/95 pb-safe shadow-[0_-8px_24px_rgba(0,0,0,0.35)] backdrop-blur">
        <div className="flex items-center gap-2 truncate px-3 pt-2 text-[11px] text-mute sm:hidden">
          <span className="shrink-0 text-faint">
            第 {step}/{STEPS.length} 步 · {STEPS[step - 1]}
          </span>
          {nextTitle && step < 3 ? (
            <span className="min-w-0 truncate">{nextTitle}</span>
          ) : step === 2 && mode === 'real' && selectedTeam ? (
            <span className="min-w-0 truncate">
              已选：<span className="font-semibold text-ink">{selectedTeam.name}</span>
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 py-2 pl-3 pr-[calc(5rem+env(safe-area-inset-right,0px))] sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-4 sm:px-6 sm:py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="secondary" onClick={onBack} disabled={busy} title={busy ? '正在创建游戏' : undefined} className="shrink-0 whitespace-nowrap max-sm:h-12">
              ‹ {step === 1 ? '主菜单' : '上一步'}
            </Button>
            <span className="hidden truncate text-xs text-faint lg:inline">
              第 {step}/{STEPS.length} 步 · {STEPS[step - 1]}
            </span>
          </div>

          <Button
            variant={step === 3 ? 'gold' : 'primary'}
            size="lg"
            onClick={onNext}
            disabled={!canNext}
            title={nextTitle ?? undefined}
            className={cx('h-12 w-full min-w-0 whitespace-nowrap text-base font-bold tracking-wider sm:w-auto sm:min-w-[min(360px,50vw)]', step === 3 && canNext && 'glow')}
          >
            {busy && <Spinner />}
            {nextLabel}
          </Button>

          <div className="hidden min-w-0 text-right text-xs sm:block">
            {nextTitle && step < 3 ? (
              <span className="line-clamp-2 text-mute">{nextTitle}</span>
            ) : step === 2 && mode === 'real' && selectedTeam ? (
              <span className="text-mute">
                已选：<span className="font-semibold text-ink">{selectedTeam.name}</span>
              </span>
            ) : null}
          </div>
        </div>
      </footer>
    </div>
  );
}

// 新闻编辑部：让玩家看清「世界在发生什么」
//
// - 回合要闻（newsroomRoundStart → state.lastDigest）：每次推进回合后，从上一期以来的全部新闻中按重要度
//   挑出 3~6 条（冠军、爆冷、重磅转会、版本、丑闻、纪录、周报……），供总览的 RoundDigest 面板展示；
// - 刀塔周报（每 CONFIG.newsroom.weeklyEvery 个常规回合一期 + 赛季初特刊）：实力榜前十及升降、热门选手、
//   近期冠军、近期看点、转会动态与关注名单，合成一条新闻（tags: weekly）；
// - 社区趋势：知名战队连续多项赛事早早出局；纪录：连冠、本赛季冠军数里程碑；
// - 天梯变动：选手升至 SS/SSR、知名选手天梯回落（合并成条，控制数量）。
//
// 全部文案为平实的事实陈述。编辑部记忆存于 state.newsroom（全局世界状态，非座位私有）；
// 「玩家战队」一律按 team.isPlayer 判断（多人模式下为全部座位）。
import type { GameState, NewsDigest, NewsItem, NewsroomState, Player, Team, Tournament, TournamentHistoryEntry } from './types';
import { TIERS } from './types';
import { CONFIG, POSITION_LABEL, TOURNAMENT_TIER_LABEL } from './config';
import { addNews, humanTeamIds, newsIsMine, newsScopeOf } from './news';
import { teamRating } from './team';
import { overallRating, playerTier, tierIndex } from './player';
import { formatGold, formatRank, ownEntry, placementPercentile } from './util';
import { isFillerCup } from './schedule';
import { prizePoolLabel } from './revenue';
import { regularRoundCount } from './calendar';
import { getPlayerIndex, getTiInfo } from '../data/index';

const NR = () => CONFIG.newsroom;

function room(state: GameState): NewsroomState {
  if (!state.newsroom || typeof state.newsroom !== 'object') state.newsroom = {};
  return state.newsroom;
}

/** 新闻 id（nextId 生成的 "n-<36 进制序号>"）→ 序号；无法解析为 0 */
export function newsSerial(id: string): number {
  if (typeof id !== 'string') return 0;
  const i = id.lastIndexOf('-');
  const n = parseInt(i >= 0 ? id.slice(i + 1) : id, 36);
  return Number.isFinite(n) ? n : 0;
}

const CN_NUM = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];
/** 小数字用中文（「连续三项」「两连冠」），其余用阿拉伯数字 */
function cn(n: number): string {
  return n >= 0 && n <= 10 ? CN_NUM[n] : String(n);
}

function teamName(state: GameState, id: string | null | undefined): string {
  if (!id) return '未知';
  return state.teams[id]?.name ?? id;
}

/** 回合名：0 赛季初 / 常规第 N 回合 / TI 预选 / TI 正赛 */
export function roundName(state: GameState, idx: number): string {
  const R = state.season ? regularRoundCount(state.season) : CONFIG.calendar.regularRounds;
  if (idx <= 0) return '赛季初';
  if (idx <= R) return `第${idx}回合`;
  if (idx === R + 1) return 'TI 预选';
  return 'TI 正赛';
}

function isActiveTeam(t: Team | undefined): t is Team {
  return !!t && !t.disbanded;
}

function rosterPlayer(p: Player | undefined): p is Player {
  return !!p && p.status === 'active' && !!p.teamId && !p.isWildSub && !p.tempSubUntilTournament;
}

// ---------------------------------------------------------------------------
// 知名战队 / 实力榜
// ---------------------------------------------------------------------------

/**
 * 知名战队：荣誉前 N ∪ 战队评分前 N（includeHumans 时再加上全部玩家战队）。
 * 每次按当前状态现算（不缓存）：原来按 (赛季, 回合, 阶段, 战队数) 缓存在内存里，回合内荣誉 / 阵容变化（退赛扣分、交易等）后缓存过期，
 * 读档后重新计算得到不同的集合 → 冠军新闻条数不同 → id 序号错开 → 以 id 排序的平局判定改变走向，连续游玩与每回合读档的结果分叉
 * （2026-10-14 审查）。现算是存档内容的纯函数，读档前后一致；16 季无头模拟耗时不变（DESIGN.md 第 11 节）。
 */
export function notableTeamSet(state: GameState, includeHumans = true): Set<string> {
  const n = Math.max(1, NR().notableTeams);
  const teams = Object.values(state.teams).filter(isActiveTeam);
  const set = new Set<string>();
  const byHonor = teams.slice().sort((a, b) => (b.honor ?? 0) - (a.honor ?? 0) || a.id.localeCompare(b.id));
  for (const t of byHonor.slice(0, n)) set.add(t.id);
  const rating = new Map(teams.map((t) => [t.id, teamRating(state, t.id)]));
  const byRating = teams.slice().sort((a, b) => (rating.get(b.id) ?? 0) - (rating.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  for (const t of byRating.slice(0, n)) set.add(t.id);
  const out = set;
  for (const id of humanTeamIds(state)) {
    if (includeHumans) out.add(id);
    else out.delete(id);
  }
  return out;
}

export interface PowerRow {
  teamId: string;
  rating: number;
  score: number;
}

/** 实力榜：战队评分 × (1 + formWeight × (近况 - 0.5))，近况取本赛季最近几项赛事的名次 */
export function powerRanking(state: GameState): PowerRow[] {
  const cfg = NR();
  const ti = state.season?.ti ?? 0;
  const recent = new Map<string, number[]>();
  const hist = state.history?.tournaments ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (!h || h.season !== ti) break;
    if (h.tier === 'qualifier' || isFillerCup(h)) continue;
    for (const [id, pl] of Object.entries(h.placements ?? {})) {
      const arr = recent.get(id) ?? [];
      if (arr.length >= cfg.powerFormEvents) continue;
      arr.push(1 - placementPercentile(pl[0], pl[1], pl[2]));
      recent.set(id, arr);
    }
  }
  const rows: PowerRow[] = [];
  for (const t of Object.values(state.teams)) {
    if (!isActiveTeam(t) || (t.playerIds?.length ?? 0) === 0) continue;
    const rating = teamRating(state, t.id);
    if (!(rating > 0)) continue;
    const form = recent.get(t.id);
    const f = form?.length ? form.reduce((a, b) => a + b, 0) / form.length : 0.5;
    rows.push({ teamId: t.id, rating, score: rating * (1 + cfg.powerFormWeight * (f - 0.5)) });
  }
  rows.sort((a, b) => b.score - a.score || a.teamId.localeCompare(b.teamId));
  return rows;
}

// ---------------------------------------------------------------------------
// 重要度
// ---------------------------------------------------------------------------

const TITLE_TAGS: [RegExp, string][] = [
  [/捧起不朽盾/, 'ti-champion'],
  [/宣告解散|^【解散】|^【新军】/, 'disband'],
  [/^【传闻】/, 'rumor'],
  [/线上公开赛/, 'filler'],
  [/^【(重磅转会|甩卖|挖角)】/, 'big-transfer'],
  [/^【(假赛风波|东窗事发|丑闻)】/, 'scandal'],
  [/^【八卦】/, 'gossip'],
  [/^【(情感受挫|伤病|状态火热|签证问题|赞助|直播合约|粉丝见面会|团建)】/, 'player-event'],
  [/^【爆冷】/, 'upset'],
  [/^【纪录】/, 'record'],
  [/^【天梯】/, 'tier'],
  [/夺得.*冠军|问鼎|夺冠/, 'champion'],
  [/直邀名单|晋级 TI|无缘 TI|资格之路|直通 TI|止步预选/, 'ti-story'],
  [/开幕$|开赛$/, 'tournament-start'],
  [/赛季开始|赛季总结|名选手宣布退役/, 'season'],
];

/** 新闻的标签：显式标签 ∪ 按标题/类别推断的标签 */
export function headlineTags(n: NewsItem): string[] {
  const out = new Set<string>(n.tags ?? []);
  const title = n.title ?? '';
  for (const [re, tag] of TITLE_TAGS) if (re.test(title)) out.add(tag);
  if (n.category === 'patch') out.add('patch');
  else if (n.category === 'transfer') out.add('transfer');
  else if (n.category === 'match') out.add('result');
  else if (n.category === 'tournament' && /战罢|结束/.test(title)) out.add('result');
  return [...out];
}

function baseScore(tags: string[]): { score: number; kind: string } {
  const ts = NR().tagScore;
  let score = 0;
  let kind = 'other';
  for (const t of tags) {
    const v = ts[t] ?? 0;
    if (v > score) {
      score = v;
      kind = t;
    }
  }
  const level = tags.find((t) => t.startsWith('level:'))?.slice(6);
  const mult = level ? (NR().levelScoreMult as Record<string, number>)[level] ?? 1 : 1;
  return { score: score * mult, kind };
}

/** 不含加成的基础重要度（按标签与赛事等级） */
export function baseHeadlineScore(n: NewsItem): number {
  return n ? baseScore(headlineTags(n)).score : 0;
}

/**
 * 新闻重要度（0 = 不进入要闻；private 新闻一律 0）。
 * notable 为知名战队集合（建议 notableTeamSet(state, false)：玩家战队只拿 mineBonus，不重复加知名战队加成）。
 * 线上公开赛（filler）整体 × fillerScoreMult。
 */
export function headlineScore(state: GameState, n: NewsItem, notable?: Set<string>): number {
  if (!n || n.visibility === 'private') return 0;
  const cfg = NR();
  const tags = headlineTags(n);
  let { score } = baseScore(tags);
  if (score <= 0) return 0;
  if (n.important) score += cfg.importantBonus;
  if (newsScopeOf(state, n) === 'mine') score += cfg.mineBonus;
  if (notable && n.teamIds?.some((id) => notable.has(id))) score += cfg.notableTeamBonus;
  if (tags.includes('filler')) score *= cfg.fillerScoreMult;
  return score;
}

// ---------------------------------------------------------------------------
// 回合要闻
// ---------------------------------------------------------------------------

function digestTitle(state: GameState): string {
  const ti = state.season?.ti ?? 0;
  if (state.phase === 'preseason' || state.roundIndex <= 0) {
    const last = state.history?.seasons?.[state.history.seasons.length - 1];
    // 多人模式：要闻在中性上下文生成（赛季总结是座位私有的），按「是否已打过赛季」判断
    const prevDone = last ? last.ti === ti - 1 : !!state.multiplayer && ti > (state.settings?.startTi ?? ti);
    return prevDone ? `TI${ti - 1} 落幕 · 休赛期要闻` : `TI${ti} 赛季前瞻`;
  }
  // 推进后展示的是刚结束那一回合的要闻：明确写「上回合」，避免误以为是当前回合
  return `上回合要闻 · TI${ti} ${roundName(state, state.roundIndex - 1)}`;
}

/**
 * 生成回合要闻：取上一期之后创建的全部新闻，按重要度挑出 digestMin~digestMax 条（同类最多 digestPerKindMax 条），
 * 写入 state.lastDigest。窗口内没有新闻时保留上一期。
 */
export function buildRoundDigest(state: GameState): NewsDigest | null {
  const cfg = NR();
  const r = room(state);
  const windowItems: NewsItem[] = [];
  if (r.digestMark == null) {
    // 首次（旧存档）：只取上一回合以来的新闻，不翻旧账
    const ti = state.season?.ti ?? 0;
    for (const n of state.news ?? []) if (n.season === ti && n.round >= state.roundIndex - 1) windowItems.push(n);
  } else {
    for (const n of state.news ?? []) {
      if (newsSerial(n.id) <= r.digestMark) break;
      windowItems.push(n);
    }
  }
  r.digestMark = state.idCounter ?? 0;
  if (!windowItems.length) return state.lastDigest ?? null;

  const notable = notableTeamSet(state, false);
  const scored = windowItems
    // 玩家自己的逐场比赛结果（match）不进要闻：玩家刚打完，要闻以世界动态为主
    .filter((n) => n.category !== 'match')
    .map((n, i) => {
      const base = baseScore(headlineTags(n));
      return { n, i, s: headlineScore(state, n, notable), base: base.score, kind: base.kind, mine: newsScopeOf(state, n) === 'mine' };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const picked: typeof scored = [];
  const perKind = new Map<string, number>();
  const perTeam = new Map<string, number>();
  const perTeamMax = Math.max(1, cfg.digestPerTeamMax ?? 2);
  let mineCount = 0;
  for (const x of scored) {
    if (picked.length >= cfg.digestMax) break;
    if (x.s < cfg.digestMinScore) break;
    // 同类最多 digestPerKindMax 条；玩家自己的新闻同类只取 1 条（如「止步预选」与「无缘 TI」）
    const k = perKind.get(x.kind) ?? 0;
    const mk = x.mine ? perKind.get(`mine:${x.kind}`) ?? 0 : 0;
    if (k >= cfg.digestPerKindMax || mk >= 1 || (x.mine && mineCount >= cfg.digestMineMax)) continue;
    // 玩家自己的赛事名次（「X 战罢：冠军」）已有结算弹窗与夺冠新闻，只在补位时使用
    if (x.mine && x.kind === 'result') continue;
    // 同一主角战队最多 digestPerTeamMax 条（如「夺冠」+「连冠纪录」，不再挤进第三条同队新闻）；周报为综述，不计
    const lead = x.kind === 'weekly' ? undefined : x.n.teamIds?.[0];
    const tc = lead ? perTeam.get(lead) ?? 0 : 0;
    if (lead && tc >= perTeamMax) continue;
    if (lead) perTeam.set(lead, tc + 1);
    perKind.set(x.kind, k + 1);
    if (x.mine) {
      perKind.set(`mine:${x.kind}`, mk + 1);
      mineCount++;
    }
    picked.push(x);
  }
  // 不足下限：放宽分数线与同类限制补足（基础分过低的八卦、玩家逐场赛果等不补位）；
  // 仍不足（世界上本回合确实没什么大事）时，再用基础分 ≥ digestLastFillMinScore 的非八卦新闻（如玩家本回合赛事名次）补位
  for (const minBase of [cfg.digestFillMinScore, cfg.digestLastFillMinScore ?? cfg.digestFillMinScore]) {
    for (const x of scored) {
      if (picked.length >= cfg.digestMin) break;
      if (x.base < minBase || x.kind === 'gossip' || picked.includes(x)) continue;
      picked.push(x);
    }
  }
  picked.sort((a, b) => b.s - a.s || a.i - b.i);
  const digest: NewsDigest = {
    season: state.season?.ti ?? 0,
    round: state.roundIndex,
    date: state.currentDate,
    title: digestTitle(state),
    items: picked.map((x) => x.n.id),
  };
  state.lastDigest = digest;
  return digest;
}

/** 要闻条目（跳过已被清理的新闻） */
export function digestItems(state: GameState): NewsItem[] {
  const d = state.lastDigest;
  if (!d?.items?.length) return [];
  const byId = new Map((state.news ?? []).map((n) => [n.id, n]));
  return d.items.map((id) => byId.get(id)).filter((n): n is NewsItem => !!n);
}

/** 世界动态流：最新的公开世界新闻（默认按基础重要度滤掉八卦等低价值条目；minScore = 0 不过滤） */
export function worldHeadlines(state: GameState, limit = 12, minScore = 10, teamId?: string | null): NewsItem[] {
  const out: NewsItem[] = [];
  // 已在「回合要闻」面板展示的条目不在世界动态里重复
  const inDigest = new Set(state.lastDigest?.items ?? []);
  for (const n of state.news ?? []) {
    if (out.length >= limit) break;
    if (inDigest.has(n.id)) continue;
    // 「世界」= 不属于该座位（默认当前玩家）的公开新闻；多人模式下其他玩家的公开动态也在其中
    if (n.visibility === 'private' || newsIsMine(state, n, teamId)) continue;
    if (minScore > 0 && baseHeadlineScore(n) < minScore) continue;
    out.push(n);
  }
  return out;
}

/**
 * 新闻滚动栏：在最近 window 条新闻中优先挑选要闻、重要与世界新闻（重要度 + 新近度），按时间倒序返回 count 条。
 */
export function tickerHeadlines(state: GameState, count = 14, window = 60): NewsItem[] {
  const recent = (state.news ?? []).slice(0, window);
  const inDigest = new Set(state.lastDigest?.items ?? []);
  const scored = recent.map((n, i) => {
    let s = headlineScore(state, n) - i * 0.6;
    if (inDigest.has(n.id)) s += 25;
    if (n.important) s += 8;
    if (n.visibility === 'private') s -= 5;
    return { n, i, s };
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, count).sort((a, b) => a.i - b.i).map((x) => x.n);
}

// ---------------------------------------------------------------------------
// 赛事趋势 & 纪录（扫描新结束的赛事）
// ---------------------------------------------------------------------------

/** 该队在赛事中的出局阶段：封闭预选 / 小组赛（之后还有淘汰赛）/ 其他 */
function exitStage(t: Tournament | undefined, teamId: string): 'qualifier' | 'groups' | null {
  if (!t) return null;
  if ((t.qualifierTeamIds ?? []).includes(teamId) && !(t.teamIds ?? []).includes(teamId)) return 'qualifier';
  const gi = (t.stages ?? []).findIndex((s) => s.type === 'groups');
  if (gi >= 0 && gi < t.stages.length - 1) {
    const g = t.stages[gi];
    if ((g.teamIds ?? []).includes(teamId) && !(g.advancedTeamIds ?? []).includes(teamId)) return 'groups';
  }
  return null;
}

/** 截至 history.tournaments[upTo]（含）该队本赛季的冠军数（不含预选/线上公开赛） */
function seasonTitleCount(state: GameState, season: number, teamId: string, upTo: number): number {
  const hist = state.history?.tournaments ?? [];
  let n = 0;
  for (let i = 0; i <= upTo && i < hist.length; i++) {
    const h = hist[i];
    if (h.season === season && h.championId === teamId && h.tier !== 'qualifier' && !isFillerCup(h)) n++;
  }
  return n;
}

function processFinished(state: GameState, h: TournamentHistoryEntry, notable: Set<string>, index: number): void {
  if (!h || h.tier === 'qualifier' || isFillerCup(h)) return;
  const cfg = NR();
  const r = room(state);
  const slumps = (r.slumps ??= {});
  const streaks = (r.titleStreaks ??= {});
  const t = state.tournaments[h.tournamentId];
  const humans = new Set(humanTeamIds(state));

  for (const [teamId, pl] of Object.entries(h.placements ?? {})) {
    const team = ownEntry(state.teams, teamId);
    if (!team) continue;
    // 连冠
    if (teamId === h.championId) streaks[teamId] = (streaks[teamId] ?? 0) + 1;
    else delete streaks[teamId];

    // 连续早早出局
    const pct = placementPercentile(pl[0], pl[1], pl[2]);
    if (pct < cfg.slumpPercentile) {
      delete slumps[teamId];
      continue;
    }
    // 小型赛事（如 4 队邀请赛的 3-4 名）不算「早早出局」：不计入也不打断
    if ((pl[2] ?? 0) < cfg.slumpMinTeams) continue;
    const stage = exitStage(t, teamId);
    const s = (slumps[teamId] ??= { n: 0, groups: 0, last: [] });
    s.n += 1;
    if (stage === 'groups') s.groups += 1;
    // 赛前被看好（预期名次在前半区）却早早出局 = 低于预期（缺少赛前预期的赛事不计）
    const expRank = t?.expectedRanks?.[teamId];
    if (expRank != null && placementPercentile(expRank, expRank, pl[2]) < cfg.slumpPercentile) s.d = (s.d ?? 0) + 1;
    const where = stage === 'groups' ? '小组赛出局' : stage === 'qualifier' ? '止步预选' : formatRank(pl[0], pl[1]);
    s.last.push(`${h.name} ${where}`);
    if (s.last.length > 4) s.last.splice(0, s.last.length - 4);
    // 达到 slumpStreak 项且其中至少 slumpMinDisappointments 项低于预期时报道；之后每再 slumpRepeat 项报道一次
    const due = s.n >= cfg.slumpStreak && (s.d ?? 0) >= cfg.slumpMinDisappointments
      && (s.r == null || s.n - s.r >= Math.max(1, cfg.slumpRepeat));
    if (!due || team.disbanded || !(notable.has(teamId) || humans.has(teamId))) continue;
    s.r = s.n;
    const allGroups = s.groups >= s.n;
    const name = team.name;
    addNews(
      state,
      'tournament',
      `${name} 连续${cn(s.n)}项赛事${allGroups ? '止步小组赛' : '早早出局'}，社区对阵容调整的呼声高涨`,
      `近期战绩：${s.last.slice(-Math.min(s.n, 4)).join('；')}。${name} 当前荣誉 ${Math.round(team.honor)}。`,
      humans.has(teamId),
      { teamIds: [teamId], tags: ['trend'] },
    );
  }

  // 纪录：连冠 / 本赛季冠军数里程碑
  const champ = h.championId;
  const team = champ ? state.teams[champ] : undefined;
  if (!champ || !team) return;
  const streak = streaks[champ] ?? 0;
  const titles = seasonTitleCount(state, h.season, champ, index);
  const parts: string[] = [];
  if (streak >= cfg.titleStreakMin) parts.push(`已在连续 ${streak} 项参赛赛事中夺冠`);
  if (cfg.seasonTitleMilestones.includes(titles)) parts.push(`这是其本赛季第 ${titles} 个冠军`);
  if (!parts.length) return;
  const title = streak >= cfg.titleStreakMin
    ? `【纪录】${team.name} 豪取${cn(streak)}连冠`
    : `【纪录】${team.name} 本赛季第${cn(titles)}冠`;
  addNews(
    state,
    'tournament',
    title,
    `${team.name} 拿下 ${h.name}（${TOURNAMENT_TIER_LABEL[h.tier] ?? h.tier}），${parts.join('，')}。`,
    humans.has(champ),
    { teamIds: [champ], tags: ['record', `level:${h.tier}`] },
  );
}

/** 处理自上次扫描以来结束的赛事（history.tournaments 追加的条目） */
export function scanFinishedTournaments(state: GameState): void {
  const r = room(state);
  const hist = state.history?.tournaments ?? [];
  if (r.historyCursor == null || r.historyCursor > hist.length) {
    // 首次运行（旧存档）：不补发历史
    r.historyCursor = hist.length;
    return;
  }
  if (r.historyCursor === hist.length) return;
  const notable = notableTeamSet(state);
  for (let i = r.historyCursor; i < hist.length; i++) processFinished(state, hist[i], notable, i);
  r.historyCursor = hist.length;
}

// ---------------------------------------------------------------------------
// 天梯变动
// ---------------------------------------------------------------------------

function playerLabel(state: GameState, p: Player): string {
  const tag = p.teamId ? state.teams[p.teamId]?.name : undefined;
  return tag ? `${p.handle}（${tag}）` : p.handle;
}

/** 对比天梯等级快照：升至 SS/SSR 的选手、知名选手天梯回落，合并成条发布 */
export function scanTierChanges(state: GameState): void {
  const cfg = NR();
  const r = room(state);
  const prev = r.tiers;
  const next: Record<string, number> = {};
  const minIdx = tierIndex(cfg.tierNewsMin);
  const ssrIdx = TIERS.length - 1;
  const ups: { p: Player; from: number; to: number }[] = [];
  const downs: { p: Player; from: number; to: number }[] = [];
  const notable = prev ? notableTeamSet(state) : null;
  for (const id in state.players) {
    const p = state.players[id];
    if (!rosterPlayer(p)) continue;
    const ti = tierIndex(playerTier(p));
    next[id] = ti;
    const old = prev?.[id];
    if (old === undefined || old === ti) continue;
    if (ti > old && ti >= minIdx) ups.push({ p, from: old, to: ti });
    else if (ti < old && old >= minIdx && (p.isReal || old === ssrIdx || (p.teamId && notable?.has(p.teamId)))) {
      downs.push({ p, from: old, to: ti });
    }
  }
  r.tiers = next;
  if (!prev) return;
  const rate = (x: { p: Player }) => overallRating(x.p);
  ups.sort((a, b) => b.to - a.to || rate(b) - rate(a));
  downs.sort((a, b) => b.from - a.from || rate(b) - rate(a));
  const humans = new Set(humanTeamIds(state));
  const teamsOf = (list: { p: Player }[]) => Array.from(new Set(list.map((x) => x.p.teamId).filter((x): x is string => !!x)));
  const mineOf = (list: { p: Player }[]) => list.some((x) => !!x.p.teamId && humans.has(x.p.teamId));

  const ssr = ups.filter((x) => x.to === ssrIdx);
  for (const x of ssr.slice(0, 2)) {
    const p = x.p;
    const count = Object.values(state.players).filter((q) => rosterPlayer(q) && playerTier(q) === 'SSR').length;
    addNews(
      state,
      'season',
      `【天梯】${p.handle} 天梯升至 SSR`,
      `${playerLabel(state, p)}的天梯分突破 ${CONFIG.ladder.thresholds.SSR}，跻身 SSR 行列（${POSITION_LABEL[p.position]}）。`
        + `目前各战队在役的 SSR 选手共 ${count} 名。`,
      !!p.teamId && humans.has(p.teamId),
      { teamIds: p.teamId ? [p.teamId] : [], playerIds: [p.id], tags: ['tier'] },
    );
  }
  const rest = ups.filter((x) => x.to !== ssrIdx || ssr.indexOf(x) >= 2);
  if (rest.length) {
    const list = rest.slice(0, cfg.tierNewsListMax);
    const more = rest.length > list.length ? ` 等 ${rest.length} 人` : '';
    const title = rest.length === 1
      ? `【天梯】${rest[0].p.handle} 天梯升至 ${TIERS[rest[0].to]}`
      : `【天梯】${rest.length} 名选手天梯升级`;
    addNews(
      state,
      'season',
      title,
      `天梯升级：${list.map((x) => `${playerLabel(state, x.p)} ${TIERS[x.from]}→${TIERS[x.to]}`).join('、')}${more}。`,
      mineOf(list) && rest.length === 1,
      { teamIds: teamsOf(list), playerIds: list.map((x) => x.p.id), tags: ['tier'] },
    );
  }
  if (downs.length) {
    const list = downs.slice(0, cfg.tierNewsListMax);
    const more = downs.length > list.length ? ` 等 ${downs.length} 人` : '';
    const title = downs.length === 1
      ? `【天梯】${downs[0].p.handle} 天梯回落至 ${TIERS[downs[0].to]}`
      : `【天梯】${downs.length} 名知名选手天梯回落`;
    addNews(
      state,
      'season',
      title,
      `天梯回落：${list.map((x) => `${playerLabel(state, x.p)} ${TIERS[x.from]}→${TIERS[x.to]}`).join('、')}${more}。`,
      false,
      { teamIds: teamsOf(list), playerIds: list.map((x) => x.p.id), tags: ['tier'] },
    );
  }
}

// ---------------------------------------------------------------------------
// 刀塔周报
// ---------------------------------------------------------------------------

function stripPrefix(title: string): string {
  return title.replace(/^【[^】]*】\s*/, '');
}

/** 发布一期刀塔周报（special = 赛季初特刊） */
export function publishWeekly(state: GameState, special: boolean): NewsItem | null {
  const cfg = NR();
  const r = room(state);
  const ti = state.season?.ti ?? 0;
  const issue = (r.weeklyIssue ?? 0) + 1;
  const rows = powerRanking(state);
  if (!rows.length) return null;
  const size = Math.max(1, cfg.powerRankingSize);
  const top = rows.slice(0, size);
  const prev = r.powerRanking;
  const lines: string[] = [];

  // 实力榜
  lines.push('【实力榜】');
  top.forEach((row, i) => {
    let move = '';
    if (prev?.length) {
      const pi = prev.indexOf(row.teamId);
      if (pi < 0 || pi >= size) move = ' 新上榜';
      else if (pi > i) move = ` ↑${pi - i}`;
      else if (pi < i) move = ` ↓${i - pi}`;
      else move = ' —';
    }
    lines.push(`${i + 1}. ${teamName(state, row.teamId)}（实力分 ${Math.round(row.score)}）${move}`);
  });
  if (prev?.length) {
    const nowTop = new Set(top.map((x) => x.teamId));
    const out = prev.slice(0, size).filter((id) => !nowTop.has(id) && state.teams[id]);
    if (out.length) lines.push(`跌出前${cn(size)}：${out.map((id) => teamName(state, id)).join('、')}`);
  }

  // 热门选手（自上期周报以来）
  const base = r.statBase;
  let hot: { p: Player; mvp: number; wins: number; games: number } | null = null;
  if (base) {
    for (const id in state.players) {
      const p = state.players[id];
      if (!rosterPlayer(p) || !base[id]) continue;
      const st = p.stats ?? { mvp: 0, wins: 0, matches: 0 };
      const mvp = (st.mvp ?? 0) - base[id][0];
      const wins = (st.wins ?? 0) - base[id][1];
      const games = (st.matches ?? 0) - base[id][2];
      if (mvp <= 0 || games <= 0) continue;
      const score = mvp * cfg.hotPlayerMvpWeight + wins;
      const best = hot ? hot.mvp * cfg.hotPlayerMvpWeight + hot.wins : -1;
      if (score > best || (score === best && hot && overallRating(p) > overallRating(hot.p))) hot = { p, mvp, wins, games };
    }
  }
  // 统计窗口：常规期为近 weeklyEvery 回合；赛季初特刊覆盖上期周报以来（TI 预选、TI 正赛与休赛期）
  const span = special ? (prev?.length ? '上期周报以来' : '休赛期') : `近 ${cfg.weeklyEvery} 回合`;
  if (hot) {
    const p = hot.p;
    lines.push('');
    lines.push(`【热门选手】${playerLabel(state, p)} · ${POSITION_LABEL[p.position]}：${span} ${hot.games} 局 ${hot.wins} 胜，${hot.mvp} 次 MVP。`);
  }

  // 近期冠军
  const hist = state.history?.tournaments ?? [];
  const from = Math.min(r.weeklyHistoryCursor ?? hist.length, hist.length);
  const champs = hist.slice(from)
    .filter((h) => h.championId && h.tier !== 'qualifier' && !isFillerCup(h))
    .map((h) => `${h.name}：${teamName(state, h.championId)}`);
  if (champs.length) {
    lines.push('');
    lines.push(`【近期冠军】${champs.slice(-6).join('；')}`);
  }

  // 近期看点
  const idx = state.roundIndex;
  const upcoming: string[] = [];
  for (const round of state.season?.rounds ?? []) {
    if (round.index <= idx || round.index > idx + cfg.upcomingRounds) continue;
    if (round.phase === 'ti_qualifier') upcoming.push(`${roundName(state, round.index)} · 各赛区 TI 预选赛`);
    for (const tid of round.tournamentIds ?? []) {
      const t = state.tournaments[tid];
      if (!t || isFillerCup(t) || !(t.tier === 'ti' || t.tier === 'major' || t.tier === 'premier')) continue;
      upcoming.push(`${roundName(state, round.index)} · ${t.name}（${TOURNAMENT_TIER_LABEL[t.tier]}，奖金池 ${prizePoolLabel(state, t)}）`);
    }
  }
  if (upcoming.length) {
    lines.push('');
    lines.push(`【近期看点】${upcoming.slice(0, cfg.upcomingMax).join('；')}`);
  }

  // 转会动态
  const mark = r.weeklyMark ?? 0;
  const transfers: NewsItem[] = [];
  for (const n of state.news ?? []) {
    if (newsSerial(n.id) <= mark) break;
    if (n.category === 'transfer' && n.visibility !== 'private') transfers.push(n);
  }
  if (transfers.length) {
    const focus = transfers
      .map((n, i) => ({ n, i, s: headlineScore(state, n) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, cfg.weeklyTransfersMax)
      .map((x) => stripPrefix(x.n.title));
    lines.push('');
    lines.push(`【转会动态】${span}共 ${transfers.length} 条转会消息。焦点：${focus.join('；')}`);
  }

  // 关注名单：合同即将到期 / 归属感偏低的明星选手
  const minTier = tierIndex(cfg.rumorMinTier);
  const stars = Object.values(state.players).filter((p) => rosterPlayer(p) && tierIndex(playerTier(p)) >= minTier);
  stars.sort((a, b) => overallRating(b) - overallRating(a));
  const expiring = stars.filter((p) => p.contractUntil <= ti).slice(0, cfg.rumorMax);
  const unsettled = stars.filter((p) => p.loyalty < CONFIG.loyalty.leaveThreshold + cfg.rumorLoyaltyMargin).slice(0, cfg.rumorMax);
  const watch: string[] = [];
  if (expiring.length) watch.push(`合同将于本赛季结束后到期：${expiring.map((p) => playerLabel(state, p)).join('、')}`);
  if (unsettled.length) watch.push(`归属感偏低、去留存疑：${unsettled.map((p) => playerLabel(state, p)).join('、')}`);
  if (watch.length) {
    lines.push('');
    lines.push(`【关注名单】${watch.join('；')}`);
  }

  const lead = teamName(state, top[0].teamId);
  const prevLead = prev?.[0];
  let headline = prevLead && prevLead !== top[0].teamId ? `${lead} 登顶实力榜` : `${lead} 领跑实力榜`;
  if (prev?.length && prevLead === top[0].teamId) {
    // 榜首未变：标题再带上本期升幅最大的战队（新上榜 / 上升 ≥ 2 位），避免每期标题雷同
    let mover: { id: string; up: number; fresh: boolean } | null = null;
    top.forEach((row, i) => {
      const pi = prev.indexOf(row.teamId);
      const fresh = pi < 0 || pi >= size;
      const up = fresh ? size - i : pi - i;
      if ((fresh || up >= 2) && (!mover || up > mover.up)) mover = { id: row.teamId, up, fresh };
    });
    const m = mover as { id: string; up: number; fresh: boolean } | null;
    if (m) headline += `，${teamName(state, m.id)} ${m.fresh ? `跻身前${cn(size)}` : `上升 ${m.up} 位`}`;
  }
  const edition = special ? (prev?.length ? '休赛期特刊' : '赛季前瞻') : `TI${ti} ${roundName(state, idx)}`;
  const item = addNews(
    state,
    'season',
    `刀塔周报 第${issue}期（${edition}）：${headline}`,
    lines.join('\n'),
    true,
    {
      teamIds: [...top.slice(0, 3).map((x) => x.teamId), ...(hot?.p.teamId ? [hot.p.teamId] : [])]
        .filter((id, i, arr) => arr.indexOf(id) === i),
      playerIds: hot ? [hot.p.id] : [],
      scope: 'world',
      visibility: 'public',
      tags: ['weekly'],
    },
  );

  // 更新记忆
  r.weeklyIssue = issue;
  r.powerRanking = rows.slice(0, Math.max(size * 2, size)).map((x) => x.teamId);
  r.weeklyMark = state.idCounter ?? 0;
  r.weeklyHistoryCursor = hist.length;
  const nextBase: Record<string, [number, number, number]> = {};
  for (const id in state.players) {
    const p = state.players[id];
    if (!rosterPlayer(p)) continue;
    nextBase[id] = [p.stats?.mvp ?? 0, p.stats?.wins ?? 0, p.stats?.matches ?? 0];
  }
  r.statBase = nextBase;
  return item;
}

// ---------------------------------------------------------------------------
// 赛季流程钩子（season.ts 调用）
// ---------------------------------------------------------------------------

/** 回合结束（endRound 末尾）：赛事趋势/纪录、天梯变动、每 weeklyEvery 个常规回合一期周报 */
export function newsroomRoundEnd(state: GameState): void {
  if (!state || state.gameOver || !state.season) return;
  try {
    scanFinishedTournaments(state);
    scanTierChanges(state);
    const every = Math.max(1, NR().weeklyEvery);
    if (state.phase === 'regular' && state.roundIndex > 0 && state.roundIndex % every === 0) publishWeekly(state, false);
  } catch (e) {
    // 新闻编辑部出错不应阻断赛季流程
    if (typeof console !== 'undefined') console.warn('[newsroom] round end failed', e);
  }
}

/** 新回合开始（enterRound / startSeason 末尾）：赛季初出周报特刊，然后生成回合要闻 */
export function newsroomRoundStart(state: GameState): void {
  if (!state || state.gameOver || !state.season) return;
  try {
    if (state.phase === 'preseason') {
      scanFinishedTournaments(state);
      scanTierChanges(state);
      publishWeekly(state, true);
    }
    buildRoundDigest(state);
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[newsroom] round start failed', e);
  }
}

// ---------------------------------------------------------------------------
// 赛事结果新闻（tournament.ts 调用）：决赛比分、黑马、卫冕、爆冷、TI 故事线
// ---------------------------------------------------------------------------

export interface TournamentResultContext {
  championId: string;
  runnerUpId: string | null;
  /** 冠军奖金（发放额） */
  prize: number;
  /** 玩家战队参加了该赛事（单机：settings.playerTeamId） */
  playerInvolved: boolean;
}

/** 冠亚军之间的决赛比分（冠军视角，如 "3:1"）；找不到返回 '' */
function finalScore(t: Tournament, championId: string, runnerUpId: string | null): string {
  if (!runnerUpId) return '';
  let best: { round: number; text: string; stage: number } | null = null;
  for (const s of Object.values(t.series ?? {})) {
    const res = s?.result;
    if (!res || res.winnerId !== championId || res.loserId !== runnerUpId) continue;
    const stage = (t.stages ?? []).findIndex((st) => st.id === s.stageId);
    const w = s.teamA === championId ? res.scoreA : res.scoreB;
    const l = s.teamA === championId ? res.scoreB : res.scoreA;
    if (!best || stage > best.stage || (stage === best.stage && s.round > best.round)) best = { round: s.round, stage, text: `${w}:${l}` };
  }
  return best?.text ?? '';
}

function placementText(state: GameState, t: Tournament, from: number, to: number): string {
  const names = (t.placements ?? []).filter((p) => p.rankFrom === from && p.rankTo === to).map((p) => teamName(state, p.teamId));
  return names.join('、');
}

/**
 * 该队 TI 冠军总数（含本届）：开局之前的届次按真实历史（tis.json 的 champion），开局后按本存档的赛事历史。
 * 用于「队史首个 TI 冠军 / 第 N 次夺冠」。
 */
function tiTitleCount(state: GameState, teamId: string): number {
  let n = 0;
  const start = state.settings?.startTi ?? 1;
  for (let ti = 1; ti < start; ti++) {
    try {
      if (getTiInfo(ti)?.champion === teamId) n++;
    } catch {
      // 缺少该届数据
    }
  }
  for (const h of state.history?.tournaments ?? []) if (h.tier === 'ti' && h.championId === teamId && h.season >= start) n++;
  return n;
}

/** 真实选手首次出现在阵容数据中的 TI（playerIndex，模块级缓存） */
let firstTiById: Map<string, number> | null = null;
function realFirstTi(id: string): number | undefined {
  if (!firstTiById) {
    firstTiById = new Map();
    try {
      for (const e of getPlayerIndex()) firstTiById.set(e.id, e.firstTi);
    } catch {
      // 缺少选手索引
    }
  }
  return firstTiById.get(id);
}

/** 选手的职业生涯是否完全在本存档内（程序化选手，或开局届及之后才出道的真实选手）：此时 stats 中的冠军数是完整的 */
function careerInSave(state: GameState, p: Player): boolean {
  if (!p.isReal) return true;
  const first = realFirstTi(p.id);
  return first != null && first >= (state.settings?.startTi ?? 1);
}

/** 冠军新闻（替代 tournament.finishTournament 中的旧文案；TI 赛区预选不调用） */
export function reportTournamentResult(state: GameState, t: Tournament, ctx: TournamentResultContext): void {
  const cfg = NR();
  const champ = ctx.championId;
  const champTeam = state.teams[champ];
  if (!champTeam) return;
  const champName = champTeam.name;
  const ru = ctx.runnerUpId;
  const ruName = ru ? teamName(state, ru) : '';
  const score = finalScore(t, champ, ru);
  const filler = isFillerCup(t);
  const humans = new Set(humanTeamIds(state));
  const mine = humans.has(champ);
  const size = Math.max(t.size ?? 0, t.teamIds?.length ?? 0);
  const exp = t.expectedRanks?.[champ];
  // 黑马：赛前预期名次 ≥ max(darkHorseRank, 参赛队数 × darkHorseFraction)（16 队赛事中预期第 5 的强队夺冠不算黑马）
  const darkHorse = !filler && exp != null && size >= 8
    && exp >= Math.max(cfg.darkHorseRank, Math.ceil(size * (cfg.darkHorseFraction ?? 0)));
  const prev = (state.history?.tournaments ?? []).find(
    (h) => h.season === t.season - 1 && (t.tier === 'ti' ? h.tier === 'ti' : h.seriesId === t.seriesId) && h.tournamentId !== t.id,
  );
  const defending = !filler && prev?.championId === champ;
  const prizeText = ctx.prize > 0 ? formatGold(ctx.prize) : '';
  const finalText = ru ? `决赛${score ? `以 ${score} ` : ''}击败 ${ruName}` : '';
  const extras: string[] = [];
  if (darkHorse) extras.push(`${champName} 赛前预期仅排第 ${exp} 位，黑马夺冠。`);
  if (defending) extras.push(t.tier === 'ti' ? `${champName} 成功卫冕，连续两届捧起不朽盾。` : `${champName} 卫冕成功，蝉联该系列赛冠军。`);
  const tags = ['champion', `level:${t.tier}`];
  if (filler) tags.push('filler');
  if (darkHorse) tags.push('upset');
  const teamIds = [champ, ...(ru ? [ru] : [])];

  if (t.tier === 'ti') {
    const titles = tiTitleCount(state, champ);
    if (titles === 1) extras.push(`这是 ${champName} 队史首个 TI 冠军。`);
    else if (titles > 1 && !defending) extras.push(`这是 ${champName} 第 ${titles} 次捧起不朽盾。`);
    const lineupIds = Object.values(champTeam.lineup ?? {}).filter((x): x is string => !!x && state.players[x]?.teamId === champ);
    const multi = new Map<number, string[]>();
    for (const id of lineupIds) {
      const p = state.players[id];
      // stats.tiTitles 只统计本存档内的冠军：开局前已出道的真实选手可能另有真实 TI 冠军，个人次数不准确时不写
      if (!p || !careerInSave(state, p)) continue;
      const k = p.stats?.tiTitles ?? 0;
      if (k >= 2) multi.set(k, [...(multi.get(k) ?? []), p.handle]);
    }
    for (const [k, handles] of [...multi.entries()].sort((a, b) => b[0] - a[0])) {
      extras.push(`${handles.join('、')} 个人第 ${k} 次捧起不朽盾。`);
    }
    const third = placementText(state, t, 3, 3) || placementText(state, t, 3, 4);
    const fourth = placementText(state, t, 4, 4);
    const standings = [ru ? `亚军 ${ruName}` : '', third ? (fourth ? `季军 ${third}` : `3-4 名 ${third}`) : '', fourth ? `第四名 ${fourth}` : '']
      .filter(Boolean).join('，');
    if (standings) extras.push(`最终排名：${standings}。`);
    addNews(
      state,
      'tournament',
      `${champName} 捧起不朽盾！`,
      `${champName} 在 ${t.name} ${finalText ? `${finalText}，` : ''}加冕 TI${t.season} 冠军${prizeText ? `，独揽 ${prizeText} 奖金` : ''}。`
        + (extras.length ? `\n${extras.join('')}` : ''),
      true,
      { teamIds, playerIds: lineupIds, tags: [...tags, 'ti-champion'] },
    );
    return;
  }

  // 首冠（finishTournament 已先写入 history）：开局以来的首个冠军（玩家战队随时报道；AI 战队须已至少两个赛季无冠，
  // 避免开局阶段人人都是「首冠」），否则本赛季首冠
  if (!filler && t.tier !== 'qualifier') {
    const hist = state.history?.tournaments ?? [];
    const start = state.settings?.startTi ?? t.season;
    let ever = 0;
    for (const h of hist) if (h.championId === champ && h.tier !== 'qualifier' && !isFillerCup(h)) ever++;
    if (ever === 1 && (humans.has(champ) || t.season - start >= 2)) extras.push(`这是 ${champName} 自 TI${start} 赛季以来的首个冠军。`);
    else if (seasonTitleCount(state, t.season, champ, hist.length - 1) === 1) extras.push(`这是 ${champName} 本赛季的首个冠军。`);
  }
  // 任一玩家战队（多人模式下的其他座位）参加的赛事都报道冠军
  const humanIn = ctx.playerInvolved
    || [...(t.teamIds ?? []), ...(t.qualifierTeamIds ?? [])].some((id) => humans.has(id));
  const notable = !mine && !humanIn && t.tier === 'minor' && !filler ? notableTeamSet(state) : null;
  const report = mine || humanIn || t.tier === 'major' || t.tier === 'premier' || !!notable?.has(champ);
  if (!report) return;
  if (mine) {
    addNews(
      state,
      'tournament',
      `夺冠！${champName} 问鼎 ${t.name}`,
      `${finalText ? `${finalText}，` : ''}${prizeText ? `将 ${prizeText} 冠军奖金收入囊中。` : '捧起冠军奖杯。'}全队士气高涨！`
        + (extras.length ? `\n${extras.join('')}` : ''),
      true,
      { teamIds, tags },
    );
    return;
  }
  addNews(
    state,
    'tournament',
    `${darkHorse ? '黑马 ' : ''}${champName} 夺得 ${t.name} 冠军`,
    `${finalText ? `${finalText}，` : ''}${prizeText ? `拿走 ${prizeText} 奖金。` : '捧起冠军奖杯。'}`
      + (extras.length ? `\n${extras.join('')}` : ''),
    t.tier === 'major' || darkHorse,
    { teamIds, tags },
  );
}

/**
 * 爆冷新闻（tier ∈ CONFIG.newsroom.upsetTiers）：淘汰赛中预期名次差距最大的一场冷门、赛前热门早早出局。
 * 每项赛事至多一条。
 */
export function reportTournamentUpsets(state: GameState, t: Tournament): void {
  const cfg = NR();
  if (!(cfg.upsetTiers as readonly string[]).includes(t.tier) || isFillerCup(t)) return;
  const exp = t.expectedRanks ?? {};
  const size = Math.max(1, t.size ?? t.teamIds?.length ?? 1);
  const playoffs = new Set((t.stages ?? []).filter((s) => s.type === 'playoffs').map((s) => s.id));
  let best: { w: string; l: string; gap: number; score: string; label: string } | null = null;
  for (const s of Object.values(t.series ?? {})) {
    const res = s?.result;
    if (!res || !s.teamA || !s.teamB || !playoffs.has(s.stageId)) continue;
    const ew = exp[res.winnerId];
    const el = exp[res.loserId];
    if (ew == null || el == null) continue;
    const gap = ew - el;
    // 只报道「被看好的一方」（预期名次在前半区）被淘汰的冷门
    if (gap < cfg.upsetRankGap || el > Math.ceil(size / 2) || (best && gap <= best.gap)) continue;
    const w = s.teamA === res.winnerId ? res.scoreA : res.scoreB;
    const l = s.teamA === res.winnerId ? res.scoreB : res.scoreA;
    best = { w: res.winnerId, l: res.loserId, gap, score: `${w}:${l}`, label: s.label };
  }
  const crashes = (t.placements ?? [])
    .filter((p) => {
      const e = exp[p.teamId];
      return e != null && e <= cfg.favoriteTop && p.rankFrom <= size
        && placementPercentile(p.rankFrom, p.rankTo, size) >= cfg.favoriteCrashPercentile;
    })
    .sort((a, b) => (exp[a.teamId] ?? 99) - (exp[b.teamId] ?? 99));
  const notable = notableTeamSet(state);
  const bigStage = t.tier === 'ti' || t.tier === 'major';
  if (best && !bigStage && !notable.has(best.l)) best = null;
  if (!best && !crashes.length) return;

  const lines: string[] = [];
  let title = '';
  const teamIds: string[] = [];
  const crash = crashes[0];
  if (crash) {
    const name = teamName(state, crash.teamId);
    const rank = formatRank(crash.rankFrom, crash.rankTo);
    title = `【爆冷】赛前热门 ${name} 止步 ${t.name} ${rank}`;
    lines.push(`${name} 赛前预期第 ${exp[crash.teamId]} 名，最终仅获 ${rank}。`);
    teamIds.push(crash.teamId);
    for (const c of crashes.slice(1)) {
      lines.push(`同样被看好的 ${teamName(state, c.teamId)}（预期第 ${exp[c.teamId]} 名）止步 ${formatRank(c.rankFrom, c.rankTo)}。`);
      teamIds.push(c.teamId);
    }
  }
  if (best) {
    const wn = teamName(state, best.w);
    const ln = teamName(state, best.l);
    if (!title) title = `【爆冷】${wn} ${best.score} 淘汰 ${ln}`;
    lines.push(`${t.name} ${best.label}：赛前预期第 ${exp[best.w]} 名的 ${wn} 以 ${best.score} 击败预期第 ${exp[best.l]} 名的 ${ln}。`);
    teamIds.push(best.w, best.l);
  }
  addNews(state, 'tournament', title, lines.join('\n'), bigStage, {
    teamIds: teamIds.filter((id, i, arr) => arr.indexOf(id) === i),
    tags: ['upset', `level:${t.tier}`],
  });
}

/** TI 小组赛结束（tournament.completeStage 调用）：晋级胜者组/败者组与出局名单、热门出局 */
export function reportTiGroupStage(state: GameState, t: Tournament, groupStageIdx: number): void {
  if (t.tier !== 'ti') return;
  const g = t.stages?.[groupStageIdx];
  const next = t.stages?.[groupStageIdx + 1];
  if (!g || g.type !== 'groups') return;
  const advanced = g.advancedTeamIds ?? [];
  const lb = new Set<string>();
  if (next) {
    for (const sid of next.seriesIds ?? []) {
      const s = t.series[sid];
      if (!s || !s.label.startsWith('败者组')) continue;
      for (const id of [s.teamA, s.teamB]) if (id && advanced.includes(id)) lb.add(id);
    }
  }
  const ub = advanced.filter((id) => !lb.has(id));
  const out = (g.teamIds ?? []).filter((id) => !advanced.includes(id));
  const exp = t.expectedRanks ?? {};
  const lines: string[] = [];
  if (ub.length) lines.push(`晋级胜者组：${ub.map((id) => teamName(state, id)).join('、')}`);
  if (lb.size) lines.push(`进入败者组：${[...lb].map((id) => teamName(state, id)).join('、')}`);
  if (out.length) lines.push(`小组赛出局：${out.map((id) => teamName(state, id)).join('、')}`);
  const fallen = out.filter((id) => (exp[id] ?? 99) <= 4).sort((a, b) => (exp[a] ?? 99) - (exp[b] ?? 99));
  if (fallen.length) {
    lines.push(`赛前预期前四的 ${fallen.map((id) => `${teamName(state, id)}（第 ${exp[id]}）`).join('、')} 小组赛即告出局。`);
  }
  addNews(state, 'tournament', `TI${t.season} 小组赛战罢${fallen.length ? `：${teamName(state, fallen[0])} 爆冷出局` : ''}`,
    lines.join('\n'), true, {
      teamIds: [...ub.slice(0, 4), ...fallen].filter((id, i, arr) => arr.indexOf(id) === i),
      tags: fallen.length ? ['ti-story', 'upset', 'level:ti'] : ['ti-story', 'level:ti'],
    });
}

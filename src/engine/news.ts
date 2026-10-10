// 新闻/消息工具
//
// addNews 第 6 个参数（可选）给出新闻的关联战队/选手、范围（mine/world）、可见性与标签；
// 未显式给出时自动推断（向后兼容所有旧调用）：
// - teamIds：按标题 + 正文中出现的战队全名（及标题中的战队简称）识别，按首次出现位置排序；
// - playerIds：在相关战队（含刚离开这些战队的自由选手）与全部玩家战队的名单中按选手 ID 识别；
// - scope：涉及玩家战队（team.isPlayer，多人模式下为任一玩家）且是主角 → mine，否则 world；
// - visibility：玩家战队的财务/系统消息为 private，其余 public。
import type { GameState, NewsCategory, NewsItem, NewsScope, NewsVisibility, Popup } from './types';
import { CONFIG } from './config';
import { nextId } from './util';

export interface NewsOptions {
  teamIds?: string[];
  playerIds?: string[];
  scope?: NewsScope;
  visibility?: NewsVisibility;
  actorTeamId?: string;
  tags?: string[];
  /** 关闭自动识别（只用显式给出的 teamIds/playerIds） */
  noInfer?: boolean;
}

/** 新闻条数上限（旧数值 400，见 CONFIG.newsroom.maxNews） */
export function newsCap(): number {
  const cap = CONFIG.newsroom?.maxNews;
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 400;
}

export function addNews(
  state: GameState,
  category: NewsCategory,
  title: string,
  body: string,
  important = false,
  opts?: NewsOptions,
): NewsItem {
  const item: NewsItem = {
    id: nextId(state, 'n'),
    season: state.season?.ti ?? 0,
    round: state.roundIndex,
    date: state.currentDate,
    category,
    title,
    body,
    important,
    read: false,
  };
  try {
    annotateNews(state, item, opts);
  } catch {
    // 标注失败不影响新闻本身
  }
  state.news.unshift(item);
  pruneNews(state);
  return item;
}

/** 低价值新闻：玩家逐场赛果、系统提示、八卦（未标重要、无标签） */
function lowValue(n: NewsItem): boolean {
  if (n.important || n.tags?.length) return false;
  return n.category === 'match' || n.category === 'system' || (n.title ?? '').startsWith('【八卦】');
}

/**
 * 超出上限时清理：较旧的一半中优先删除最旧的低价值新闻，仍超出再删最旧的。
 * 这样强队（逐场赛果很多）也能保留更久的转会/赛事/周报历史。
 */
export function pruneNews(state: GameState): void {
  const cap = newsCap();
  const list = state.news;
  if (!list || list.length <= cap) return;
  const keepRecent = Math.floor(cap / 2);
  for (let i = list.length - 1; i >= keepRecent && list.length > cap; i--) {
    if (lowValue(list[i])) list.splice(i, 1);
  }
  if (list.length > cap) list.length = cap;
}

export function pushPopup(state: GameState, popup: Popup): void {
  state.popups.push(popup);
}

// ---------------------------------------------------------------------------
// 标注（战队/选手识别、范围、可见性）
// ---------------------------------------------------------------------------

/** 全部玩家战队 id（单机为 1 支；多人模式为全部座位）。settings.playerTeamId 兜底 */
export function humanTeamIds(state: GameState): string[] {
  const out: string[] = [];
  for (const id in state.teams) if (state.teams[id]?.isPlayer) out.push(id);
  const me = state.settings?.playerTeamId;
  if (me && state.teams[me] && !out.includes(me)) out.push(me);
  return out;
}

const ASCII_WORD = /[A-Za-z0-9]/;

/** text 中 needle 的出现位置（ASCII 词边界：前后不是字母/数字），无则 -1 */
function findWord(text: string, needle: string): number {
  if (!needle) return -1;
  let from = 0;
  for (let guard = 0; guard < 8; guard++) {
    const i = text.indexOf(needle, from);
    if (i < 0) return -1;
    const before = i > 0 ? text[i - 1] : '';
    const after = text[i + needle.length] ?? '';
    const headAscii = ASCII_WORD.test(needle[0]);
    const tailAscii = ASCII_WORD.test(needle[needle.length - 1]);
    if ((!headAscii || !ASCII_WORD.test(before)) && (!tailAscii || !ASCII_WORD.test(after))) return i;
    from = i + 1;
  }
  return -1;
}

interface Hit { id: string; at: number; len: number }

/** 去掉被更长匹配覆盖的短匹配（如「Team Spirit」中的「Spirit」），按出现位置排序 */
function resolveHits(hits: Hit[]): string[] {
  hits.sort((a, b) => b.len - a.len || a.at - b.at);
  const taken: Hit[] = [];
  for (const h of hits) {
    if (taken.some((t) => h.at >= t.at && h.at + h.len <= t.at + t.len)) continue;
    taken.push(h);
  }
  taken.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const h of taken) if (!out.includes(h.id)) out.push(h.id);
  return out;
}

/** 从文本识别战队（全名在标题/正文；简称只在标题中按词边界识别，且长度 ≥ 2） */
export function inferTeamIds(state: GameState, title: string, body: string): string[] {
  const text = `${title}\n${body}`;
  const hits: Hit[] = [];
  for (const id in state.teams) {
    const t = state.teams[id];
    if (!t) continue;
    const name = t.name ?? '';
    if (name.length >= 2) {
      const at = findWord(text, name);
      if (at >= 0) {
        hits.push({ id, at, len: name.length });
        continue;
      }
    }
    const tag = t.tag ?? '';
    if (tag.length >= 2 && tag !== name) {
      const at = findWord(title, tag);
      if (at >= 0) hits.push({ id, at, len: tag.length });
    }
  }
  return resolveHits(hits);
}

/** 在候选选手中按 ID（handle）识别；纯数字或单字符的 ID 不参与识别 */
export function inferPlayerIds(state: GameState, title: string, body: string, candidates: Iterable<string>): string[] {
  const text = `${title}\n${body}`;
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const pid of candidates) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = state.players[pid];
    const h = p?.handle ?? '';
    if (h.length < 2 || /^\d+$/.test(h)) continue;
    const at = findWord(text, h);
    if (at >= 0) hits.push({ id: pid, at, len: h.length });
  }
  return resolveHits(hits);
}

/**
 * 玩家视角的措辞（只出现在写给玩家的消息里）：第一人称、玩家赛事开赛的「赛前预期：」、
 * 待决事件的「请在消息中心…」、趣味事件结果的「影响：」段落（版本新闻的「战力影响：」不匹配）
 */
const MINE_HINT = /我们|我队|我方|赛前预期：|请在消息中心|(^|\n)影响：/;
/** 面向玩家的提示类标题（season.ts / game.ts / honor.ts 中未写明战队名的玩家消息） */
const MINE_TITLE = /^(出征 |无缘 TI|收到赛事邀请|新赛季赛程公布|自动训练|欢迎上任|俱乐部荣誉 [+-]?\d)/;

/** 标题/正文带有明确的玩家视角标记（即使正文提到了其他战队，如「宿敌对决落败：不敌 X」） */
function hasMineMarker(n: Pick<NewsItem, 'title' | 'body'>): boolean {
  return MINE_TITLE.test(n.title ?? '') || MINE_HINT.test(`${n.title ?? ''}\n${n.body ?? ''}`);
}

/**
 * 旧存档或未标注新闻的范围推断：有 scope 直接返回；
 * 否则看 teamIds 是否含玩家战队，再按类别兜底（财务/系统/比赛/事件 → mine）。
 */
export function newsScopeOf(state: GameState, n: NewsItem): NewsScope {
  if (n.scope === 'mine' || n.scope === 'world') return n.scope;
  const humans = humanTeamIds(state);
  if (n.teamIds?.length) return scopeFromTeams(n.teamIds, humans) ?? (hasMineMarker(n) ? 'mine' : 'world');
  if (n.category === 'finance' || n.category === 'system' || n.category === 'match') return 'mine';
  if (n.category === 'event') return 'mine';
  return hasMineMarker(n) ? 'mine' : 'world';
}

/**
 * 该新闻是否属于某个玩家战队（默认当前座位 settings.playerTeamId）的「我的」消息。
 * 单机（≤ 1 支玩家战队）时等价于 newsScopeOf === 'mine'；多人模式下只算与该座位相关的：
 * 相关战队/触发者为该队，或无法归属到其他玩家战队的玩家消息。
 */
export function newsIsMine(state: GameState, n: NewsItem, teamId?: string | null): boolean {
  if (!n || newsScopeOf(state, n) !== 'mine') return false;
  const me = teamId ?? state.settings?.playerTeamId;
  const humans = humanTeamIds(state);
  if (!me || humans.length <= 1) return true;
  if (n.actorTeamId) return n.actorTeamId === me || !!n.teamIds?.includes(me);
  if (n.teamIds?.some((id) => humans.includes(id))) return n.teamIds.includes(me);
  if (n.playerIds?.length) {
    const roster = new Set(state.teams[me]?.playerIds ?? []);
    const humanPlayers = new Set<string>();
    for (const h of humans) for (const pid of state.teams[h]?.playerIds ?? []) humanPlayers.add(pid);
    if (n.playerIds.some((pid) => humanPlayers.has(pid))) return n.playerIds.some((pid) => roster.has(pid));
  }
  return true;
}

/** 玩家战队是主角（首个相关战队）或新闻只涉及 ≤ 2 支战队且含玩家战队 → mine；不含玩家战队 → null */
function scopeFromTeams(teamIds: string[], humans: string[]): NewsScope | null {
  if (!humans.length) return null;
  const involved = teamIds.some((id) => humans.includes(id));
  if (!involved) return null;
  return humans.includes(teamIds[0]) || teamIds.length <= 2 ? 'mine' : 'world';
}

function annotateNews(state: GameState, item: NewsItem, opts?: NewsOptions): void {
  const humans = humanTeamIds(state);
  const infer = !opts?.noInfer;

  // 战队
  let teamIds = (opts?.teamIds ?? []).filter((id, i, arr) => !!id && !!state.teams[id] && arr.indexOf(id) === i);
  if (!opts?.teamIds && infer) teamIds = inferTeamIds(state, item.title, item.body);
  if (teamIds.length) item.teamIds = teamIds;

  // 选手
  let playerIds = (opts?.playerIds ?? []).filter((id, i, arr) => !!id && !!state.players[id] && arr.indexOf(id) === i);
  if (!opts?.playerIds && infer) {
    const cand: string[] = [];
    const teamSet = new Set([...teamIds, ...humans]);
    for (const tid of teamSet) for (const pid of state.teams[tid]?.playerIds ?? []) cand.push(pid);
    // 刚离开相关战队的自由选手（合同到期/解约/离队新闻）
    if (teamIds.length && (item.category === 'transfer' || item.category === 'event')) {
      const rel = new Set(teamIds);
      for (const pid in state.players) {
        const p = state.players[pid];
        if (p && !p.teamId && p.lastTeamId && rel.has(p.lastTeamId)) cand.push(pid);
      }
    }
    playerIds = inferPlayerIds(state, item.title, item.body, cand);
  }
  if (playerIds.length) item.playerIds = playerIds;

  // 范围
  let scope: NewsScope | undefined = opts?.scope;
  let seatContext = false;
  if (!scope) {
    const byTeam = teamIds.length ? scopeFromTeams(teamIds, humans) : null;
    const humanPlayers = new Set<string>();
    for (const h of humans) for (const pid of state.teams[h]?.playerIds ?? []) humanPlayers.add(pid);
    if (byTeam) scope = byTeam;
    else if (teamIds.length && hasMineMarker(item)) {
      // 写给玩家的消息只提到了对手（如「俱乐部荣誉 -6：宿敌对决落败：不敌 X」）→ mine
      scope = 'mine';
      seatContext = true;
    } else if (teamIds.length) {
      // 只涉及 AI 战队，但提到了玩家战队的选手（如被挖角）→ mine
      scope = playerIds.some((pid) => humanPlayers.has(pid)) ? 'mine' : 'world';
    } else if (playerIds.some((pid) => humanPlayers.has(pid))) {
      scope = 'mine';
    } else {
      scope = newsScopeOf(state, item);
      seatContext = scope === 'mine';
    }
  }
  item.scope = scope;

  // 可见性 / 触发者 / 标签
  item.visibility = opts?.visibility
    ?? (scope === 'mine' && (item.category === 'finance' || item.category === 'system') ? 'private' : 'public');
  if (opts?.actorTeamId && state.teams[opts.actorTeamId]) item.actorTeamId = opts.actorTeamId;
  else if (seatContext && !opts?.scope) {
    // 无法从文本归属到具体玩家战队的玩家消息：记下当前座位（settings.playerTeamId，多人模式下由座位上下文换入），
    // 供 newsIsMine 在多人模式下区分「我的」与其他玩家的消息
    const me = state.settings?.playerTeamId;
    if (me && state.teams[me]?.isPlayer) item.actorTeamId = me;
  }
  if (opts?.tags?.length) item.tags = Array.from(new Set(opts.tags.filter(Boolean)));
}

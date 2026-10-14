// 羁绊系统（第十波 #5，用户需求 2026-10-10）
//
// 「历届真实夺冠阵容（及少数标志性阵容）带有隐藏羁绊，五人同队集齐后，全队获得对应属性加成；未激活前隐藏，
//  首次激活发新闻并在 DotaPedia『羁绊图鉴』中解锁（未解锁显示提示）。AI 战队同样可以激活。」
//
// - 定义：src/data/synergies.json（scripts/build-synergies.ts 由 rosters/ti*.json 生成：TI1–TI15 冠军的首发五人 + 3 个标志性阵容）。
// - 激活：五名成员都是同一支（未解散的）战队的在役签约队员（不含赛事临时替补 / 野外替补；CONFIG.synergy.requireStarters = false
//   时不要求都是首发），且该届真实 TI 已经打完（CONFIG.synergy.activateAfterRealTi：当前赛季 > 羁绊届次，避免剧透未来冠军）。
// - 加成：激活期间该队每名在役队员（含替补、临时替补）获得一个永久修正器（来源「羁绊：{名称}」，CONFIG.synergy.bonus），
//   羁绊失效（成员离队 / 退役 / 禁赛）或队员离队时移除。同一战队的多个同属性羁绊不叠加（只生效最早的一个，stackSameAttr）。
// - 时机：market.ts 的签约 / 转会 / 解约 / 临时替补后立即同步；season.ts 在赛季初、每回合开始与结束时全量同步
//   （覆盖 AI 转会、选秀、退役、离队等其他阵容变化）。同步只读写阵容与修正器，不消耗随机数。
// - 状态：GameState.synergies（解锁记录 + 当前激活）为全局公开数据，多人模式各座位共享，不进座位交换列表。
import synergiesJson from '../data/synergies.json';
import { CONFIG } from './config';
import { addModifier } from './player';
import { addNews } from './news';
import type { GameState, Player, PlayerStatus, Position, SynergyAttr, SynergyDef, SynergyState, SynergyUnlock, Team } from './types';
import { POSITIONS } from './types';
import { ownEntry } from './util';

const DEFS: readonly SynergyDef[] = (synergiesJson as unknown as SynergyDef[])
  .slice()
  .sort((a, b) => a.ti - b.ti || (a.kind === b.kind ? 0 : a.kind === 'champion' ? -1 : 1));

/** 修正器来源前缀（「羁绊：TI6 · Wings 五人组」） */
export const SYNERGY_SOURCE_PREFIX = '羁绊：';

export const SYNERGY_ATTR_LABEL: Record<SynergyAttr, string> = {
  insight: '灵性',
  resilience: '韧性',
  talent: '天赋',
  power: '战斗力',
  mmr: '天梯',
};

export const SYNERGY_KIND_LABEL: Record<SynergyDef['kind'], string> = { champion: '冠军阵容', iconic: '经典阵容' };

/** 全部羁绊定义（按届次排序；同届冠军在前） */
export function allSynergies(): readonly SynergyDef[] {
  return DEFS;
}

export function synergyDef(id: string): SynergyDef | undefined {
  return DEFS.find((d) => d.id === id);
}

let memberIndex: Map<string, SynergyDef[]> | null = null;

/** 该选手所属的全部羁绊定义（不论是否解锁） */
export function synergiesOfPlayer(playerId: string): SynergyDef[] {
  if (!memberIndex) {
    memberIndex = new Map();
    for (const d of DEFS) {
      for (const m of d.members) {
        const arr = memberIndex.get(m.id) ?? [];
        arr.push(d);
        memberIndex.set(m.id, arr);
      }
    }
  }
  return memberIndex.get(playerId) ?? [];
}

/** 修正器来源 */
export function synergySource(def: SynergyDef): string {
  return `${SYNERGY_SOURCE_PREFIX}${def.name}`;
}

let knownSources: Set<string> | null = null;

/** 带羁绊前缀、但不属于任何现有羁绊的修正器来源（数据更新后读旧档的残留） */
function isUnknownSynergySource(source: unknown): boolean {
  if (typeof source !== 'string' || !source.startsWith(SYNERGY_SOURCE_PREFIX)) return false;
  knownSources ??= new Set(DEFS.map(synergySource));
  return !knownSources.has(source);
}

/** 该属性的加成（CONFIG.synergy.bonus） */
export function synergyBonus(attr: SynergyAttr): { kind: 'add' | 'mul'; value: number } {
  const b = CONFIG.synergy.bonus[attr];
  const kind = b?.kind === 'mul' ? 'mul' : 'add';
  const value = Number.isFinite(b?.value) ? b.value : kind === 'mul' ? 1 : 0;
  return { kind, value };
}

/** 加成文案：「灵性 +5」「战斗力 +3%」「天梯 +600」 */
export function synergyBonusText(attr: SynergyAttr): string {
  const b = synergyBonus(attr);
  const label = SYNERGY_ATTR_LABEL[attr];
  if (b.kind === 'mul') {
    const pct = Math.round((b.value - 1) * 1000) / 10;
    return `${label} ${pct >= 0 ? '+' : ''}${pct}%`;
  }
  return `${label} ${b.value >= 0 ? '+' : ''}${b.value}`;
}

/** 羁绊状态（缺失时创建：新游戏 / 旧存档） */
export function synergyStateOf(state: GameState): SynergyState {
  const s = state.synergies;
  if (s && typeof s === 'object') {
    s.unlocked ??= {};
    s.active ??= {};
    return s;
  }
  const fresh: SynergyState = { unlocked: {}, active: {} };
  state.synergies = fresh;
  return fresh;
}

/** 当前赛季是否已可觉醒（该届真实 TI 已打完） */
export function synergyAvailable(state: GameState, def: SynergyDef): boolean {
  if (!CONFIG.synergy.activateAfterRealTi) return true;
  return (state.season?.ti ?? 0) > def.ti;
}

/** 已经打完的真实届次（用于展示，避免剧透当前赛季及以后的 TI） */
export function synergyVisibleTis(state: GameState, def: SynergyDef): number[] {
  const cur = state.season?.ti ?? 0;
  return def.tis.filter((t) => t < cur);
}

function isRegularMember(p: Player | undefined, teamId: string): p is Player {
  return !!p && p.status === 'active' && p.teamId === teamId && !p.tempSubUntilTournament && !p.isWildSub;
}

/** 五名成员都在同一支战队（在役签约队员）时返回该战队 id；不考虑届次限制 */
export function synergyHolder(state: GameState, def: SynergyDef): string | null {
  const first = state.players[def.members[0]?.id ?? ''];
  const tid = first?.teamId;
  if (!tid) return null;
  const team = state.teams[tid];
  if (!team || team.disbanded || !Array.isArray(team.playerIds)) return null;
  for (const m of def.members) {
    const p = state.players[m.id];
    if (!isRegularMember(p, tid) || !team.playerIds.includes(m.id)) return null;
    if (CONFIG.synergy.requireStarters && !POSITIONS.some((pos) => team.lineup?.[pos] === m.id)) return null;
  }
  return tid;
}

/** 获得加成的队员：该队全部在役队员（含替补与临时替补） */
function recipientsOf(state: GameState, team: Team): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of team.playerIds ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = state.players[id];
    if (p && p.status === 'active' && p.teamId === team.id) out.push(id);
  }
  return out;
}

function removeSourceMod(p: Player | undefined, src: string): void {
  const mods = p?.modifiers;
  if (!p || !Array.isArray(mods) || !mods.some((m) => m.source === src)) return;
  p.modifiers = mods.filter((m) => m.source !== src);
}

function ensureSourceMod(state: GameState, p: Player, def: SynergyDef, src: string): void {
  const b = synergyBonus(def.attr);
  const mods = Array.isArray(p.modifiers) ? p.modifiers : (p.modifiers = []);
  let found = false;
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    if (m.source !== src) continue;
    if (found) {
      mods.splice(i--, 1); // 重复的同源修正器
      continue;
    }
    found = true;
    // 与当前 CONFIG 保持一致（数值调整后读档即生效），且永不过期
    m.attr = def.attr;
    m.kind = b.kind;
    m.value = b.value;
    m.roundsLeft = null;
  }
  if (!found) addModifier(state, p, { source: src, attr: def.attr, kind: b.kind, value: b.value, roundsLeft: null });
}

/** 各羁绊当前的持有战队与是否生效（同一战队同属性只生效最早的一个） */
function evaluate(state: GameState): Map<string, { teamId: string; effective: boolean }> {
  const out = new Map<string, { teamId: string; effective: boolean }>();
  if (CONFIG.synergy.enabled === false) return out;
  const taken = new Set<string>();
  for (const def of DEFS) {
    if (!synergyAvailable(state, def)) continue;
    const tid = synergyHolder(state, def);
    if (!tid) continue;
    const key = `${tid}|${def.attr}`;
    const effective = CONFIG.synergy.stackSameAttr || !taken.has(key);
    taken.add(key);
    out.set(def.id, { teamId: tid, effective });
  }
  return out;
}

function handlesOf(state: GameState, def: SynergyDef): string[] {
  return def.members.map((m) => state.players[m.id]?.handle ?? m.handle);
}

/** 「OG 的 TI8 夺冠原班五人（…）仍在同队」/「Team Liquid 集齐了 TI8 冠军 OG 的五名成员（…）」 */
function gatheredText(state: GameState, def: SynergyDef, team: Team): string {
  const names = handlesOf(state, def).join('、');
  if (team.id === def.clubId) {
    return `${team.name} 的 TI${def.ti} ${def.kind === 'champion' ? '夺冠' : '经典'}原班五人（${names}）仍在同队`;
  }
  const origin = def.kind === 'champion' ? `TI${def.ti} 冠军 ${def.club}` : `TI${def.ti} ${def.club} 经典阵容`;
  return `${team.name} 集齐了 ${origin} 的五名成员（${names}）`;
}

function onActivated(state: GameState, def: SynergyDef, team: Team, effective: boolean): void {
  const st = synergyStateOf(state);
  const prev = st.unlocked[def.id];
  const memberIds = def.members.map((m) => m.id);
  const bonus = effective ? `全队${synergyBonusText(def.attr)}` : `与本队已生效的同属性羁绊不叠加（${synergyBonusText(def.attr)}）`;
  if (!prev) {
    st.unlocked[def.id] = {
      ti: state.season?.ti ?? 0,
      round: state.roundIndex ?? 0,
      date: state.currentDate ?? '',
      teamId: team.id,
      teamName: team.name,
      count: 1,
    };
    addNews(
      state,
      'event',
      `【羁绊觉醒】${def.name}`,
      `${gatheredText(state, def, team)}，隐藏羁绊「${def.name}」觉醒：${bonus}。该羁绊已收录进 DotaPedia「羁绊图鉴」。`,
      true,
      { teamIds: [team.id], playerIds: memberIds, tags: ['synergy'] },
    );
    return;
  }
  prev.count = (Number.isFinite(prev.count) ? prev.count : 1) + 1;
  // 已解锁的羁绊再次激活：只在人类玩家战队相关时报道（AI 战队阵容反复变动时不刷屏）
  if (team.isPlayer) {
    addNews(
      state,
      'event',
      `【羁绊】「${def.name}」再度集结`,
      `${gatheredText(state, def, team)}，羁绊「${def.name}」生效：${bonus}。`,
      false,
      { teamIds: [team.id], playerIds: memberIds, tags: ['synergy'] },
    );
  }
}

function onDeactivated(state: GameState, def: SynergyDef, teamId: string): void {
  const team = ownEntry(state.teams, teamId);
  if (!team?.isPlayer || team.disbanded) return;
  const gone = def.members.filter((m) => !isRegularMember(state.players[m.id], teamId)).map((m) => state.players[m.id]?.handle ?? m.handle);
  addNews(
    state,
    'event',
    `【羁绊】「${def.name}」失效`,
    `${gone.length ? `${gone.join('、')} 已不在阵中，` : ''}${team.name} 的羁绊「${def.name}」失效，全队${synergyBonusText(def.attr)} 的加成取消。`,
    false,
    { teamIds: [teamId], tags: ['synergy'] },
  );
}

/**
 * 同步全部羁绊：激活 / 失效、发放 / 收回修正器、首次觉醒解锁 + 新闻。幂等，可在任意阵容变化后调用。
 * full = true 时额外扫描全部选手，清理残留的羁绊修正器（每回合一次即可；签约 / 转会后的即时同步不需要）。
 */
export function syncSynergies(state: GameState, opts?: { full?: boolean }): void {
  if (!state?.players || !state.teams || !DEFS.length) return;
  const st = synergyStateOf(state);
  const now = evaluate(state);
  const desired = opts?.full ? new Map<string, Set<string>>() : null;

  for (const def of DEFS) {
    const src = synergySource(def);
    const cur = now.get(def.id);
    const prev = st.active[def.id];
    const team = cur ? state.teams[cur.teamId] : undefined;
    const want = cur && team && cur.effective ? recipientsOf(state, team) : [];
    const wantSet = new Set(want);
    if (desired) desired.set(src, wantSet);

    // 收回：上次发放过、这次不再应得的队员（离队 / 羁绊失效 / 同属性让位）
    if (prev) for (const pid of prev.playerIds ?? []) if (!wantSet.has(pid)) removeSourceMod(state.players[pid], src);
    // 发放 / 校正
    for (const pid of want) {
      const p = state.players[pid];
      if (p) ensureSourceMod(state, p, def, src);
    }

    if (cur && team) {
      if (prev && prev.teamId === cur.teamId) {
        prev.playerIds = want;
      } else {
        if (prev) {
          delete st.active[def.id];
          onDeactivated(state, def, prev.teamId);
        }
        st.active[def.id] = { teamId: cur.teamId, ti: state.season?.ti ?? 0, round: state.roundIndex ?? 0, playerIds: want };
        onActivated(state, def, team, cur.effective);
      }
    } else if (prev) {
      delete st.active[def.id];
      onDeactivated(state, def, prev.teamId);
    }
  }
  // 清理不在定义表中的激活记录（数据更新后读旧档）
  for (const id of Object.keys(st.active)) {
    if (synergyDef(id)) continue;
    for (const pid of st.active[id].playerIds ?? []) {
      const p = state.players[pid];
      if (p?.modifiers?.length) p.modifiers = p.modifiers.filter((m) => !isUnknownSynergySource(m.source));
    }
    delete st.active[id];
  }

  if (desired) {
    for (const pid in state.players) {
      const p = state.players[pid];
      const mods = p.modifiers;
      if (!Array.isArray(mods) || !mods.length) continue;
      let stale = false;
      for (const m of mods) {
        if (typeof m.source !== 'string' || !m.source.startsWith(SYNERGY_SOURCE_PREFIX)) continue;
        if (!desired.get(m.source)?.has(pid)) {
          stale = true;
          break;
        }
      }
      if (stale) {
        p.modifiers = mods.filter((m) => typeof m.source !== 'string' || !m.source.startsWith(SYNERGY_SOURCE_PREFIX) || !!desired.get(m.source)?.has(pid));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 只读查询（UI）
// ---------------------------------------------------------------------------

export interface TeamSynergyView {
  def: SynergyDef;
  /** 是否生效（同一战队的同属性羁绊只生效最早的一个） */
  effective: boolean;
  bonusText: string;
  /** 本次激活的赛季 / 回合 */
  ti: number;
  round: number;
}

/** 该战队当前激活的羁绊（按届次） */
export function teamSynergies(state: GameState, teamId: string | null | undefined): TeamSynergyView[] {
  const active = state?.synergies?.active;
  if (!teamId || !active) return [];
  const out: TeamSynergyView[] = [];
  const taken = new Set<SynergyAttr>();
  for (const def of DEFS) {
    const a = active[def.id];
    if (!a || a.teamId !== teamId) continue;
    const effective = CONFIG.synergy.stackSameAttr || !taken.has(def.attr);
    taken.add(def.attr);
    out.push({ def, effective, bonusText: synergyBonusText(def.attr), ti: a.ti, round: a.round });
  }
  return out;
}

export interface SynergyMemberView {
  id: string;
  handle: string;
  /** 当届位置 */
  position: Position;
  teamId: string | null;
  status: PlayerStatus | 'missing';
}

export interface SynergyCatalogEntry {
  def: SynergyDef;
  unlocked: boolean;
  unlock: SynergyUnlock | null;
  /** 当前赛季是否已可觉醒 */
  available: boolean;
  /** 未解锁时显示的提示标题：「TI6 冠军之魂 · ？？？」 */
  hint: string;
  /** 已打完的真实届次（解锁后展示「TI8、TI9 冠军」） */
  visibleTis: number[];
  bonusText: string;
  /** 当前激活（null = 未激活） */
  active: { teamId: string; effective: boolean; ti: number; round: number } | null;
  /** 成员现状（只在解锁后给出，未解锁为空） */
  members: SynergyMemberView[];
  /** 指定战队（通常是本方）当前拥有的成员数（只在解锁后给出） */
  owned: number;
}

/** 未解锁时的提示标题 */
export function synergyLockedHint(def: SynergyDef): string {
  return def.kind === 'champion' ? `TI${def.ti} 冠军之魂 · ？？？` : `TI${def.ti} 经典阵容 · ？？？`;
}

/** 羁绊图鉴：全部羁绊的解锁 / 激活状态（viewerTeamId 用于统计本方拥有的成员数） */
export function synergyCatalog(state: GameState, viewerTeamId?: string | null): SynergyCatalogEntry[] {
  const st = state?.synergies;
  const views = new Map<string, TeamSynergyView>();
  for (const id of new Set(Object.values(st?.active ?? {}).map((a) => a.teamId))) {
    for (const v of teamSynergies(state, id)) views.set(v.def.id, v);
  }
  return DEFS.map((def) => {
    const unlock = st?.unlocked?.[def.id] ?? null;
    const unlocked = !!unlock;
    const a = st?.active?.[def.id];
    const v = views.get(def.id);
    const members: SynergyMemberView[] = unlocked
      ? def.members.map((m) => {
        const p = state.players[m.id];
        return { id: m.id, handle: p?.handle ?? m.handle, position: m.position, teamId: p?.teamId ?? null, status: p?.status ?? 'missing' };
      })
      : [];
    const owned = unlocked && viewerTeamId
      ? def.members.filter((m) => isRegularMember(state.players[m.id], viewerTeamId)).length
      : 0;
    return {
      def,
      unlocked,
      unlock,
      available: synergyAvailable(state, def),
      hint: synergyLockedHint(def),
      visibleTis: unlocked ? synergyVisibleTis(state, def) : [],
      bonusText: synergyBonusText(def.attr),
      active: a ? { teamId: a.teamId, effective: v?.effective ?? true, ti: a.ti, round: a.round } : null,
      members,
      owned,
    };
  });
}

/** 图鉴进度：已解锁 / 总数 / 当前激活 */
export function synergyProgress(state: GameState): { unlocked: number; total: number; active: number } {
  const st = state?.synergies;
  return {
    unlocked: DEFS.filter((d) => !!st?.unlocked?.[d.id]).length,
    total: DEFS.length,
    active: DEFS.filter((d) => !!st?.active?.[d.id]).length,
  };
}

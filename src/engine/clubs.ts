// 新俱乐部涌现（第十波 #2）【J1-clubs-missions】
// 现实中后来才成立的真实俱乐部（如 Secret、OG、Spirit、Tundra、Falcons）在其首次出现在阵容数据中的赛季加入联赛：
//   - 每个赛季初（season.startSeason：赛季自主成长之后、新秀选秀与休赛期转会潮之前；新游戏的第一个赛季不执行）全局执行一次；
//   - 候选 = 当届 roster 中出现、而本局从未有过该组织战队的真实组织（src/data/clubIndex.json，同一组织的改名 / 冠名战队视为同一家，
//     例如 PSG.LGD = LGD、G2.iG = Invictus Gaming，避免与品牌变迁重复建队）；按重要程度（当届 TI 正赛队、现实最好名次、荣誉）排序，
//     每赛季至多 CONFIG.clubs.maxRealPerSeason 家；
//   - 以当届真实品牌（名称 / 简称 / 赛区 / 配色）、荣誉与资金（与开局 AI 战队同口径）成立，签回当届真实选手：自由选手直接签，
//     AI 战队的选手由创始投资支付转会费求购（卖家可拒绝），**从不动人类玩家战队的选手**；本局中从未出现过的当届真实选手
//     （开局届的阵容数据里没有他、也不是待登场新秀，例如 TI8 开局时 Spirit 在 TI9 的老将们）按其当届真实水平作为自由选手加入并签下；
//     其余位置用自由选手 / 生成新人补齐；
//     选秀之后（signFoundedClubRookies）再尝试签回本届登场、被 AI 战队选中或落选的真实新秀；
//   - 联赛规模：未解散战队数不超过 CONFIG.clubs.maxTeams（下限 team.minTeams 由 ai.aiEnsureRosters 补足）；联赛已满时，
//     为「重要」真实俱乐部解散一支过气的 AI 俱乐部腾出席位（虚构组织或现实中此后不再出现的组织，荣誉低、战力靠后）；
//   - 偶尔（CONFIG.clubs.fictionalChance）成立一个虚构新组织；
//   - 新闻：「【新战队】{name} 成立」「【解散】{name} 宣布解散」。全部随机数取自 rngOf(state)。
import type { ClubFoundingState, GameState, Player, PlayerIndexEntry, Position, Region, SeedCoach, SeedPlayer, Team } from './types';
import { POSITIONS, REGIONS } from './types';
import { CONFIG } from './config';
import { rngOf, type Rng } from './rng';
import { clamp, ownEntry } from './util';
import { addNews } from './news';
import { activeTeams, autoLineup, rankTeamsByRating, teamPlayers } from './team';
import { computeSalary, marketValue, overallRating, playerTier, seasonYear } from './player';
import { realRoleFor } from './roles';
import { addFinance, econ, realClubStartingFunds, roundWageBill } from './economy';
import { departToFreeAgency, executeTransfer, fillRosterFromMarket, roundFee } from './market';
import { coachFromSeed, colorFromId, generateTeamName, playerFromSeed } from './generation';
import { isHumanTeam, removePendingDecisionsEverywhere } from './seat';
import { brandEraAt } from './branding';
import { getPlayerIndex, getTrajectory } from '../data/index';
import { clubOrg, clubOrgs, orgAppAt, peakPlayerIdsOfTeam, realOrgOf, type ClubApp, type ClubOrg } from './clubIndex';

// 俱乐部索引（类型与查询）在 clubIndex.ts（不依赖其他引擎模块，供 team.ts 的 AI 首发优先级使用），此处转出
export type { ClubApp, ClubOrg, ClubPeak } from './clubIndex';
export { clubOrg, clubOrgs, orgAppAt, orgOfTeamId, peakOrgsOfPlayer, peakPlayerIdsOfTeam, realOrgOf } from './clubIndex';

/** 组织在本局中当前对应的（未解散）战队 */
export function orgTeam(state: GameState, org: ClubOrg): Team | null {
  for (const tid of org.teamIds) {
    const t = state.teams[tid];
    if (t && !t.disbanded) return t;
  }
  for (const t of Object.values(state.teams)) {
    if (!t.disbanded && t.founded?.orgId === org.id) return t;
  }
  return null;
}

/** 本局中是否出现过该组织的战队（含已解散 / 除名） */
function orgEverInSave(state: GameState, org: ClubOrg): boolean {
  if (org.teamIds.some((tid) => !!state.teams[tid])) return true;
  return Object.values(state.teams).some((t) => t.founded?.orgId === org.id);
}

// ---------------------------------------------------------------------------
// 状态与查询
// ---------------------------------------------------------------------------

export function clubFoundingState(state: GameState): ClubFoundingState {
  if (!state.clubFounding || typeof state.clubFounding !== 'object') {
    state.clubFounding = { ti: 0, founded: [], retired: [] };
  }
  const s = state.clubFounding;
  if (!Array.isArray(s.founded)) s.founded = [];
  if (!Array.isArray(s.retired)) s.retired = [];
  if (!Number.isFinite(s.ti)) s.ti = 0;
  return s;
}

/** 联赛规模（未解散战队数，含玩家） */
export function leagueSize(state: GameState): number {
  return activeTeams(state).length;
}

/** 联赛规模目标区间 [min, max] */
export function leagueSizeRange(): { min: number; max: number } {
  const min = Math.max(0, Math.floor(CONFIG.team.minTeams ?? 0));
  return { min, max: Math.max(min, Math.floor(CONFIG.clubs.maxTeams ?? min)) };
}

export interface FoundedClubInfo {
  teamId: string;
  kind: 'real' | 'fictional';
  orgId?: string;
  /** 签回的当届真实选手 id */
  signed: string[];
  /** 当届真实选手中效力于人类玩家战队、因此没有动的选手 id */
  skippedHuman: string[];
}

export interface ClubFoundingReport {
  ti: number;
  founded: FoundedClubInfo[];
  retired: string[];
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const C = () => CONFIG.clubs;

function regular(state: GameState, teamId: string): Player[] {
  return teamPlayers(state, teamId).filter((p) => !p.tempSubUntilTournament && !p.isWildSub);
}

function rangeOf(rng: Rng, r: readonly [number, number]): number {
  return rng.range(Math.min(r[0], r[1]), Math.max(r[0], r[1]));
}

function emptyLineup() {
  return { C: null, M: null, O: null, SS: null, HS: null };
}

/** 卖家队内头号（综合评分最高）选手 */
function isTopOf(state: GameState, p: Player, teamId: string): boolean {
  const r = overallRating(p);
  for (const q of regular(state, teamId)) if (q.id !== p.id && overallRating(q) > r) return false;
  return true;
}

function uniqueTeamId(state: GameState, base: string): string {
  if (!state.teams[base]) return base;
  let n = 2;
  while (state.teams[`${base}-${n}`]) n++;
  return `${base}-${n}`;
}

function fundsRound(v: number): number {
  return Math.max(0, Math.round(v / 1000) * 1000);
}

/**
 * 候选的重要程度：现实中的历史地位（TI 冠军次数、最好名次）优先，其次是否当届 TI 正赛队、荣誉——
 * 例如 Spirit 在 TI9 以 DNQ 身份首次出现，仍先于当届一次性参赛的队伍成立（以阵容数据中首次出现的届次为准）。
 */
function priorityOf(org: ClubOrg, app: ClubApp): number {
  const b = org.best?.rank;
  const legacy = org.titles.length * 3000 + (b === undefined ? 0 : b <= 4 ? 1500 : b <= 8 ? 800 : b <= 16 ? 200 : 0);
  return legacy + (app.atTI ? 1000 : 0) + clamp(app.honor, 0, 3000) / 10;
}

function isMajor(org: ClubOrg, app: ClubApp): boolean {
  return app.atTI || (!!org.best && org.best.rank <= C().majorBestRank);
}

// ---------------------------------------------------------------------------
// 签回真实选手
// ---------------------------------------------------------------------------

/**
 * 新俱乐部签下某名真实选手：自由选手直接签（签字费由创始投资承担）；AI 战队的选手按 身价 × U(fee) 求购
 * （转会费由创始投资承担、卖家照收，卖家按概率放人）；人类玩家战队的选手一律不动。工资须负担得起（budgetRounds 回合）。
 * 返回 'signed' | 'human' | 'skip'。
 */
function trySignRealPlayer(
  state: GameState, team: Team, p: Player, rng: Rng, keep: ReadonlySet<string> = new Set(),
): 'signed' | 'human' | 'skip' {
  const c = C();
  if (p.status !== 'active' || p.isWildSub || p.tempSubUntilTournament || p.teamId === team.id) return 'skip';
  const seller = p.teamId ? state.teams[p.teamId] : undefined;
  if (p.teamId && (!seller || seller.disbanded)) return 'skip';
  if (seller && (seller.isPlayer || isHumanTeam(state, seller.id))) return 'human';
  // 阵容已满：当届真实选手优先于补位的自由选手 / 新人——放走一名不在 keep（当届名单 + 使命成员）中的最弱队员（成交时才放）
  let spare: Player | undefined;
  if (regular(state, team.id).length >= CONFIG.ai.maxRoster) {
    spare = regular(state, team.id)
      .filter((q) => !keep.has(q.id))
      .sort((a, b) => overallRating(a) - overallRating(b) || (a.id < b.id ? -1 : 1))[0];
    if (!spare || overallRating(spare) > overallRating(p) + c.spareMaxGap) return 'skip';
  }
  const salary = computeSalary(state, p, p.isRookie === true);
  if (team.gold < (roundWageBill(state, team.id) - (spare?.salary ?? 0) + salary) * c.budgetRounds) return 'skip';
  if (seller) {
    const accept = c.sellChance
      - (isTopOf(state, p, seller.id) ? c.sellStarPenalty : 0)
      - (peakPlayerIdsOfTeam(state, seller.id).includes(p.id) ? c.sellMissionPenalty : 0);
    if (!rng.chance(clamp(accept, 0, 1))) return 'skip';
  }
  if (spare) departToFreeAgency(state, spare.id);
  const [cLo, cHi] = c.signContractSeasons;
  const contractSeasons = rng.int(Math.min(cLo, cHi), Math.max(cLo, cHi));
  const loyalty = c.signLoyalty;
  if (seller) {
    const fee = roundFee(marketValue(state, p) * rangeOf(rng, c.fee));
    // 转会费由创始投资承担（俱乐部运营资金不变，卖家照收）
    if (fee > 0) addFinance(state, team.id, fee, 'other', `创始投资：${p.handle} 的转会费`);
    executeTransfer(state, p.id, team.id, fee, { salary, contractSeasons, loyalty });
    if (p.teamId !== team.id) return 'skip';
    // 卖家阵容补足（AI 战队至少 minRoster 人）
    if (regular(state, seller.id).length < CONFIG.ai.minRoster) fillRosterFromMarket(state, seller.id, CONFIG.ai.minRoster);
    return 'signed';
  }
  // 自由身：签字费由创始投资承担（不影响俱乐部运营资金）
  executeTransfer(state, p.id, team.id, 0, { salary, contractSeasons, loyalty });
  return p.teamId === team.id ? 'signed' : 'skip';
}

let INDEX_BY_ID: Map<string, PlayerIndexEntry> | null = null;
function playerIndexEntry(id: string): PlayerIndexEntry | undefined {
  if (!INDEX_BY_ID) {
    INDEX_BY_ID = new Map();
    try {
      for (const e of getPlayerIndex() ?? []) if (e?.id) INDEX_BY_ID.set(e.id, e);
    } catch {
      /* 无索引：不补人 */
    }
  }
  return INDEX_BY_ID.get(id);
}

/** 真实选手的游戏 ID（真实选手索引；本局中尚未出现的选手用于界面展示，无记录时返回 id） */
export function realPlayerHandle(id: string): string {
  return playerIndexEntry(id)?.handle || id;
}

/**
 * 本局中从未出现过的当届真实选手（开局届的阵容数据里没有他、不是待登场新秀、也没有同名教练）：按当届真实生涯轨迹的战力 / 天梯、
 * 真实选手索引的身份与天赋 / 灵性，作为自由选手加入本局（随后由新俱乐部签下）。不满足条件返回 null。
 */
function bringBackRealPlayer(state: GameState, pid: string, ti: number, position: Position | undefined): Player | null {
  if (state.players[pid] || state.coaches[pid] || state.futureRookies?.[pid] !== undefined) return null;
  const e = playerIndexEntry(pid);
  const point = getTrajectory(pid)?.[ti];
  if (!e || !point || e.firstTi > ti) return null;
  const gen = CONFIG.generation;
  const age = seasonYear(state) - e.birthYear;
  const seed: SeedPlayer = {
    id: pid,
    handle: e.handle || pid,
    ...(e.name ? { name: e.name } : {}),
    nationality: e.nationality,
    birthYear: e.birthYear,
    // 俱乐部当届阵容中的位置；缺失时取当届（或此前最近一届）的真实位置（第十三波，roles.realRoleFor），再退回首次出现时的位置
    position: position && POSITIONS.includes(position) ? position : realRoleFor(pid, ti) ?? e.position,
    mmr: point.mmr,
    power: point.power,
    talent: clamp(e.peakTalent - C().bringBackTalentDecline * Math.max(0, age - C().bringBackTalentAgeFrom), 20, CONFIG.player.maxAttr),
    resilience: clamp(gen.resilienceBase + (age - 18) * gen.resiliencePerYear, 20, 95),
    insight: e.insight,
    loyalty: gen.loyaltyMean,
    signatureHeroes: e.signatureHeroes ?? [],
  };
  return playerFromSeed(state, seed, null);
}

function hireRealCoach(state: GameState, team: Team, seed: SeedCoach | null, ti: number): void {
  if (!seed?.id || team.coachId) return;
  const existing = state.coaches[seed.id];
  if (existing) {
    if (!existing.teamId) {
      existing.teamId = team.id;
      team.coachId = existing.id;
    }
    return;
  }
  // 与 coaches.ts 一致：本局仍在役 / 尚未出道的同名选手、已由退役选手转任的同名教练不重复创建
  const asPlayer = state.players[seed.id];
  if ((asPlayer && asPlayer.status === 'active') || state.futureRookies?.[seed.id] !== undefined) return;
  if (Object.values(state.coaches).some((c) => c.formerPlayerId === seed.id)) return;
  const coach = coachFromSeed(state, seed, team.id);
  coach.arrivedTi ??= ti;
  if (coach.teamId === team.id || coach.teamId === null) {
    coach.teamId = team.id;
    team.coachId = coach.id;
  }
}

// ---------------------------------------------------------------------------
// 腾位：解散过气的 AI 俱乐部
// ---------------------------------------------------------------------------

function retireCandidates(state: GameState, ti: number): Team[] {
  const c = C();
  const teams = activeTeams(state);
  const ranked = rankTeamsByRating(state, teams.map((t) => t.id));
  const rank = new Map(ranked.map((id, i) => [id, i + 1]));
  const n = Math.max(1, teams.length);
  const cut = n * (1 - clamp(c.retireRankShare, 0, 1));
  const out: { t: Team; key: number }[] = [];
  for (const t of teams) {
    if (t.isPlayer || isHumanTeam(state, t.id) || t.founded?.ti === ti) continue;
    if (!(t.honor < c.retireHonorMax)) continue;
    const r = rank.get(t.id) ?? n;
    if (r <= cut) continue;
    const org = realOrgOf(state, t.id);
    // 真实组织：现实中夺得过 TI 的不解散；上一届起（含本届及以后）仍出现在阵容数据中的不解散（只解散现实中已消失两届以上的组织）
    if (org && (org.titles.length > 0 || org.apps.some((a) => a.ti >= ti - 1))) continue;
    out.push({ t, key: t.honor - r * 5 });
  }
  out.sort((a, b) => a.key - b.key || (a.t.id < b.t.id ? -1 : 1));
  return out.map((x) => x.t);
}

/** 解散一支 AI 俱乐部（为新俱乐部腾出联赛席位）：全部队员成为自由选手、主教练进入教练市场、相关报价作废 */
function retireClub(state: GameState, team: Team, ti: number): void {
  const freed: Player[] = [];
  for (const pid of team.playerIds.slice()) {
    const p = state.players[pid];
    if (!p) continue;
    departToFreeAgency(state, pid);
    if (p.status === 'active' && !p.isWildSub) freed.push(p);
  }
  team.playerIds = [];
  team.lineup = emptyLineup();
  if (team.coachId) {
    const coach = state.coaches[team.coachId];
    if (coach && coach.teamId === team.id) coach.teamId = null;
    team.coachId = null;
  }
  team.disbanded = true;
  for (const o of state.transferOffers ?? []) {
    if (o.status === 'pending' && (o.fromTeamId === team.id || o.toTeamId === team.id)) o.status = 'expired';
  }
  removePendingDecisionsEverywhere(state, (d) => d.ctx?.teamId === team.id || d.ctx?.buyerId === team.id || d.ctx?.fromTeamId === team.id);
  clubFoundingState(state).retired.push({ ti, teamId: team.id });
  freed.sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : 1));
  const names = freed.slice(0, 6).map((p) => p.handle);
  addNews(
    state,
    'transfer',
    `【解散】${team.name} 宣布解散`,
    `${team.name}（${team.tag}）在休赛期宣布退出职业联赛。`
      + (names.length ? `${names.join('、')}${freed.length > names.length ? ' 等' : ''}成为自由选手。` : ''),
    true,
    { teamIds: [team.id], playerIds: freed.map((p) => p.id), tags: ['disband'], noInfer: true },
  );
}

// ---------------------------------------------------------------------------
// 成立
// ---------------------------------------------------------------------------

function foundRealClub(state: GameState, org: ClubOrg, app: ClubApp, ti: number, rng: Rng): FoundedClubInfo {
  const c = C();
  const id = uniqueTeamId(state, app.teamId);
  // 本局中从未出现过的当届真实选手：按当届水平作为自由选手加入（随后签下）
  app.players.forEach((pid, i) => {
    if (!state.players[pid]) bringBackRealPlayer(state, pid, ti, app.positions[i]);
  });
  // 起始资金：与开局的真实俱乐部同一公式（economy.realClubStartingFunds：数据资金 × 0.2 封顶于强队锚定额 × 年代系数），不低于当届真实选手工资 × minFundsWageRounds
  let estWage = 0;
  for (const pid of app.players.slice(0, CONFIG.ai.maxRoster)) {
    const p = state.players[pid];
    if (p && p.status === 'active' && !isHumanTeam(state, p.teamId)) estWage += computeSalary(state, p);
  }
  // 品牌变迁数据（branding.ts，第十波 #4）给出该届名称 / 简称时以其为准（阵容数据个别届次写法不同，如 TI10 的 Team Nigma → Nigma Galaxy），
  // 成立新闻与本赛季显示的就是当届品牌，下个赛季也不会再因对齐而发「品牌更新」新闻
  const era = brandEraAt(app.teamId, ti);
  const team: Team = {
    id,
    name: era?.name || app.name || org.name,
    tag: era?.tag || app.tag || app.name.slice(0, 5),
    region: app.region,
    color: /^#[0-9a-fA-F]{6}$/.test(app.color) ? app.color : colorFromId(id),
    honor: Math.max(1, Math.round(app.honor || CONFIG.team.newClubHonor)),
    gold: Math.max(realClubStartingFunds(app.funds, null, ti), fundsRound(estWage * c.minFundsWageRounds)),
    isPlayer: false,
    playerIds: [],
    lineup: emptyLineup(),
    coachId: null,
    points: 0,
    founded: { ti, kind: 'real', orgId: org.id },
  };
  state.teams[id] = team;
  const info: FoundedClubInfo = { teamId: id, kind: 'real', orgId: org.id, signed: [], skippedHuman: [] };
  for (const pid of app.players) {
    const p = state.players[pid];
    if (!p) continue;
    const r = trySignRealPlayer(state, team, p, rng);
    if (r === 'signed') info.signed.push(pid);
    else if (r === 'human') info.skippedHuman.push(pid);
  }
  hireRealCoach(state, team, app.coach, ti);
  if (regular(state, id).length < CONFIG.ai.minRoster) fillRosterFromMarket(state, id, CONFIG.ai.minRoster);
  autoLineup(state, id);
  const wage = roundWageBill(state, id);
  if (team.gold < wage * c.minFundsWageRounds) team.gold = fundsRound(wage * c.minFundsWageRounds);
  // 俱乐部使命（missions.ts）的起点：成立时已在队的巅峰阵容成员。成立时即已集齐（巅峰阵容就是当届阵容）只记录、不另发「集齐」新闻
  // （成立新闻已列出这些选手）；之后转会补齐的照常发新闻
  if (CONFIG.missions?.enabled && org.peak) {
    const have = org.peak.players.filter((pid) => regular(state, id).some((q) => q.id === pid && q.status === 'active')).length;
    team.mission = have >= org.peak.players.length ? { have, firstCompletedTi: ti, completedTi: ti } : { have };
  }
  return info;
}

function foundFictionalClub(state: GameState, ti: number, rng: Rng): FoundedClubInfo | null {
  const c = C();
  const count = Object.fromEntries(REGIONS.map((r) => [r, 0])) as Record<Region, number>;
  for (const t of activeTeams(state)) count[t.region] = (count[t.region] ?? 0) + 1;
  const min = Math.min(...REGIONS.map((r) => count[r]));
  const region = rng.pick(REGIONS.filter((r) => count[r] === min));
  const { name, tag } = generateTeamName(state, region);
  const id = uniqueTeamId(state, `org-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team'}`);
  const golds = activeTeams(state).filter((t) => !t.isPlayer).map((t) => t.gold).sort((a, b) => a - b);
  const median = golds.length ? golds[Math.floor(golds.length / 2)] : 0;
  // 中位数 ≤ 0 时的兜底按经济指数折算（与 shuffle.ts 新组织资金同口径）
  const base = median > 0 ? median : rangeOf(rng, CONFIG.generation.aiTeam.funds.mid) * econ(state);
  const [hLo, hHi] = c.fictionalHonor;
  const team: Team = {
    id,
    name,
    tag,
    region,
    color: colorFromId(id),
    honor: rng.int(Math.min(hLo, hHi), Math.max(hLo, hHi)),
    gold: fundsRound(base * rangeOf(rng, c.fictionalFundsMedianMult)),
    isPlayer: false,
    playerIds: [],
    lineup: emptyLineup(),
    coachId: null,
    points: 0,
    founded: { ti, kind: 'fictional' },
  };
  state.teams[id] = team;
  fillRosterFromMarket(state, id, CONFIG.ai.minRoster);
  autoLineup(state, id);
  if (!regular(state, id).length) {
    delete state.teams[id];
    return null;
  }
  return { teamId: id, kind: 'fictional', signed: [], skippedHuman: [] };
}

function foundingNews(state: GameState, info: FoundedClubInfo, ti: number): void {
  const team = state.teams[info.teamId];
  if (!team) return;
  const roster = regular(state, team.id).sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : 1));
  const coach = team.coachId ? state.coaches[team.coachId] : undefined;
  let body: string;
  if (info.kind === 'real') {
    const signed = info.signed.map((id) => state.players[id]).filter((p): p is Player => !!p);
    const others = roster.filter((p) => !info.signed.includes(p.id));
    body = `${team.name}（${team.tag}）宣布成立，将从 TI${ti} 赛季起征战职业联赛。`
      + (signed.length ? `首批签下 ${signed.map((p) => `${p.handle}（${playerTier(p)}）`).join('、')}。` : '')
      + (others.length ? `${others.map((p) => p.handle).join('、')} 同时加盟。` : '')
      + (coach ? `${coach.name} 出任主教练。` : '');
    if (info.skippedHuman.length) {
      const names = info.skippedHuman.map((id) => state.players[id]?.handle).filter(Boolean);
      if (names.length) body += `${names.join('、')} 目前效力于玩家战队，未被列入签约名单。`;
    }
  } else {
    body = `新组织 ${team.name}（${team.tag}）宣布成立，加入 ${team.region} 赛区，`
      + `首发阵容：${roster.slice(0, 5).map((p) => p.handle).join('、') || '—'}。`;
  }
  addNews(state, 'transfer', `【新战队】${team.name} 成立`, body, info.kind === 'real', {
    teamIds: [team.id],
    playerIds: roster.map((p) => p.id),
    tags: ['new-club', 'transfer'],
    noInfer: true,
  });
}

/**
 * 赛季初成立新俱乐部（season.startSeason：自主成长之后、新秀选秀之前；同一赛季只执行一次；新游戏第一个赛季不执行）。
 * 返回本次成立 / 解散汇总（未执行时 null）。
 */
export function foundSeasonClubs(state: GameState): ClubFoundingReport | null {
  const c = C();
  if (!c?.enabled || state.gameOver || !state.season) return null;
  const ti = state.season.ti;
  const startTi = state.settings?.startTi ?? ti;
  if (!(ti > startTi)) return null;
  const rec = clubFoundingState(state);
  if (rec.ti >= ti) return null;
  rec.ti = ti;
  const rng = rngOf(state);
  const { max } = leagueSizeRange();
  const report: ClubFoundingReport = { ti, founded: [], retired: [] };

  const cands = clubOrgs()
    .map((org) => ({ org, app: orgAppAt(org, ti) }))
    .filter((x): x is { org: ClubOrg; app: ClubApp } => !!x.app && !orgEverInSave(state, x.org))
    .map((x) => ({ ...x, prio: priorityOf(x.org, x.app), major: isMajor(x.org, x.app) }))
    .sort((a, b) => b.prio - a.prio || (a.org.id < b.org.id ? -1 : 1));

  let retiredLeft = Math.max(0, Math.floor(c.maxRetirePerSeason));
  let foundedReal = 0;
  for (const cand of cands) {
    if (foundedReal >= Math.max(0, Math.floor(c.maxRealPerSeason))) break;
    if (leagueSize(state) >= max) {
      if (!cand.major || retiredLeft <= 0) continue;
      const victim = retireCandidates(state, ti)[0];
      if (!victim) continue;
      retireClub(state, victim, ti);
      report.retired.push(victim.id);
      retiredLeft--;
    }
    const info = foundRealClub(state, cand.org, cand.app, ti, rng);
    report.founded.push(info);
    foundedReal++;
  }
  // 虚构新组织（偶尔，至多 1 个）：联赛未满时直接成立；已满时由一支过气的 AI 俱乐部让出席位（与真实俱乐部共用本赛季的解散名额，真实俱乐部优先）
  if (c.fictionalChance > 0 && rng.chance(c.fictionalChance)) {
    let room = leagueSize(state) < max;
    if (!room && retiredLeft > 0) {
      const victim = retireCandidates(state, ti)[0];
      if (victim) {
        retireClub(state, victim, ti);
        report.retired.push(victim.id);
        retiredLeft--;
        room = true;
      }
    }
    if (room) {
      const info = foundFictionalClub(state, ti, rng);
      if (info) report.founded.push(info);
    }
  }
  if (!report.founded.length) return report;
  // 新俱乐部的「上赛季排名」：插入到联赛排名表的中游偏后（round(规模 × rankShare)），其后的战队顺延一位，排名保持唯一
  // （选秀顺位 / 邀请 / 赞助的依据）
  const foundedIds = new Set(report.founded.map((f) => f.teamId));
  const table = activeTeams(state)
    .filter((t) => !foundedIds.has(t.id))
    .sort((a, b) => (a.lastSeasonRank ?? Infinity) - (b.lastSeasonRank ?? Infinity) || (a.id < b.id ? -1 : 1));
  for (const info of report.founded) {
    const t = state.teams[info.teamId];
    if (!t) continue;
    const at = clamp(Math.round((table.length + 1) * c.rankShare), 0, table.length);
    table.splice(at, 0, t);
  }
  table.forEach((t, i) => {
    t.lastSeasonRank = i + 1;
  });
  for (const info of report.founded) {
    rec.founded.push({ ti, teamId: info.teamId, kind: info.kind });
    foundingNews(state, info, ti);
  }
  return report;
}

/**
 * 选秀之后（season.startSeason：新秀选秀 → 本函数 → 休赛期转会潮）：本赛季成立的真实俱乐部再尝试签回当届名单中
 * 本届登场的真实新秀（被 AI 战队选中的付转会费求购，落选的直接签；被人类玩家选中的不动）。返回签下的选手 id。
 */
export function signFoundedClubRookies(state: GameState): string[] {
  const c = C();
  if (!c?.enabled || state.gameOver || !state.season) return [];
  const ti = state.season.ti;
  const rng = rngOf(state);
  const out: string[] = [];
  for (const team of activeTeams(state)) {
    if (team.founded?.ti !== ti || team.founded.kind !== 'real' || team.isPlayer) continue;
    const org = clubOrg(team.founded.orgId);
    const app = org ? orgAppAt(org, ti) : undefined;
    if (!app) continue;
    const signed: Player[] = [];
    const keep = new Set([...app.players, ...(org?.peak?.players ?? [])]);
    for (const pid of app.players) {
      const p = state.players[pid];
      if (!p || !p.isRookie || p.teamId === team.id) continue;
      if (trySignRealPlayer(state, team, p, rng, keep) === 'signed') signed.push(p);
    }
    if (!signed.length) continue;
    autoLineup(state, team.id);
    out.push(...signed.map((p) => p.id));
    addNews(
      state,
      'transfer',
      `【签约】${team.name} 签下 ${signed.map((p) => p.handle).join('、')}`,
      `新成立的 ${team.name} 签下本届登场的新秀 ${signed.map((p) => `${p.handle}（${playerTier(p)}）`).join('、')}。`,
      false,
      { teamIds: [team.id], playerIds: signed.map((p) => p.id), tags: ['transfer'], noInfer: true },
    );
  }
  return out;
}

/** 某战队是否为本局中途成立的俱乐部（界面展示用） */
export function foundingOf(state: GameState, teamId: string | null | undefined): Team['founded'] | null {
  return (teamId && ownEntry(state.teams, teamId)?.founded) || null;
}

// 供测试与界面：本赛季可成立（尚未进入本局）的真实组织
export function pendingRealClubs(state: GameState, ti: number): ClubOrg[] {
  return clubOrgs().filter((org) => !!orgAppAt(org, ti) && !orgEverInSave(state, org));
}

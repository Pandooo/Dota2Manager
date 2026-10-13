// 真实生涯位置同步与旧存档迁移（第十三波；查询与位置系数见 roles.ts）
//
// - syncSeasonRoles（season.startSeason，赛季自主成长之后、新俱乐部 / 选秀 / 转会之前）：当届有真实阵容数据的真实选手
//   把本位置切换到当届真实位置（数据缺失的届次——现实中已退役、未来赛季、空档——保留原位置）；全部真实选手（在役 / 禁赛）
//   按截至当届的真实生涯刷新副位置（副位置随届次增加，不含未来才担任的位置）；
//   AI 战队随即重新自动排阵；人类玩家战队保留经理的首发安排（阵容页标出非本位置首发），收到一条私有新闻并在总览「通知」中提示。
// - migrateRealRoles（读档 save.importSave / 多人房间载入 multi.migrateRoomState）：旧存档中的真实选手一次性同步到当届
//   （无当届数据取此前最近一届）的真实位置并按截至当届的真实生涯重算副位置，写入 GameState.roleDataVersion；
//   人类玩家战队收到一条修正汇总（只有本位置变化才通知）。
// 只修改 Player.position / Player.altPositions（多人模式随选手同步，无座位私有状态；人类玩家的通知路由到各自座位）；不消耗随机数。
import { CONFIG, POSITION_CN } from './config';
import { addNews, pushPopup } from './news';
import { playerTier, tierIndex } from './player';
import {
  ROLE_DATA_VERSION, realRoleExactAt, realRoleFor, realRoleHistory, refreshAltPositions, roleFit, roleFitText,
} from './roles';
import { humanTeamIds, inSeatOf, isHumanTeam } from './seat';
import { autoLineup } from './team';
import type { GameState, Player, Position } from './types';
import { POSITIONS } from './types';

/** 一次位置变化 */
export interface RoleChange {
  playerId: string;
  from: Position;
  to: Position;
  /** 变化时所在战队（自由选手为 null） */
  teamId: string | null;
}

/**
 * 把真实选手切到 pos（并按截至 ti 的真实生涯刷新副位置）。本位置变化记入 changes；本位置或副位置有变化的
 * 所在战队记入 touched（用于 AI 战队重新排阵）。
 */
function applyRole(p: Player, pos: Position | null, ti: number, changes: RoleChange[], touched: Set<string>): void {
  let changed = false;
  if (pos && POSITIONS.includes(pos) && pos !== p.position) {
    changes.push({ playerId: p.id, from: p.position, to: pos, teamId: p.teamId ?? null });
    p.position = pos;
    changed = true;
  }
  if (refreshAltPositions(p, ti)) changed = true;
  if (changed && p.teamId) touched.add(p.teamId);
}

/** 位置 / 副位置变化涉及的 AI 战队重新自动排阵（人类玩家战队保留经理的首发安排）；按战队 id 排序保证确定性 */
function relineAiTeams(state: GameState, touched: Set<string>): void {
  for (const tid of [...touched].sort()) {
    const t = state.teams[tid];
    if (!t || t.disbanded || t.isPlayer || isHumanTeam(state, tid)) continue;
    autoLineup(state, tid);
  }
}

/**
 * 新赛季：当届有真实位置数据的真实选手（在役 / 禁赛，含自由选手）同步本位置；全部真实选手按截至当届刷新副位置。
 * 返回本位置的变化。程序生成选手不变（没有副位置）。
 */
export function syncSeasonRoles(state: GameState): RoleChange[] {
  const ti = state.season?.ti;
  if (!Number.isFinite(ti)) return [];
  const changes: RoleChange[] = [];
  const touched = new Set<string>();
  for (const id in state.players) {
    const p = state.players[id];
    if (!p || !p.isReal || p.status === 'retired' || !realRoleHistory(p.id)) continue;
    applyRole(p, realRoleExactAt(p.id, ti as number), ti as number, changes, touched);
  }
  relineAiTeams(state, touched);
  if (changes.length) seasonRoleNews(state, changes);
  return changes;
}

/**
 * 旧存档迁移（幂等：roleDataVersion ≥ ROLE_DATA_VERSION 时直接返回 null）：真实选手（在役 / 禁赛）的本位置同步到当届
 * 真实位置（无当届数据取此前最近一届，本局中早于真实首届出现的取首届），按截至当届重算副位置；有变化的 AI 战队重新自动排阵；
 * 人类玩家战队各收到一条修正汇总（只列本位置变化）。返回本位置变化。
 */
export function migrateRealRoles(state: GameState): RoleChange[] | null {
  if (!state || typeof state !== 'object') return null;
  if (Number(state.roleDataVersion) >= ROLE_DATA_VERSION) return null;
  const ti = state.season?.ti ?? state.settings?.startTi;
  const changes: RoleChange[] = [];
  const touched = new Set<string>();
  if (Number.isFinite(ti)) {
    for (const id in state.players ?? {}) {
      const p = state.players[id];
      if (!p || typeof p !== 'object' || !p.isReal || p.status === 'retired' || !realRoleHistory(p.id)) continue;
      applyRole(p, realRoleFor(p.id, ti as number), ti as number, changes, touched);
    }
  }
  state.roleDataVersion = ROLE_DATA_VERSION;
  relineAiTeams(state, touched);
  if (changes.length) migrationNews(state, changes);
  return changes;
}

// ---------------------------------------------------------------------------
// 新闻（平实文案）
// ---------------------------------------------------------------------------

/** 「Miposhka 转型为五号位（原四号位，仍可打四号位）」；旧存档修正用「改为」 */
function changeText(state: GameState, c: RoleChange, verb = '转型为'): string {
  const p = state.players[c.playerId];
  const alt = (p?.altPositions ?? []).filter((q) => q !== c.to);
  const keep = alt.includes(c.from) ? `，仍可打${POSITION_CN[c.from]}` : '';
  return `${p?.handle ?? c.playerId} ${verb}${POSITION_CN[c.to]}（原${POSITION_CN[c.from]}${keep}）`;
}

/** 人类玩家战队中位置变化后不在本位置首发的队员：「Miposhka 目前首发四号位（四五号位互换 ×0.93）」 */
function lineupHints(state: GameState, teamId: string, ids: string[]): string[] {
  const team = state.teams[teamId];
  if (!team?.lineup) return [];
  const out: string[] = [];
  for (const pos of POSITIONS) {
    const pid = team.lineup[pos];
    if (!pid || !ids.includes(pid)) continue;
    const p = state.players[pid];
    if (!p || roleFit(p, pos) === 'main') continue;
    out.push(`${p.handle} 目前首发${POSITION_CN[pos]}（${roleFitText(p, pos)}）`);
  }
  return out;
}

/** 每支人类玩家战队一条私有通知 */
function humanRoleNews(state: GameState, changes: RoleChange[], kind: 'season' | 'migration'): Set<string> {
  const covered = new Set<string>();
  for (const teamId of humanTeamIds(state)) {
    const team = state.teams[teamId];
    if (!team || team.disbanded) continue;
    const mine = changes.filter((c) => {
      const p = state.players[c.playerId];
      return !!p && p.teamId === teamId && (team.playerIds ?? []).includes(p.id);
    });
    if (!mine.length) continue;
    for (const c of mine) covered.add(c.playerId);
    const ids = mine.map((c) => c.playerId);
    const hints = lineupHints(state, teamId, ids);
    const lead = kind === 'season'
      ? `根据真实生涯，本赛季起：${mine.map((c) => changeText(state, c)).join('；')}。`
      : `已按真实生涯数据修正队员的位置（旧存档中的位置沿用首次登场时的位置）：${mine.map((c) => changeText(state, c, '改为')).join('；')}。`;
    const tail = hints.length
      ? `首发安排没有自动调整：${hints.join('；')}，可在「阵容」中调整或使用自动排阵。`
      : '首发安排没有变化。';
    const title = kind === 'season'
      ? mine.length === 1
        ? `【位置调整】${state.players[mine[0].playerId]?.handle ?? mine[0].playerId} 转型为${POSITION_CN[mine[0].to]}（真实生涯）`
        : `【位置调整】${team.name} ${mine.length} 名队员调整位置（真实生涯）`
      : `【位置修正】${team.name} ${mine.length} 名队员的位置已按真实生涯修正`;
    addNews(state, kind === 'season' ? 'season' : 'system', title, lead + tail, true, {
      teamIds: [teamId],
      playerIds: ids,
      scope: 'mine',
      visibility: 'private',
      noInfer: true,
    });
    // 总览「通知」里也放一条（新闻列表里容易被淹没）；多人模式路由到该座位（不广播给其他座位）
    inSeatOf(state, teamId, () => pushPopup(state, { kind: 'message', title, body: lead + tail }));
  }
  return covered;
}

/** 新赛季：人类玩家战队私有通知 + 知名选手（AI 战队 / 自由选手，天梯 ≥ roleNewsMinTier）一条世界新闻 */
function seasonRoleNews(state: GameState, changes: RoleChange[]): void {
  const covered = humanRoleNews(state, changes, 'season');
  const minTier = tierIndex(CONFIG.team.roleNewsMinTier ?? 'S');
  const notable = changes.filter((c) => {
    if (covered.has(c.playerId)) return false;
    const p = state.players[c.playerId];
    return !!p && p.status === 'active' && tierIndex(playerTier(p)) >= minTier;
  });
  if (!notable.length) return;
  notable.sort((a, b) => tierIndex(playerTier(state.players[b.playerId])) - tierIndex(playerTier(state.players[a.playerId]))
    || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  const max = Math.max(1, Math.floor(CONFIG.team.roleNewsMaxNames ?? 8));
  const shown = notable.slice(0, max).map((c) => {
    const p = state.players[c.playerId];
    const team = p?.teamId ? state.teams[p.teamId] : undefined;
    return `${changeText(state, c)}${team ? `，${team.name}` : '，自由选手'}`;
  });
  const more = notable.length > max ? `等 ${notable.length} 人` : '';
  addNews(
    state,
    'season',
    `【位置调整】新赛季 ${notable.length} 名知名选手转型`,
    `根据真实生涯，以下选手本赛季起改打新位置：${shown.join('；')}${more ? `；${more}` : ''}。`,
    false,
    {
      teamIds: [...new Set(notable.map((c) => state.players[c.playerId]?.teamId).filter((x): x is string => !!x))],
      playerIds: notable.slice(0, max).map((c) => c.playerId),
      scope: 'world',
      visibility: 'public',
      noInfer: true,
    },
  );
}

/** 旧存档迁移：只通知人类玩家战队（AI 战队与自由选手的修正不发新闻） */
function migrationNews(state: GameState, changes: RoleChange[]): void {
  humanRoleNews(state, changes, 'migration');
}

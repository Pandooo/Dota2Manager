// 与真实选手同 id 的真实教练（v0.4.3 审查）
//
// 真实阵容数据里有人先当教练、后当选手（Ceb 在 TI6–TI7 执教 OG、TI8 重返赛场；Papita / StanKing / SVG 在 TI7 是教练、TI8 才作为新秀登场；
// Misha、DuBu、Mikasa 同理）。本局中这名教练已经存在（开局阵容 / 教练供给 / 新俱乐部聘请）时，他以选手身份进入本局之前按同一规则处理：
//   - 自由教练 → 删除教练记录（及引用它的待决事件）；
//   - 在 AI 战队执教 → 卸任并删除；opts.replace 时该 AI 战队随即从教练市场补签一名（ai.aiReplaceCoach，不消耗随机数）——
//     赛季初（AI 季前窗口之前）不必补签，AI 季前窗口照常聘请；
//   - 在人类玩家战队执教 → 不替玩家做决定：继续执教，选手暂不入场；玩家解除其主教练职务时随即入场（realEntry.realEntryAfterCoachRelease）。
// 用于：赛季初复出 / 新面孔与读档补录（realEntry.ts）、真实新秀生成（gacha.createRealRookie：抽中 / 第 1 回合前离池 / 卡池关闭）。
import { aiReplaceCoach } from './ai';
import { coachEmployer } from './realCareer';
import { isHumanTeam, removePendingDecisionsEverywhere } from './seat';
import type { GameState } from './types';
import { ownEntry } from './util';

export interface SameIdCoachOutcome {
  /** 与他同 id 的教练在人类玩家战队执教：不处理，选手暂不入场 */
  humanTeamId: string | null;
  /** 删除了与他同 id 的教练记录 */
  removed: boolean;
  /** 卸任主教练的 AI 战队 */
  leftTeamIds: string[];
  /** 卸任后 AI 战队随即补签的主教练 */
  replacements: { teamId: string; coachId: string; coachName: string }[];
}

/** 与 id 同名的教练在哪支人类玩家战队执教（没有 / 不在人类玩家战队执教时 null）。只读 */
export function sameIdHumanCoachTeam(state: GameState, id: string): string | null {
  const coach = ownEntry(state.coaches, id);
  if (!coach) return null;
  const team = coachEmployer(state, coach);
  return team && isHumanTeam(state, team.id) ? team.id : null;
}

/** 处理与 id 同名的真实教练（见文件头）。不消耗随机数 */
export function resolveSameIdCoach(state: GameState, id: string, opts: { replace: boolean }): SameIdCoachOutcome {
  const out: SameIdCoachOutcome = { humanTeamId: null, removed: false, leftTeamIds: [], replacements: [] };
  const coach = ownEntry(state.coaches, id);
  if (!coach) return out;
  const team = coachEmployer(state, coach);
  if (team && isHumanTeam(state, team.id)) {
    out.humanTeamId = team.id;
    return out;
  }
  if (team) out.leftTeamIds.push(team.id);
  delete state.coaches[id];
  out.removed = true;
  // 执教的 AI 战队与已解散战队残留的主教练引用；引用该教练的待决事件（全部座位）
  for (const tid in state.teams) if (state.teams[tid]?.coachId === id) state.teams[tid].coachId = null;
  removePendingDecisionsEverywhere(state, (d) => d.ctx?.coachId === id);
  if (opts.replace && team) {
    const c = aiReplaceCoach(state, team);
    if (c) out.replacements.push({ teamId: team.id, coachId: c.id, coachName: c.name });
  }
  return out;
}

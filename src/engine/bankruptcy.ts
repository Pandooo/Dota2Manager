// ============================================================================
// 破产（第十波 #1，用户需求 2026-10-10）
//
// 人类俱乐部（单机玩家 / 多人模式每个座位）在每个回合结算时检查资金（season.endRound：经常性收入、工资、
// 挂牌转会与曲线快照之后调用 checkBankruptcy）：
//   - 资金 < 0：连续为负的回合数 team.negativeFundsRounds + 1；资金 ≥ 0：清零（此前为负时发「资金回正」新闻）；
//   - 连续为负达到 CONFIG.bankruptcy.rounds 个回合，或负债（负资金的绝对值）超过
//     CONFIG.bankruptcy.debtWageRounds × 每回合工资（选手 + 教练，economy.roundWageBill；无工资时此条不适用）→ 破产；
//     工资取当前值与本轮连续为负期间（各回合结算时）最高值的较高者（Team.negativeFundsWageBill）：
//     负债期间裁员 / 解约降低工资不会让上限随之下降、反而立即触发破产；
//   - 资金为负但尚未破产 → 破产预警新闻「资金为负：再持续 N 回合将破产」；总览「待处理」用 bankruptcyStatus 显示倒计时。
// 破产：team.bankrupt（回合与触发规则）+ team.disbanded；生涯档案冻结（legacy.recordLegacyPartial，ending = 'bankrupt'）；
//   单机 → gameOver.reason = 'bankrupt'（专门结局 + 生涯总结）；
//   多人 → 该座位出局转观战（seat.eliminated），选手离队等收尾由 multi.processEliminations 统一处理，全部座位出局时游戏结束。
// AI 俱乐部不受影响（沿用 ai.ts 的抛售 / 降薪与 shuffle.ts 的罕见解散）。不使用随机数。
// ============================================================================
import type { BankruptcyRecord, GameState, Team } from './types';
import { CONFIG } from './config';
import { roundWageBill } from './economy';
import { addNews, pushPopup } from './news';
import { formatGold } from './util';
import { activeHumanIds, forEachSeat, inSeatOf, isHumanTeam, isMultiplayer, seatOf } from './seat';
import { legacyCareerSummary, recordLegacyPartial } from './legacy';

/** 奖金分成还能下调（高于下限；默认 50% 即下限，此时预警不再建议下调分成） */
function canCutPrizeShare(team: Team): boolean {
  const share = typeof team.prizeShare === 'number' && Number.isFinite(team.prizeShare) ? team.prizeShare : CONFIG.prizeShare.initial;
  return share > CONFIG.prizeShare.min + 1e-9;
}

/** 破产判定参数（CONFIG.bankruptcy，缺失 / 非法值时取默认） */
export function bankruptcyRules(): { rounds: number; debtWageRounds: number } {
  const c = (CONFIG as { bankruptcy?: { rounds?: number; debtWageRounds?: number } }).bankruptcy;
  const rounds = Number.isFinite(c?.rounds) && (c!.rounds as number) >= 1 ? Math.floor(c!.rounds as number) : 3;
  const debtWageRounds = Number.isFinite(c?.debtWageRounds) && (c!.debtWageRounds as number) > 0 ? (c!.debtWageRounds as number) : 6;
  return { rounds, debtWageRounds };
}

/** 某战队当前的破产状态（UI 只读查询；纯计算，不修改 state） */
export interface BankruptcyStatus {
  /** 当前资金 < 0 */
  negative: boolean;
  gold: number;
  /** 已连续为负的回合结算数 */
  negativeRounds: number;
  /** 连续为负的回合上限（CONFIG.bankruptcy.rounds） */
  limitRounds: number;
  /** 若资金持续为负，还剩几个回合结算会破产（含本回合；≥ 1） */
  roundsLeft: number;
  /** 负债（资金为负时的绝对值，否则 0） */
  debt: number;
  /** 每回合工资（选手 + 教练） */
  wageBill: number;
  /** 负债上限 = 每回合工资 × debtWageRounds；没有工资时为 null（此条不适用） */
  debtLimit: number | null;
  /** 当前负债已超过上限：本回合结算时仍超过将立即破产 */
  debtOver: boolean;
  /** 需要显示破产倒计时（资金为负，或连续为负的计数尚未清零） */
  warning: boolean;
  /** 已破产 */
  bankrupt: boolean;
}

function wageOf(state: GameState, teamId: string): number {
  try {
    const w = roundWageBill(state, teamId);
    return Number.isFinite(w) ? Math.max(0, Math.round(w)) : 0;
  } catch {
    return 0;
  }
}

function negRoundsOf(team: Team | undefined): number {
  const n = team?.negativeFundsRounds;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 本轮连续为负期间记录的最高每回合工资（未处于连续为负 / 旧存档时为 0） */
function streakWageOf(team: Team | undefined): number {
  if (negRoundsOf(team) <= 0) return 0;
  const w = team?.negativeFundsWageBill;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.round(w) : 0;
}

/**
 * 负债上限所依据的每回合工资：当前工资与本轮连续为负期间最高工资的较高者。
 * 负债期间裁员 / 解约（解约还要付补偿）会降低当前工资 —— 若上限随之下降，削减开支反而会立即触发破产。
 */
function limitWageOf(state: GameState, teamId: string): number {
  return Math.max(wageOf(state, teamId), streakWageOf(state.teams?.[teamId]));
}

/** 负债上限（每回合工资 × debtWageRounds；工资取当前与本轮连续为负期间最高值的较高者）；没有工资时 null */
export function debtLimitOf(state: GameState, teamId: string): number | null {
  const wage = limitWageOf(state, teamId);
  return wage > 0 ? Math.round(wage * bankruptcyRules().debtWageRounds) : null;
}

export function bankruptcyStatus(state: GameState, teamId: string): BankruptcyStatus {
  const team = state.teams?.[teamId];
  const { rounds } = bankruptcyRules();
  const gold = Number.isFinite(team?.gold) ? Math.round(team!.gold) : 0;
  const negative = gold < 0;
  const negativeRounds = negRoundsOf(team);
  const wageBill = team ? wageOf(state, teamId) : 0;
  const debt = negative ? -gold : 0;
  const debtLimit = team ? debtLimitOf(state, teamId) : null;
  return {
    negative,
    gold,
    negativeRounds,
    limitRounds: rounds,
    roundsLeft: Math.max(1, rounds - negativeRounds),
    debt,
    wageBill,
    debtLimit,
    debtOver: debtLimit !== null && debt > debtLimit,
    warning: !!team && !team.bankrupt && !team.disbanded && (negative || negativeRounds > 0),
    bankrupt: !!team?.bankrupt,
  };
}

/** 倒计时文案：「资金为负：再持续 N 回合将破产」 */
export function bankruptcyCountdownText(roundsLeft: number): string {
  return `资金为负：再持续 ${Math.max(1, Math.floor(roundsLeft))} 回合将破产`;
}

/** 破产原因的中文描述 */
export function bankruptcyReasonText(rec: Pick<BankruptcyRecord, 'rule' | 'gold' | 'wageBill' | 'negativeRounds'>): string {
  const { debtWageRounds } = bankruptcyRules();
  if (rec.rule === 'debt') {
    return `负债 ${formatGold(Math.abs(rec.gold))} 超过 ${debtWageRounds} 个回合的工资（${formatGold(rec.wageBill * debtWageRounds)}）`;
  }
  return `资金连续 ${rec.negativeRounds} 个回合为负（账上 ${formatGold(rec.gold)}）`;
}

/**
 * 回合结算时的破产检查（season.endRound 调用；多人模式在中性上下文调用，新闻写入各座位）。
 * 返回本次破产的战队 id。单机玩家破产时设置 gameOver，调用方应随即停止推进。
 */
export function checkBankruptcy(state: GameState): string[] {
  if (state.gameOver) return [];
  const { rounds } = bankruptcyRules();
  const out: string[] = [];
  for (const id of activeHumanIds(state)) {
    if (state.gameOver) break;
    const team = state.teams[id];
    if (!team || team.disbanded || team.bankrupt) continue;
    if (!Number.isFinite(team.gold)) team.gold = 0;
    const prev = negRoundsOf(team);
    if (team.gold >= 0) {
      delete team.negativeFundsWageBill;
      if (prev > 0) {
        delete team.negativeFundsRounds;
        inSeatOf(state, id, () => {
          addNews(
            state, 'finance', '资金回正，破产倒计时解除',
            `回合结算后账上资金 ${formatGold(team.gold)}，此前已连续 ${prev} 个回合为负。破产倒计时已解除。`,
            false, { teamIds: [id], noInfer: true, visibility: 'private', tags: ['bankruptcy'] },
          );
        });
      }
      continue;
    }
    const n = prev + 1;
    // 本轮连续为负期间的最高工资（负债上限不因裁员 / 解约而下降，见 limitWageOf）
    team.negativeFundsWageBill = Math.max(prev > 0 ? streakWageOf(team) : 0, wageOf(state, id));
    team.negativeFundsRounds = n;
    const limit = debtLimitOf(state, id);
    const rule: BankruptcyRecord['rule'] | null = n >= rounds ? 'rounds' : limit !== null && -team.gold > limit ? 'debt' : null;
    if (rule) {
      if (declareBankruptcy(state, id, rule)) out.push(id);
      continue;
    }
    const left = Math.max(1, rounds - n);
    inSeatOf(state, id, () => {
      addNews(
        state, 'finance', `【破产预警】${bankruptcyCountdownText(left)}`,
        `回合结算后账上资金 ${formatGold(team.gold)}，已连续 ${n} 个回合为负。`
          + `若资金再持续为负 ${left} 个回合，`
          + (limit !== null ? `或负债超过 ${bankruptcyRules().debtWageRounds} 个回合的工资（${formatGold(limit)}），` : '')
          + `俱乐部将宣告破产，执教生涯提前结束。建议尽快挂牌出售选手、${canCutPrizeShare(team) ? '下调奖金分成或' : ''}削减开支`
          + '（解约需支付补偿，会加重负债；负债上限按本轮负债期间的最高工资计算，不会因裁员而降低）。',
        true, { teamIds: [id], noInfer: true, visibility: 'private', tags: ['bankruptcy'] },
      );
    });
  }
  return out;
}

/**
 * 宣告一支人类俱乐部破产（checkBankruptcy 与测试使用）：记录 team.bankrupt、冻结生涯档案、标记解散，发布公开新闻；
 * 单机 → gameOver('bankrupt')；多人 → 该座位出局（观战），选手离队等收尾由 multi.processEliminations 处理。
 * 非人类战队、已解散或已破产时返回 false（幂等）。
 */
export function declareBankruptcy(state: GameState, teamId: string, rule: BankruptcyRecord['rule']): boolean {
  const team = state.teams[teamId];
  if (!team || team.disbanded || team.bankrupt || !isHumanTeam(state, teamId)) return false;
  const mp = isMultiplayer(state);
  const rec: BankruptcyRecord = {
    season: state.season?.ti ?? 0,
    round: state.roundIndex ?? 0,
    date: state.currentDate ?? '',
    rule,
    gold: Number.isFinite(team.gold) ? Math.round(team.gold) : 0,
    // 负债上限所依据的工资（当前与本轮连续为负期间最高值的较高者），与破产原因文案一致
    wageBill: limitWageOf(state, teamId),
    negativeRounds: negRoundsOf(team),
  };
  team.bankrupt = rec;
  // 生涯档案：先冻结截至当下的赛季（阵容在离队前记录；在该座位上下文中读取其私有的赛事结算 / 账目）
  try {
    inSeatOf(state, teamId, () => recordLegacyPartial(state, teamId, 'bankrupt'));
  } catch (e) {
    console.error('[engine] recordLegacyPartial', e);
  }
  team.disbanded = true;

  const seat = seatOf(state, teamId);
  const reason = bankruptcyReasonText(rec);
  const tail = mp ? `玩家「${seat?.name ?? team.name}」的执教就此终止，转为观战。` : '你执教的俱乐部就此画上句号。';
  addNews(
    state, 'system', `【破产】${team.name} 宣告破产`,
    `TI${rec.season} 赛季第 ${rec.round} 回合（${rec.date}），${team.name}（${team.tag}）${reason}，无力偿还债务，俱乐部宣告破产。${tail}`,
    true, { teamIds: [teamId], visibility: 'public', tags: ['bankruptcy', 'disband'], noInfer: true },
  );

  if (mp) {
    if (seat) {
      seat.eliminated = true;
      seat.ready = false;
      delete seat.autoReady;
    }
    // 其他仍在比赛中的玩家：回合通知
    forEachSeat(state, (me) => {
      if (me === teamId || state.gameOver) return;
      pushPopup(state, {
        kind: 'message', title: '玩家俱乐部破产',
        body: `${team.name}（${team.tag}）${reason}，宣告破产。玩家「${seat?.name ?? team.name}」出局。`,
      });
    });
  } else if (!state.gameOver) {
    let career = '';
    try {
      career = legacyCareerSummary(state, teamId, 'bankrupt');
    } catch (e) {
      console.error('[engine] legacyCareerSummary', e);
    }
    state.gameOver = {
      reason: 'bankrupt',
      summary: `${team.name} ${reason}，无力偿还债务，俱乐部宣告破产。${career ? `\n${career}` : ''}`,
    };
  }
  return true;
}

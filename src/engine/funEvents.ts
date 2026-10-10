// ============================================================================
// 无厘头搞笑事件（声明式事件表，梗由策划/玩家自行设定）
// 每个回合开始时由 events.rollRoundEvents 调用 rollFunEvents(state)：
// 以 CONFIG.events.funEventChancePerRound 概率，从满足条件的事件中按 weight 抽一个触发。
//
// 新增事件：在 FUN_EVENTS 数组里加一项即可，例如：
//   {
//     id: 'my_event',
//     weight: 5,
//     requirePlayerId: 'chalice',        // 可选：仅当该选手在玩家战队时触发，{player} 即为他
//     title: '标题，可用 {player} {team}',
//     body: '正文，可用 {player} {team}',
//     effects: { gold: -10000, honor: 5, teamPower: { pct: -0.02, rounds: 1 } },
//     // 可选：带选项（玩家在消息中心选择后才生效）
//     // choices: [{ id: 'a', label: '选项A', result: '结果文本', effects: { ... } }],
//   }
// ============================================================================
import type { GameState, OpResult, PendingDecision, Player, Team } from './types';
import { CONFIG } from './config';
import { rngOf } from './rng';
import { addNews } from './news';
import { formatGold, nextId } from './util';
import { addModifier, eventImpactScale } from './player';
import { getPlayerTeam, teamPlayers, lineupPlayers } from './team';
import { addFinance } from './economy';
import { changeHonor } from './honor';
import { adjustLoyalty } from './growth';

/** 事件效果（全部可选，可组合） */
export interface FunEffects {
  /** 金币变化（固定金额，不随年代缩放） */
  gold?: number;
  /** 荣誉变化 */
  honor?: number;
  /** 全队首发战斗力临时/永久变化：pct 为比例（-0.02 = -2%），rounds 为持续大回合数，null = 永久 */
  teamPower?: { pct: number; rounds: number | null };
  /** 主角选手（{player}）战斗力变化 */
  playerPower?: { pct: number; rounds: number | null };
  /** 全队归属感变化 */
  teamLoyalty?: number;
  /** 主角选手归属感变化 */
  playerLoyalty?: number;
  /** 主角选手基础属性永久变化 */
  playerInsight?: number;
  playerResilience?: number;
  playerMmr?: number;
}

export interface FunChoiceDef {
  id: string;
  label: string;
  result: string;
  effects: FunEffects;
}

export interface FunEventDef {
  id: string;
  weight: number;
  /** 仅当该选手（player id）在玩家战队时触发；不填则随机选一名首发作为 {player} */
  requirePlayerId?: string;
  title: string;
  body: string;
  effects?: FunEffects;
  choices?: FunChoiceDef[];
}

// ---------------------------------------------------------------------------
// 事件表
// ---------------------------------------------------------------------------
export const FUN_EVENTS: FunEventDef[] = [
  {
    id: 'chalice_tooth',
    weight: 10,
    requirePlayerId: 'chalice',
    title: '猪哥（Chalice）牙脱落事件',
    body: '猪哥（{player}）牙脱落，导致选手集体补牙。',
    effects: { gold: -10000 },
  },
];

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

function fill(text: string, p: Player, team: Team): string {
  return text.replace(/\{player\}/g, p.handle).replace(/\{team\}/g, team.name);
}

/** 应用效果，返回中文效果摘要 */
function applyEffects(state: GameState, team: Team, p: Player, fx: FunEffects | undefined, source: string): string[] {
  if (!fx) return [];
  const out: string[] = [];
  const starters = lineupPlayers(state, team.id).map((s) => s.player).filter((x): x is Player => !!x);
  const sign = (v: number) => (v > 0 ? '+' : '');
  const powerMod = (target: Player, pct: number, rounds: number | null) => {
    const v = pct < 0 ? pct * eventImpactScale(target) : pct;
    addModifier(state, target, { source, attr: 'power', kind: 'mul', value: 1 + v, roundsLeft: rounds });
  };
  const roundsText = (r: number | null) => (r ? `（${r}回合）` : '（永久）');

  if (fx.gold) {
    addFinance(state, team.id, fx.gold, 'event', source);
    out.push(`资金 ${sign(fx.gold)}${formatGold(fx.gold)}`);
  }
  if (fx.honor) {
    changeHonor(state, team.id, fx.honor, source);
    out.push(`荣誉 ${sign(fx.honor)}${fx.honor}`);
  }
  if (fx.teamPower) {
    for (const s of starters) powerMod(s, fx.teamPower.pct, fx.teamPower.rounds);
    out.push(`全队战斗力 ${sign(fx.teamPower.pct)}${Math.round(fx.teamPower.pct * 100)}%${roundsText(fx.teamPower.rounds)}`);
  }
  if (fx.playerPower) {
    powerMod(p, fx.playerPower.pct, fx.playerPower.rounds);
    out.push(`${p.handle} 战斗力 ${sign(fx.playerPower.pct)}${Math.round(fx.playerPower.pct * 100)}%${roundsText(fx.playerPower.rounds)}`);
  }
  if (fx.teamLoyalty) {
    for (const x of teamPlayers(state, team.id)) adjustLoyalty(x, fx.teamLoyalty);
    out.push(`全队归属感 ${sign(fx.teamLoyalty)}${fx.teamLoyalty}`);
  }
  if (fx.playerLoyalty) {
    adjustLoyalty(p, fx.playerLoyalty);
    out.push(`${p.handle} 归属感 ${sign(fx.playerLoyalty)}${fx.playerLoyalty}`);
  }
  const clampAttr = (v: number) => Math.max(0, Math.min(CONFIG.player.maxAttr, v));
  if (fx.playerInsight) {
    p.insight = clampAttr(p.insight + fx.playerInsight);
    out.push(`${p.handle} 灵性 ${sign(fx.playerInsight)}${fx.playerInsight}`);
  }
  if (fx.playerResilience) {
    p.resilience = clampAttr(p.resilience + fx.playerResilience);
    out.push(`${p.handle} 韧性 ${sign(fx.playerResilience)}${fx.playerResilience}`);
  }
  if (fx.playerMmr) {
    p.mmr = Math.max(CONFIG.ladder.minMmr, Math.min(CONFIG.ladder.maxMmr, Math.round(p.mmr + fx.playerMmr)));
    out.push(`${p.handle} 天梯 ${sign(fx.playerMmr)}${fx.playerMmr}`);
  }
  return out;
}

/** 每回合开始调用：按概率触发一个搞笑事件（玩家战队） */
export function rollFunEvents(state: GameState): void {
  if (state.gameOver || FUN_EVENTS.length === 0) return;
  const rng = rngOf(state);
  if (!rng.chance(CONFIG.events.funEventChancePerRound)) return;

  const team = getPlayerTeam(state);
  const players = teamPlayers(state, team.id);
  if (players.length === 0) return;
  const starters = lineupPlayers(state, team.id).map((s) => s.player).filter((x): x is Player => !!x);
  const pool = starters.length ? starters : players;

  // 满足条件的事件及其主角
  const candidates: { def: FunEventDef; p: Player }[] = [];
  for (const def of FUN_EVENTS) {
    if (def.requirePlayerId) {
      const p = players.find((x) => x.id === def.requirePlayerId);
      if (p) candidates.push({ def, p });
    } else {
      candidates.push({ def, p: rng.pick(pool) });
    }
  }
  if (candidates.length === 0) return;
  const { def, p } = rng.weighted(candidates, candidates.map((c) => c.def.weight));
  const title = fill(def.title, p, team);
  const body = fill(def.body, p, team);

  if (def.choices && def.choices.length) {
    const decision: PendingDecision = {
      id: nextId(state, 'd'),
      kind: 'other',
      title,
      body,
      choices: def.choices.map((c) => ({ id: c.id, label: c.label })),
      ctx: { fun: def.id, playerId: p.id },
      createdRound: state.roundIndex,
      blocking: true,
    };
    state.pendingDecisions.push(decision);
    addNews(state, 'event', title, `${body}\n（请在消息中心做出选择）`, true);
    return;
  }

  const effects = applyEffects(state, team, p, def.effects, title);
  addNews(state, 'event', title, effects.length ? `${body}\n\n影响：${effects.join('，')}` : body, true);
}

/** 处理带选项的搞笑事件（由 events.resolveDecision 在 decision.ctx.fun 存在时调用） */
export function resolveFunDecision(state: GameState, decision: PendingDecision, choiceId: string): OpResult {
  state.pendingDecisions = state.pendingDecisions.filter((d) => d.id !== decision.id);
  const def = FUN_EVENTS.find((d) => d.id === decision.ctx.fun);
  const choice = def?.choices?.find((c) => c.id === choiceId);
  if (!def || !choice) return { ok: false, message: '该事件已失效' };
  const team = getPlayerTeam(state);
  const pid = decision.ctx.playerId;
  const p = (typeof pid === 'string' && state.players[pid]) || teamPlayers(state, team.id)[0];
  if (!p) return { ok: true, message: '事件已结束' };
  const result = fill(choice.result, p, team);
  const effects = applyEffects(state, team, p, choice.effects, decision.title);
  addNews(state, 'event', `${decision.title} · ${choice.label}`, effects.length ? `${result}\n\n影响：${effects.join('，')}` : result);
  return { ok: true, message: result };
}

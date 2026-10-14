// ============================================================================
// UI 便捷操作：把界面里原先写在 act(g => { ... }) 回调中的小段逻辑收拢为具名引擎函数，
// 以便 UI 统一通过 call('fnName', ...args) 调用——单机本地执行，多人模式作为白名单 RPC 发给服务器
// （服务器在调用者座位上下文中执行，settings.playerTeamId = 调用者战队）。
// 行为与原先 UI 回调完全一致（同样的状态修改与提示文案）。新增函数需同时加入 src/shared/protocol.ts 的 RPC_WHITELIST。
// ============================================================================
import type { GameState, OpResult } from './types';
import { POSITION_LABEL } from './config';
import { dismissPopup, h2hDraftPending, playGame, startDraft } from './game';
import { autoLineup, setLineupSlot, teamRating } from './team';
import { talkToPlayer } from './squadOps';
import { ownEntry } from './util';

/** 标记一条新闻为已读 */
export function markNewsRead(state: GameState, newsId: string): void {
  const item = state.news.find((x) => x.id === newsId);
  if (item) item.read = true;
}

/** 关闭弹窗队列最前面的 count 个（连续的版本更新弹窗合并展示，关闭时一起移除） */
export function dismissPopups(state: GameState, count: number): void {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  for (let i = 0; i < n && state.popups.length; i++) dismissPopup(state);
}

/** 把本队选手设为其本位置首发（与该位置原首发互换） */
export function setPlayerAsStarter(state: GameState, playerId: string): OpResult {
  const me = state.settings.playerTeamId;
  const p = ownEntry(state.players, playerId);
  if (!p) return { ok: false, message: '找不到该选手' };
  setLineupSlot(state, me, p.position, p.id);
  const done = state.teams[me]?.lineup?.[p.position] === p.id;
  return done
    ? { ok: true, message: `${p.handle} 已设为${POSITION_LABEL[p.position]}首发` }
    : { ok: false, message: `无法将 ${p.handle} 设为首发` };
}

/** 一对一谈心：谈心已进行但未成功时引擎返回 ok=true（操作有效），这里转为 ok=false 以「未成功」样式提示 */
export function talkWithPlayer(state: GameState, playerId: string): OpResult {
  const r = talkToPlayer(state, playerId);
  return r.ok && r.success === false ? { ok: false, message: r.message } : r;
}

/** 自动 BP 后直接开打（大老师胜率 + 文字直播），省去一次确认 */
export function autoDraftAndPlay(state: GameState): OpResult {
  const r = startDraft(state, false);
  if (!r.ok) return r;
  // 多人玩家对决：对手仍在手动 BP（或尚未选择方式）时只登记自动 BP，BP 完成后任一方开始本局（不算失败）
  if (h2hDraftPending(state)) return r;
  return playGame(state);
}

/** 自动排阵（本队），返回排阵前后的战队评分 */
export function autoArrangeLineup(state: GameState, tournamentId: string | null): OpResult {
  const me = state.settings.playerTeamId;
  const before = teamRating(state, me);
  autoLineup(state, me, tournamentId ?? null);
  const after = teamRating(state, me);
  return { ok: true, message: `已自动排阵：战队评分 ${before.toFixed(1)} → ${after.toFixed(1)}` };
}

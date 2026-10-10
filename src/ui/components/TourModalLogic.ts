// ============================================================================
// 总览赛事卡片（TournamentCard，内嵌在「本回合」中、可展开）的纯逻辑：本回合的玩家赛事、关注进度、自动展开判定。
// 不依赖 React / store（store/gameStore.ts 的 syncTournamentCard 与 tests/tournamentModal.test.ts 直接导入），
// 只读游戏状态（单机状态或多人座位视图），不修改任何引擎数据。
//
// 自动展开规则：每进入一个新回合（tourRoundKeyOf 变化）判定一次——本方在本回合的赛事仍有比赛要打（focus.actionable）
// 时展开，否则收起；回合内由玩家自行收起 / 展开。不弹窗、不切换页面，因此不再需要「已看过」记录或等待通知 / TI 转场。
// ============================================================================
import type { GameState, Series, Tournament } from '../../engine/types';
import { currentPlayerTournament, isTeamEliminated, playerNextSeries, playerTournamentInRound } from '../../engine';

/** 赛事实际没有进行（参赛队不足被取消 / 预选全部直通）：对玩家而言是休赛回合 */
function neverPlayed(t: Tournament): boolean {
  return t.status === 'finished' && !(t.placements?.length) && !(t.stages?.length);
}

function inEvent(t: Tournament, me: string): boolean {
  return (t.teamIds ?? []).includes(me) || (t.qualifierTeamIds ?? []).includes(me);
}

/**
 * 本回合玩家的赛事（含已结束的；进行中的比赛优先）。休赛 / 观赛回合、赛季初与赛季结算为 null。
 * 与总览「本回合」里的赛事卡片、底栏「赛事面板」入口共用同一判定。
 */
export function roundTournamentOf(game: GameState | null | undefined): Tournament | null {
  if (!game || !game.season || game.phase === 'preseason' || game.phase === 'season_end') return null;
  const me = game.settings?.playerTeamId ?? '';
  const am = game.activeMatch;
  if (am) {
    const t = game.tournaments?.[am.tournamentId];
    if (t) return t;
  }
  const cur = currentPlayerTournament(game);
  if (cur) return cur;
  const t = playerTournamentInRound(game, game.roundIndex);
  if (t && t.playerStatus !== 'declined') return neverPlayed(t) ? null : t;
  for (const id of game.season.rounds?.[game.roundIndex]?.tournamentIds ?? []) {
    const x = game.tournaments?.[id];
    if (!x || x.season !== game.season.ti || x.playerStatus === 'declined') continue;
    if (inEvent(x, me)) return neverPlayed(x) ? null : x;
  }
  return null;
}

/** 本方在该赛事已出结果的系列赛（按阶段、轮次先后排序） */
export function mySeriesResults(t: Tournament, me: string): Series[] {
  const stageIdx = (s: Series) => (t.stages ?? []).findIndex((st) => st.id === s.stageId);
  return Object.values(t.series ?? {})
    .filter((s) => !!s.result && (s.teamA === me || s.teamB === me))
    .sort((a, b) => stageIdx(a) - stageIdx(b) || a.round - b.round);
}

/** 多人：本座位已出局（战队解散 / 全员假赛除名），只能观战 */
export function seatSpectating(game: GameState): boolean {
  const me = game.settings?.playerTeamId ?? '';
  return !!game.multiplayer?.seats?.[me]?.eliminated || !!game.teams?.[me]?.disbanded;
}

export interface TourModalFocus {
  /** 关注键：存档 × 座位 × 赛季 × 回合 × 赛事 */
  key: string;
  /** 进度签名：本方已完成的系列赛数 + 下一场系列赛（未确定为 '-'） */
  sig: string;
  tournamentId: string;
  /** 本方在本赛事仍有比赛要打（进行中、未出局或比赛进行中、非观战、游戏未结束） */
  actionable: boolean;
}

/** 赛事卡片关注的赛事与进度签名；本回合没有玩家赛事时为 null */
export function tourModalFocus(game: GameState | null | undefined): TourModalFocus | null {
  const t = roundTournamentOf(game);
  if (!game || !t) return null;
  const me = game.settings?.playerTeamId ?? '';
  const running = t.status === 'running';
  const next = running ? playerNextSeries(game, t.id) : null;
  const eliminated = running ? isTeamEliminated(game, t.id, me) : true;
  const done = mySeriesResults(t, me).length;
  const live = !!game.activeMatch && game.activeMatch.tournamentId === t.id;
  const actionable = !game.gameOver && !seatSpectating(game) && running && inEvent(t, me) && (!eliminated || live);
  const gid = `${game.id ?? ''}@${game.createdAt ?? ''}`;
  return {
    key: `${gid}|${me}|ti${game.season?.ti ?? 0}|r${game.roundIndex}|${t.id}`,
    sig: `${done}|${next?.id ?? '-'}`,
    tournamentId: t.id,
    actionable,
  };
}

/** 回合标识：存档（id + 创建时间）× 座位战队 × 赛季 × 回合。变化时重新判定赛事卡片是否展开 */
export function tourRoundKeyOf(game: GameState): string {
  return `${game.id ?? ''}@${game.createdAt ?? ''}|${game.settings?.playerTeamId ?? ''}|ti${game.season?.ti ?? 0}|r${game.roundIndex}`;
}

/** 纯函数：新回合开始时赛事卡片是否自动展开（本方在本回合的赛事仍有比赛要打） */
export function tourCardAutoExpand(focus: TourModalFocus | null | undefined): boolean {
  return !!focus?.actionable;
}

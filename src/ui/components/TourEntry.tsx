// ============================================================================
// 赛事报名状态标签 + 报名/取消报名按钮（赛程页与赛事中心共用）
// ============================================================================
import type { ReactNode } from 'react';
import type { GameState, PlayerEntryStatus, Tournament, TournamentPlacement } from '../../engine/types';
import { REGION_LABEL, computePlayerEntryStatus, formatRank } from '../../engine';
import type { useGameStore } from '../../store/gameStore';
import { getTiInfo } from '../../data/index';
import { Badge, Button } from './common';
import { ENTRY_STATUS_CLASS, ENTRY_STATUS_LABEL, openTournamentView, rankClass, safe, teamPlacement } from './TourShared';

/** store.call（报名 / 取消报名经 call 调用引擎：单机本地执行，多人发给服务器） */
type Call = ReturnType<typeof useGameStore.getState>['call'];

export interface EntryControls {
  status: PlayerEntryStatus;
  /** 玩家已受邀/已报名/在参赛名单中 */
  mine: boolean;
  /** 玩家在正赛或封闭预选名单中 */
  inEvent: boolean;
  /** 玩家在该赛事的最终名次（已结束且参加过） */
  placement?: TournamentPlacement;
  chip: ReactNode;
  action: ReactNode;
}

/** 同回合的其他赛事（用于「每回合最多一项」冲突判定） */
export function sameRoundTournaments(game: GameState, t: Tournament): Tournament[] {
  const ids = new Set(game.season?.rounds?.[t.roundIndex]?.tournamentIds ?? []);
  for (const x of Object.values(game.tournaments)) if (x.season === t.season && x.roundIndex === t.roundIndex) ids.add(x.id);
  return Array.from(ids)
    .map((id) => game.tournaments[id])
    .filter((x): x is Tournament => !!x && x.season === t.season);
}

/** 玩家视角的报名状态（invited/registered/declined 以存档为准，其余按当前荣誉实时计算） */
export function entryStatusOf(game: GameState, t: Tournament): PlayerEntryStatus {
  if (t.playerStatus === 'invited' || t.playerStatus === 'registered' || t.playerStatus === 'declined') return t.playerStatus;
  return safe(() => computePlayerEntryStatus(game, t), t.playerStatus ?? 'open');
}

/** 是否为 TI 赛区预选赛 */
export function isTiQualifierEvent(t: Tournament): boolean {
  return !!t.advanceToTi || t.id.startsWith('tiq-');
}

/** 玩家是否仍在本赛季某项未结束的 TI 赛区预选赛中（TI 资格待定） */
function inUnfinishedTiQualifier(game: GameState, season: number, me: string): boolean {
  return Object.values(game.tournaments).some(
    (q) => q.season === season && isTiQualifierEvent(q) && q.status !== 'finished'
      && ((q.teamIds ?? []).includes(me) || q.playerStatus === 'invited'),
  );
}

const MUTED = 'bg-panel-3 text-faint border border-line';
const MANDATORY_TITLE = 'TI 与 TI 赛区预选赛为赛季收官赛事，必须参加，不可婉拒';

export function entryControls(
  game: GameState,
  t: Tournament,
  call: Call,
  opts: { siblings?: Tournament[]; directInvites?: number; size?: 'xs' | 'sm'; inCenter?: boolean } = {},
): EntryControls {
  const me = game.settings.playerTeamId;
  const myTeam = game.teams[me];
  const size = opts.size ?? 'xs';
  const isTi = t.tier === 'ti';
  const isTiQual = isTiQualifierEvent(t);
  const inEvent = (t.teamIds ?? []).includes(me) || (t.qualifierTeamIds ?? []).includes(me);
  const status = entryStatusOf(game, t);
  const mine = status === 'invited' || status === 'registered' || inEvent;
  const placement = t.status === 'finished' ? teamPlacement(t, me) : undefined;
  const directInvites = opts.directInvites ?? safe(() => getTiInfo(t.season).directInvites, 0);
  const siblings = opts.siblings ?? sameRoundTournaments(game, t);

  const editable = t.status === 'scheduled' && t.season === game.season.ti && t.roundIndex > game.roundIndex;
  const notEditableReason =
    t.status === 'running' ? '赛事进行中，无法修改报名' : t.status === 'finished' ? '赛事已结束' : '该回合已开始，无法修改报名';
  const conflict = siblings.find(
    (x) => x.id !== t.id && x.status !== 'finished' && (x.playerStatus === 'invited' || x.playerStatus === 'registered'),
  );
  const conflictReason = conflict
    ? `本回合已${conflict.playerStatus === 'invited' ? '受邀参加' : '报名'}「${conflict.name}」（每回合最多一项赛事），`
      + `需先${conflict.playerStatus === 'invited' ? '婉拒该邀请' : '取消该报名'}`
    : '';
  /** 玩家在本赛事的受邀名单中（婉拒后仍在名单里，可重新接受） */
  const onInviteList = (t.invitedTeamIds ?? []).includes(me);

  const regionBlocked = !!t.regionLocked && !!myTeam && myTeam.region !== t.regionLocked;
  const lockText = regionBlocked ? `仅限${REGION_LABEL[t.regionLocked!]}赛区` : `荣誉不足（需 ${t.minHonor}）`;
  const lockTitle = regionBlocked
    ? `本赛事仅限${REGION_LABEL[t.regionLocked!]}赛区战队参加`
    : `荣誉不足：需要 ${t.minHonor}，当前 ${Math.round(myTeam?.honor ?? 0)}`;

  // ---- 状态标签 ----
  let chip: ReactNode;
  if (t.status === 'finished') {
    chip = placement ? (
      <Badge className="bg-panel-3 border border-line">
        我的名次 <span className={`ml-1 ${rankClass(placement.rankFrom)}`}>{formatRank(placement.rankFrom, placement.rankTo)}</span>
      </Badge>
    ) : (
      <Badge className={MUTED}>{mine ? '已结束' : '未参加'}</Badge>
    );
  } else if (isTi) {
    const directed = (t.invitedTeamIds ?? []).includes(me);
    if (directed)
      chip = (
        <Badge className={ENTRY_STATUS_CLASS.invited} title={MANDATORY_TITLE}>
          已获直邀·必须参加
        </Badge>
      );
    else if (inEvent || t.playerStatus === 'invited')
      chip = (
        <Badge className={ENTRY_STATUS_CLASS.registered} title={MANDATORY_TITLE}>
          预选晋级·必须参加
        </Badge>
      );
    else if (t.status === 'scheduled' && game.season.ti === t.season && game.roundIndex < t.roundIndex - 1)
      chip = (
        <Badge className="bg-panel-3 text-mute border border-line" title="赛季积分榜前列直邀，其余通过赛区预选赛晋级">
          积分前 {directInvites || 'N'} 名直邀
        </Badge>
      );
    else if (t.status === 'scheduled' && inUnfinishedTiQualifier(game, t.season, me))
      chip = (
        <Badge className={ENTRY_STATUS_CLASS.open} title="正在参加 TI 赛区预选赛，晋级即获得 TI 参赛资格（必须参加）">
          预选进行中
        </Badge>
      );
    else chip = <Badge className={MUTED}>未获参赛资格</Badge>;
  } else if (isTiQual) {
    const tiT = t.advanceToTi ? game.tournaments[t.advanceToTi.tiId] : undefined;
    if (mine) {
      chip = t.status === 'running' ? (
        <Badge className={ENTRY_STATUS_CLASS.registered}>参赛中</Badge>
      ) : (
        <Badge className={ENTRY_STATUS_CLASS.invited} title={`未获 TI 直邀，必须参加所在赛区预选。${MANDATORY_TITLE}`}>
          预选·必须参加
        </Badge>
      );
    } else if (tiT?.invitedTeamIds?.includes(me)) {
      chip = <Badge className={MUTED}>已获 TI 直邀</Badge>;
    } else if (regionBlocked) {
      chip = <Badge className={MUTED}>{REGION_LABEL[t.regionLocked!]}赛区预选</Badge>;
    } else {
      chip = <Badge className={MUTED}>未参加</Badge>;
    }
  } else if (t.status === 'running') {
    chip = mine ? <Badge className={ENTRY_STATUS_CLASS.registered}>参赛中</Badge> : <Badge className={MUTED}>未参加</Badge>;
  } else if (status === 'locked') {
    chip = (
      <Badge className={ENTRY_STATUS_CLASS.locked} title={lockTitle}>
        {lockText}
      </Badge>
    );
  } else {
    chip = (
      <Badge
        className={ENTRY_STATUS_CLASS[status]}
        title={
          status === 'declined'
            ? onInviteList
              ? '已婉拒邀请（无荣誉惩罚，空出的席位由其他战队递补）。开赛前可重新接受，前提是本回合未参加其他赛事'
              : '已放弃本赛事'
            : status === 'invited'
              ? '受邀直接进入正赛。开赛前可婉拒（无荣誉惩罚），空出的席位由其他战队递补；婉拒后仍可重新接受'
              : status === 'registered' && !onInviteList
                ? '未获直邀：开赛时需先打封闭预选赛争夺正赛席位'
                : undefined
        }
      >
        {ENTRY_STATUS_LABEL[status]}
      </Badge>
    );
  }

  // ---- 操作按钮 ----
  const run = (fn: 'registerForTournament' | 'unregisterFromTournament') => void call(fn, t.id);
  let action: ReactNode = null;
  if (!isTi && !isTiQual && t.status === 'scheduled') {
    if (status === 'registered') {
      action = (
        <Button
          size={size}
          variant="danger"
          disabled={!editable}
          title={editable ? '取消报名，该回合将变为休赛回合' : notEditableReason}
          onClick={() => run('unregisterFromTournament')}
        >
          取消报名
        </Button>
      );
    } else if (status === 'invited') {
      action = (
        <Button
          size={size}
          variant="danger"
          disabled={!editable}
          title={editable ? '婉拒邀请：无荣誉惩罚，空出的席位由其他战队递补；开赛前可重新接受' : notEditableReason}
          onClick={() => run('unregisterFromTournament')}
        >
          婉拒
        </Button>
      );
    } else if (status === 'open') {
      const reason = !editable ? notEditableReason : conflictReason;
      action = (
        <Button
          size={size}
          variant="primary"
          disabled={!!reason}
          title={reason || '报名参加本赛事（未获直邀的战队需先打封闭预选赛争夺正赛席位）'}
          onClick={() => run('registerForTournament')}
        >
          报名
        </Button>
      );
    } else if (status === 'locked') {
      action = (
        <Button size={size} disabled title={lockTitle}>
          报名
        </Button>
      );
    } else if (status === 'declined') {
      const reason = !editable ? notEditableReason : conflictReason;
      action = (
        <Button
          size={size}
          variant={onInviteList ? 'gold' : 'primary'}
          disabled={!!reason}
          title={reason || (onInviteList ? '重新接受邀请，以受邀身份直接进入正赛' : '重新报名本赛事（需先打封闭预选赛）')}
          onClick={() => run('registerForTournament')}
        >
          {onInviteList ? '重新接受' : '报名'}
        </Button>
      );
    }
  } else if ((isTi || isTiQual) && t.status === 'scheduled' && mine) {
    action = (
      <Button size={size} variant="ghost" disabled title={MANDATORY_TITLE}>
        婉拒
      </Button>
    );
  }
  if (t.status === 'running' && !opts.inCenter) {
    action = (
      <Button size={size} variant={inEvent ? 'gold' : 'secondary'} onClick={() => openTournamentView(game, t.id)}>
        {inEvent ? '前往比赛' : '观看'}
      </Button>
    );
  }

  return { status, mine, inEvent, placement, chip, action };
}

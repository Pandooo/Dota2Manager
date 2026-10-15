// 底部吸附操作栏（控制中心）：占满一整行，主按钮居中，永远是「回合推进」（开始赛季 / 下一回合 / TI 结算）。
// 懒人玩法（store.lazyAdvance，默认开启）：主按钮不被阻塞挡住——按下后引擎先自动处理本回合的事务（默认处理待决事件、
// 补齐首发、快速模拟本方剩余比赛，见 engine/autoRound.ts）再推进，右侧提示显示 previewAutoActions 的预览
// （如「将自动：快速模拟 2 场比赛 · 默认处理 1 个事件」）。关闭后与以前一样：有阻塞时主按钮禁用并在右侧说明原因。
// 主按钮两侧是本回合的情境操作（紧凑、不切换页面）：
//   休赛回合：训练（含焦点切换）/ 加练（价格）/ 训练赛（推荐对手气泡）/ 训练详情（展开总览训练卡片）；
//   赛事回合：快速模拟本场 / 快速模拟整项赛事（就近确认）/ 进入比赛 · 手动 BP / 赛事详情（展开总览赛事卡片）；
//   待决事件：徽标按钮（展开总览「待处理」）；比赛进行中：继续比赛；首发凑不齐：补齐首发 / 弃权本场。
// ≥1280px 保持一行；更窄时次要按钮收进「更多」气泡；按钮多到某一栏放不下时（按实际宽度测量，见 BarRow）按 demote 顺序
// 继续收进「更多」，不会压住主按钮。左侧为本回合信息与「自动处理」开关（tooltip 说明自动处理内容）。
// 多人模式：主按钮为「准备进入下一回合（n/m）」/「取消准备」，开启自动处理时为自动准备（服务器先自动处理再准备），
// 全员准备后服务器推进回合。在比赛页且比赛进行中时不渲染（比赛页自带 MatchDock 底栏，避免两条底栏）。
// 手机（< 640px，v0.4，docs/UI.md「手机适配 · 底栏」）：PhoneBar 三行——一行提示（右侧提示，没有时为回合信息；点按展开全文）、
// 可横向滑动的情境操作条（紧凑写法）、底行「自动」开关 + 通栏主按钮 + 「更多」（次要操作）；气泡改为底栏上方的通栏抽屉。
// sm–lg 之间在操作行上方补一行提示（BarRow 的提示与回合信息 lg 起才显示）。底栏高度写入 CSS 变量 --chrome-bottom（含安全区）。
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { mpHumanTeamIds, useCall, useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import {
  POSITION_CN, currentPlayerTournament, formatGold, getAdvanceBlockers, isAvailable, playerNextSeries, previewAutoActions,
  rosterOverflowNotice, roundKindForPlayer, teamPlayers, trainingSessionsLeft,
  type AutoRoundPreview, type GameState, type PendingDecision, type TrainingFocus,
} from '../../engine';
import { defaultDecisionChoice } from '../../engine/events';
import { Button, Gold, TeamTag, cx } from '../components/common';
import { showTouchTip } from '../components/TouchTip';
import { useChromeVar, useCoarsePointer, useIsPhone } from '../mobile';
import { ConfirmButton, type ConfirmSpec } from '../components/ConfirmPopover';
import { TiBarGlow } from '../components/TiTransition';
import { roundTournamentOf } from '../components/TourModalLogic';
import { GACHA_FOCUS_EVENT } from '../components/gachaDiscard';
import {
  FOCUS_INFO, FOCUS_ORDER, SCRIM_BOOKED_LABEL, scrimMultTone, scrimOptions, scrimReason, scrimRuleText, suggestedScrims, trainingStatus,
  type TrainingStatus,
} from '../components/TrainingShared';
import { isRoomHost } from '../../shared/protocol';

const KIND_LABEL: Record<string, string> = {
  preseason: '赛季初',
  rest: '休赛回合',
  tournament: '赛事回合',
  ti_qualifier: 'TI 预选赛',
  ti: 'TI 正赛',
  ti_watch: 'TI（观赛）',
};

/** 训练赛气泡里推荐的对手数 */
const SCRIM_SUGGEST = 5;

/** 「自动处理」开关的说明（tooltip） */
const LAZY_TIP =
  '下一回合自动处理（懒人模式）：开启后直接点「下一回合」即可——先按保守默认处理本回合挡住推进的事务再推进：'
  + '待决事件按默认选项处理（配合调查 / 低调处理 / 替补顶上 / 尝试挽留 / 拒绝报价 / 续约 1 赛季等）；'
  + '抽卡后阵容超过绝对上限（超编）时先退回本回合抽到的新秀中评分最低者（返还部分费用），仍超编再解约替补中代价（解约补偿 + 身价）最低者；'
  + '转会窗口开放期间，正式阵容缺位置或不足 5 人时签下负担得起、愿意加盟的自由选手补位（优先签下后收入仍付得起工资的人选；本回合因事件离队的不签回；不自动抽卡）；'
  + '首发不合法时自动补位，可出场不足 5 人时招募负担得起的临时替补；本方本回合剩余比赛快速模拟（自动 BP、跳过直播）。'
  + '未用完的训练本来就会在回合结束时按当前焦点自动完成。处理结果记入消息中心「本回合自动处理」。'
  + '\n多人模式下「准备」同样先自动处理，能准备时自动准备。'
  + '\n关闭后需逐项处理，阻塞未清除时不能推进。设置保存在本浏览器。';
/** 触屏上切换「自动处理」时的说明（没有悬停，完整说明 LAZY_TIP 看不到） */
const LAZY_ON_TIP = '已开启自动处理：点主按钮时先按默认选项处理本回合挡住推进的事务（待决事件、首发、本方比赛等）再推进，处理结果记入消息中心「本回合自动处理」。';
const LAZY_OFF_TIP = '已关闭自动处理：需逐项处理本回合的事务，阻塞未清除时不能推进。';

interface Main {
  label: string;
  /** 手机上的短写法（多人「准备（1/2）」，动词放进小字） */
  short?: string;
  /** 主按钮里的小字（开启自动处理时为「将自动：…」的事项） */
  sub?: string;
  onClick: () => void;
  variant: 'primary' | 'gold';
  /** 禁用原因（观战 / 有阻塞且未开启自动处理等） */
  disabled?: string;
  hint?: ReactNode;
  /** 提示是警示色（阻塞 / 无法推进） */
  hintBad?: boolean;
  title?: string;
}

interface LazyHint {
  hint?: ReactNode;
  bad?: boolean;
}

/** 情境操作：side = 主按钮左 / 右；secondary = 窄屏（<1280px）收进「更多」 */
interface CtxAction {
  key: string;
  side: 'left' | 'right';
  secondary?: boolean;
  /**
   * 放不下时收进「更多」的顺序（越小越先收起；缺省 = 永不收起）。底栏按实际宽度测量：
   * 某一侧的按钮超出自己那一栏时按 demote / compact 的顺序逐步收紧，保证一行、不压住主按钮。
   */
  demote?: number;
  /** 放不下时先换成紧凑写法（compactEl，如去掉对手名）的顺序，与 demote 一起排序 */
  compact?: number;
  compactEl?: ReactNode;
  el: ReactNode;
  /** 在「更多」气泡里的渲染（缺省同 el） */
  menu?: ReactNode;
}

/** 左侧「自动处理」开关收成只剩开关图标的顺序（与 CtxAction.demote / compact 一起排序） */
const TOGGLE_COMPACT = 1.5;
const TOGGLE_KEY = '__lazyToggle';

export default function ActionBar() {
  const game = useGame();
  const call = useCall();
  const callSilent = useCallSilent();
  const advance = useGameStore((s) => s.advance);
  const lazy = useGameStore((s) => s.lazyAdvance);
  const multi = useGameStore((s) => s.mode === 'multi');
  const roundStatus = useGameStore((s) => s.mp.roundStatus);
  const room = useGameStore((s) => s.mp.room);
  const setRoundReady = useGameStore((s) => s.mpSetRoundReady);
  const setView = useGameStore((s) => s.setView);
  const view = useGameStore((s) => s.view);
  const setTrainingOpen = useGameStore((s) => s.setTrainingOpen);
  const setTournamentOpen = useGameStore((s) => s.setTournamentOpen);
  const version = useGameStore((s) => s.version);
  const phone = useIsPhone();
  const chromeRef = useChromeVar('--chrome-bottom', 'bottom');
  const autoPending = !!roundStatus?.autoPending?.[game.settings.playerTeamId];
  // 自动处理预览只在开启自动处理（或多人已请求自动准备）时用到；按状态版本缓存（有待决事件时预览会在状态副本上推演一遍）
  const preview = useMemo(
    () => (lazy || autoPending) && !game.gameOver ? safe<AutoRoundPreview | null>(() => previewAutoActions(game), null) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 引擎原地修改 game，version 变化即状态变化
    [game, version, lazy, autoPending],
  );

  if (game.gameOver) return null;
  // 比赛页的比赛进行中：MatchDock 已显示阶段与操作，这里不再渲染第二条底栏
  if (game.activeMatch && view === 'match') return null;

  const blockers = getAdvanceBlockers(game);
  const tour = currentPlayerTournament(game);
  const next = tour && tour.status === 'running' ? playerNextSeries(game, tour.id) : null;
  const me = game.settings.playerTeamId;
  const decisions = game.pendingDecisions.filter((d) => d.blocking).length;
  const kind = roundKindForPlayer(game, game.roundIndex);
  const total = game.season.rounds.length;
  const roundsToTi = Math.max(0, total - 1 - game.roundIndex);
  // 不可训练的回合返回 0；TI 观赛回合（ti_watch）同样可训练、回合结束会自动训练
  const sessions = safe(() => trainingSessionsLeft(game), 0);
  const st = safe<TrainingStatus | null>(() => trainingStatus(game), null);
  // 本回合的玩家赛事（含已结束的），有则显示「赛事详情」入口
  const panelTour =
    kind === 'tournament' || kind === 'ti' || kind === 'ti_qualifier' ? safe(() => roundTournamentOf(game), null) : null;
  /** 本赛事可出场的本队选手数（含本赛事的临时替补）：< 5 时自动排阵也凑不齐首发 */
  const fieldableFor = (tid: string) =>
    teamPlayers(game, me).filter((pl) => isAvailable(pl, tid) && (!pl.tempSubUntilTournament || pl.tempSubUntilTournament === tid)).length;

  // 多人：已出局（战队解散）的座位只能观战——先于一切阻塞驱动的操作（解散的战队可能仍挂在本回合的赛事里）
  const spectating = multi && (!!roundStatus?.eliminated?.[me] || !!game.multiplayer?.seats?.[me]?.eliminated || !!game.teams[me]?.disbanded);

  // 超编（抽卡后超过绝对上限，阻塞推进，见 getAdvanceBlockers 的 roster_over_cap）：情境按钮「处理超编」去新秀抽卡页退回
  const overCap = blockers.find((b) => b.code === 'roster_over_cap') ?? null;
  // 阵容超出常规上限：不阻塞，只在右侧给一句温和提示（点击去阵容页）
  const overflow = overCap ? null : safe(() => rosterOverflowNotice(game, me), null);
  const rosterHint = overflow ? (
    <button className="cursor-pointer text-right hover:text-gold hover:underline" title="打开阵容页安排首发与替补" onClick={() => setView('squad')}>
      {overflow} ›
    </button>
  ) : undefined;
  const trainingHint =
    sessions > 0 ? (
      <button
        className="cursor-pointer text-right hover:text-gold hover:underline"
        title="展开总览的训练卡片"
        onClick={() => setTrainingOpen(true)}
      >
        还有 {sessions} 次训练未使用（回合结束时自动按当前焦点训练）›
      </button>
    ) : undefined;
  const blockerText = blockers.map((b) => b.message).join('；');
  /** 未开启自动处理且被阻塞：主按钮小字写第一条原因（右侧提示只在有多条时列出全部，避免重复） */
  const blockSub = !lazy && blockers.length ? `需先处理：${blockers[0].message}` : undefined;
  const blockHint = !lazy && blockers.length > 1 ? blockerText : undefined;
  /**
   * 自动处理预览（开启懒人模式时）：「将自动：…」的事项写在主按钮的小字里（previewAutoActions.items，完整内容在按钮的悬停提示），
   * 右侧提示说明无法推进 / 仍需等待的原因；没有这些时列出将自动签下的自由选手（补员会花钱，推进前就能看到是谁）
   */
  const lazySub = lazy && preview && !preview.blocked && preview.items.length ? `⚡ 自动：${preview.items.join(' · ')}` : undefined;
  const lazyHint = (): LazyHint => {
    if (!preview) return {};
    if (preview.blocked) return { hint: preview.blocked, bad: true };
    if (preview.waiting) {
      return {
        hint: (
          <span title={LAZY_TIP}>
            <span className="text-gold">⚡</span> {preview.waiting}
          </span>
        ),
      };
    }
    if (preview.trims.length || preview.overCapLeft > 0) {
      const d = preview.trims.filter((x) => x.action === 'discard');
      const r = preview.trims.filter((x) => x.action === 'release');
      const refund = d.reduce((a, x) => a + x.amount, 0);
      const parts: string[] = [];
      if (d.length) parts.push(`退回新秀 ${d.slice(0, 3).map((x) => x.handle).join('、')}${d.length > 3 ? ` 等 ${d.length} 人` : ''}（返还 ${formatGold(refund)}）`);
      if (r.length) parts.push(`解约 ${r.map((x) => x.handle).join('、')}`);
      return {
        hint: (
          <span title={preview.text}>
            <span className="text-gold">⚡</span> 超编 {preview.overCap} 人：将自动{parts.join('，')}
            {preview.overCapLeft > 0 ? `；仍超编 ${preview.overCapLeft} 人，需手动处理` : ''}
          </span>
        ),
        bad: preview.overCapLeft > 0,
      };
    }
    if (preview.signings.length) {
      const names = preview.signings.map((x) => `${x.handle}（${POSITION_CN[x.position]}）`).join('、');
      const fee = preview.signings.reduce((a, x) => a + x.fee, 0);
      return {
        hint: (
          <span title={preview.text}>
            <span className="text-gold">⚡</span> 将自动签下 {names}，签字费 {formatGold(fee)}
            {preview.rosterFillExact ? '' : '（婉拒则顺延）'}
          </span>
        ),
      };
    }
    return {};
  };

  // ---------------------------------------------------------------- 主按钮
  let main: Main;
  if (spectating) {
    const ids = roundStatus ? Object.keys(roundStatus.names ?? {}) : mpHumanTeamIds({ roundStatus, room }, game);
    const alive = ids.filter((id) => id !== me && !roundStatus?.eliminated?.[id]);
    const readyN = alive.filter((id) => roundStatus?.ready?.[id]).length;
    main = {
      label: '观战中（战队已解散）',
      variant: 'primary',
      onClick: () => {},
      disabled: '你的战队已解散，正在观战；其余玩家继续比赛',
      hint: alive.length ? `其他玩家：${readyN}/${alive.length} 已准备` : undefined,
    };
  } else if (multi) {
    // 多人：准备 / 取消准备（全员准备后服务器推进回合）；开启自动处理时服务器先自动处理本回合事务再准备
    const ids = roundStatus ? Object.keys(roundStatus.names ?? {}) : mpHumanTeamIds({ roundStatus, room }, game);
    const alive = ids.filter((id) => !roundStatus?.eliminated?.[id]);
    const readyN = alive.filter((id) => roundStatus?.ready?.[id]).length;
    const meReady = !!roundStatus?.ready?.[me];
    const verb = game.phase === 'preseason' ? '开始赛季' : game.roundIndex >= total - 1 ? '进入 TI 结算' : '进入下一回合';
    const waiting = alive
      .filter((id) => id !== me && !roundStatus?.ready?.[id])
      .map((id) => `${roundStatus?.names?.[id] ?? '玩家'}·${game.teams[id]?.tag ?? id}`);
    const count = `${readyN}/${alive.length || 1}`;
    // 房主：等待的玩家已离线 → 提示可以托管（顶栏玩家条）
    const offline = alive.filter((id) => id !== me && !roundStatus?.ready?.[id] && roundStatus?.connected?.[id] === false && !roundStatus?.autopilot?.[id]);
    const hostTip =
      isRoomHost(room) && offline.length ? `（${offline.map((id) => roundStatus?.names?.[id] ?? '玩家').join('、')} 已离线，可在顶栏点「托管」）` : '';
    if (meReady) {
      main = {
        label: `取消准备（${count}）`,
        variant: 'gold',
        onClick: () => setRoundReady(false),
        hint: waiting.length ? `等待 ${waiting.join('、')} 准备…${hostTip}` : '全员已准备，服务器正在推进回合…',
      };
    } else if (roundStatus?.autoPending?.[me]) {
      // 已按「下一回合」请求自动处理，正在等待对手 / 其他玩家的结果：可以时服务器自动处理并准备
      main = {
        label: `取消自动准备（${count}）`,
        short: `取消自动（${count}）`,
        variant: 'gold',
        onClick: () => setRoundReady(false),
        hint: (
          <span title={preview?.waiting ?? undefined}>
            <span className="text-gold">⚡</span> 已请求自动处理：正在等待对手 / 其他玩家，可以时自动处理并准备{hostTip}
          </span>
        ),
      };
    } else {
      const lz: LazyHint = lazy ? lazyHint() : {};
      const blockedHere = lazy ? preview?.blocked ?? null : blockers.length ? blockerText : null;
      main = {
        label: `准备${verb}（${count}）`,
        short: `准备（${count}）`,
        sub: lazySub ?? blockSub ?? (phone ? verb : undefined),
        variant: 'primary',
        onClick: () => advance(),
        disabled: blockedHere ?? undefined,
        hint:
          lz.hint ??
          (!lazy && blockers.length ? blockHint : trainingHint ?? (waiting.length ? `全部玩家准备后进入下一步 · 尚未准备：${waiting.join('、')}` : rosterHint)),
        hintBad: lz.bad || (!lazy && blockers.length > 0),
        title: lazy ? preview?.text || undefined : undefined,
      };
    }
  } else {
    const label = game.phase === 'preseason' ? '开始赛季 ▶' : game.roundIndex >= total - 1 ? 'TI 结算 ▶' : '下一回合 ▶';
    const lz: LazyHint = lazy ? lazyHint() : {};
    const blockedHere = lazy ? preview?.blocked ?? null : blockers.length ? blockerText : null;
    main = {
      label,
      sub: lazySub ?? blockSub,
      variant: 'primary',
      onClick: () => advance(),
      disabled: blockedHere ?? undefined,
      hint: lz.hint ?? (!lazy && blockers.length ? blockHint : trainingHint ?? rosterHint),
      hintBad: lz.bad || (!lazy && blockers.length > 0),
      title: lazy ? preview?.text || undefined : undefined,
    };
  }
  // 未开启自动处理且被阻塞：把解决阻塞的第一个情境操作点亮，引导下一步
  const guide = !lazy && !!main.disabled && !spectating;

  // ---------------------------------------------------------------- 情境操作
  const ctx: CtxAction[] = [];
  const detailBtn = (label: string, onClick: () => void, title: string, key: string): CtxAction => ({
    key,
    side: 'right',
    secondary: true,
    demote: 1,
    el: (
      <Button variant="ghost" onClick={onClick} title={title}>
        {label}
      </Button>
    ),
    menu: <MenuItem onClick={onClick} title={title}>{label}</MenuItem>,
  });

  if (!spectating && overCap) {
    const goFix = () => {
      setView('gacha');
      // 已在抽卡页时换页没有可见变化：让抽卡页把本回合的结果（「退回」按钮）滚到眼前
      requestAnimationFrame(() => window.dispatchEvent(new Event(GACHA_FOCUS_EVENT)));
    };
    const fixTitle = `${overCap.message}。点击打开新秀抽卡页退回本回合抽到的新秀（也可在阵容页解约 / 出售队员）`;
    const overN = overCap.message.split('：')[0].replace('超编 ', '');
    const fixBtn = (label: string) => (
      <Button variant={guide ? 'gold' : 'secondary'} className={cx(guide && 'glow')} onClick={goFix} title={fixTitle}>
        {label}
      </Button>
    );
    // 窄屏放不下时先换成「退回 3 人」（手机操作条也用这个写法：带动词），仍放不下再收进「更多」（不压住主按钮）
    ctx.push({
      key: 'overCap',
      side: 'left',
      compact: 1.8,
      demote: 2.7,
      el: fixBtn(`处理超编 · ${overN}`),
      compactEl: fixBtn(`退回 ${overN}`),
      menu: <MenuItem onClick={goFix} title={fixTitle}>处理超编 · {overN}</MenuItem>,
    });
  }

  if (!spectating && decisions > 0) {
    ctx.push({
      key: 'decisions',
      side: 'left',
      compact: 2,
      demote: 3.2,
      el: <DecisionButton game={game} count={decisions} lazy={lazy} emphasize={guide} />,
      compactEl: <DecisionButton game={game} count={decisions} lazy={lazy} emphasize={guide} compact />,
    });
  }

  if (!spectating && game.activeMatch) {
    ctx.push({
      key: 'continue',
      side: 'left',
      demote: 6,
      el: (
        <Button variant="gold" className="glow" onClick={() => setView('match')} title="比赛进行中：回到比赛页继续">
          继续比赛 ▶
        </Button>
      ),
      menu: <MenuItem onClick={() => setView('match')} title="比赛进行中：回到比赛页继续">继续比赛 ▶</MenuItem>,
    });
  } else if (!spectating && tour && next) {
    const oppId = next.teamA === me ? next.teamB : next.teamA;
    const opp = oppId ? game.teams[oppId] : undefined;
    const lineupBad = blockers.some((b) => b.code === 'lineup_invalid');
    if (fieldableFor(tour.id) < 5) {
      // 首发凑不齐 5 人（自动排阵也补不上）：先招募临时替补，否则本场弃权判负
      const fillTitle = `可出场选手不足 5 人，未补齐将弃权判负 · ${tour.name} · ${next.label}`;
      ctx.push({
        key: 'fill',
        side: 'left',
        demote: 6,
        menu: (
          <MenuItem onClick={() => void call('fillLineupWithTempSubs')} title={fillTitle}>
            补齐首发（临时替补）
          </MenuItem>
        ),
        el: (
          <Button
            variant="gold"
            className={cx(guide && 'glow')}
            onClick={() => void call('fillLineupWithTempSubs')}
            title={fillTitle}
          >
            补齐首发（临时替补）
          </Button>
        ),
      });
      ctx.push({
        key: 'forfeit',
        side: 'right',
        secondary: true,
        demote: 3,
        el: (
          <ConfirmButton
            variant="ghost"
            title="首发不足 5 人：本场系列赛直接判负"
            confirm={{ message: `本场系列赛（${next.label}）直接判负。`, confirmLabel: '弃权', danger: true }}
            onConfirm={() => void call('quickSimSeries')}
          >
            弃权本场
          </ConfirmButton>
        ),
        menu: (
          <MenuConfirm
            title="首发不足 5 人：本场系列赛直接判负"
            confirm={{ message: `本场系列赛（${next.label}）直接判负。`, confirmLabel: '弃权', danger: true }}
            onConfirm={() => void call('quickSimSeries')}
          >
            弃权本场
          </MenuConfirm>
        ),
      });
    } else {
      if (lineupBad) {
        const arrange = () => void call('autoArrangeLineup', tour.id);
        const arrangeTitle = blockers.filter((b) => b.code === 'lineup_invalid').map((b) => b.message).join('\n') + '\n点击按最强阵容自动排首发';
        ctx.push({
          key: 'lineup',
          side: 'left',
          demote: 3,
          el: (
            <Button variant={guide ? 'gold' : 'secondary'} className={cx(guide && 'glow')} onClick={arrange} title={arrangeTitle}>
              自动排阵
            </Button>
          ),
          menu: <MenuItem onClick={arrange} title={arrangeTitle}>自动排阵</MenuItem>,
        });
      }
      const simBtn = (withOpp: boolean) => (
        <Button
          variant="gold"
          className={cx(guide && !lineupBad && 'glow')}
          onClick={() => void call('quickSimSeries')}
          title={`${tour.name} · ${next.label} · Bo${next.bestOf}${opp ? ` · vs ${opp.name}` : ''}：自动 BP、跳过直播，直接得出本系列赛结果`}
        >
          快速模拟本场{withOpp && opp ? ` vs ${opp.tag}` : ''} ▶
        </Button>
      );
      ctx.push({
        key: 'sim',
        side: 'left',
        compact: 2.5,
        demote: 3.5,
        el: simBtn(true),
        compactEl: simBtn(false),
        menu: (
          <MenuItem onClick={() => void call('quickSimSeries')} title={`${tour.name} · ${next.label}：自动 BP、跳过直播，直接得出本系列赛结果`}>
            快速模拟本场{opp ? ` vs ${opp.tag}` : ''} ▶
          </MenuItem>
        ),
      });
      const simAllTitle = '自动完成你在本赛事的全部剩余比赛（自动 BP、跳过直播）';
      const simAllConfirm = {
        message: <>将自动完成你在「{tour.name}」的全部剩余比赛（自动 BP、跳过文字直播），赛事结算显示在总览「通知」中。</>,
        confirmLabel: '确定模拟',
      };
      const simAll = () => void call('quickSimTournament');
      ctx.push({
        key: 'simAll',
        side: 'right',
        secondary: true,
        demote: 3,
        el: (
          <ConfirmButton variant="secondary" title={simAllTitle} confirm={simAllConfirm} onConfirm={simAll}>
            快速模拟整项赛事
          </ConfirmButton>
        ),
        menu: (
          <MenuConfirm title={simAllTitle} confirm={simAllConfirm} onConfirm={simAll}>
            快速模拟整项赛事
          </MenuConfirm>
        ),
      });
      const enter = () => {
        void callSilent('prepareNextMatch').then((r) => {
          if (r && r.ok) setView('match');
        });
      };
      const enterTitle = '进入赛前准备 → 亲自 BP → 大老师胜率 → 文字直播';
      ctx.push({
        key: 'enter',
        side: 'right',
        secondary: true,
        demote: 2,
        el: (
          <Button variant="ghost" onClick={enter} title={enterTitle}>
            进入比赛 · 手动 BP
          </Button>
        ),
        menu: <MenuItem onClick={enter} title={enterTitle}>进入比赛 · 手动 BP</MenuItem>,
      });
    }
  }
  if (panelTour) {
    ctx.push(detailBtn('赛事详情', () => setTournamentOpen(true), '在总览展开赛事卡片：下一场、阵容检查、本赛事战绩', 'tourDetail'));
  }

  if (!spectating && st?.trainable) {
    const trainTitle = st.trainReason || '按当前焦点训练 1 次（优先使用免费次数），收益即时展示在总览训练卡片';
    ctx.push({
      key: 'train',
      side: 'left',
      demote: 5,
      el: <TrainButton st={st} />,
      menu: (
        <MenuItem onClick={() => void call('doTraining')} title={trainTitle} disabled={!!st.trainReason}>
          ⚔ 训练{st.sessionsLeft > 0 ? `（${st.sessionsLeft}）` : ''}
        </MenuItem>
      ),
    });
    const buyExtra = () => void call('buyExtraTraining');
    const extraTitle =
      st.buyReason ||
      `花费 ${formatGold(st.extraCost)} 购买 1 次额外训练（本回合已购 ${st.boughtThisRound}/${st.maxExtra}，同一回合内逐次加价）`;
    ctx.push({
      key: 'extra',
      side: 'left',
      demote: 1,
      el: (
        <Button variant="secondary" disabled={!!st.buyReason} title={extraTitle} onClick={buyExtra}>
          加练 · <Gold value={st.extraCost} />
        </Button>
      ),
      menu: (
        <MenuItem onClick={buyExtra} title={extraTitle} disabled={!!st.buyReason}>
          加练 · <Gold value={st.extraCost} />
        </MenuItem>
      ),
    });
    ctx.push({
      key: 'scrim',
      side: 'right',
      demote: 4,
      el: <ScrimButton game={game} st={st} />,
      // 收进「更多」时不再嵌套第二个气泡：打开总览训练卡片挑选对手
      menu: (
        <MenuItem onClick={() => setTrainingOpen(true)} title="在总览展开训练卡片：推荐训练赛对手与约练">
          训练赛 · 选择对手 ›
        </MenuItem>
      ),
    });
    ctx.push(detailBtn('训练详情', () => setTrainingOpen(true), '在总览展开训练卡片：焦点说明、最近一次训练收益、更多训练赛对手', 'trainDetail'));
  }

  // 比赛页（比赛已结束、停留在结算）：比赛页自带「下一场 / 返回总览」，这里只保留主要操作
  const onMatch = view === 'match';
  const visible = ctx.filter((a) => !(onMatch && a.secondary));
  const left = visible.filter((a) => a.side === 'left');
  const right = visible.filter((a) => a.side === 'right');

  const tourName = tour ? ` · ${tour.name}` : panelTour ? ` · ${panelTour.name}` : '';
  const blocked = !!main.disabled;
  /** 本回合信息的一行写法（手机提示行、sm–lg 的补充提示行在没有提示时显示） */
  const infoText = `${KIND_LABEL[kind] ?? kind}${tourName} · ${game.currentDate}${game.roundIndex > 0 && roundsToTi > 0 ? ` · 距 TI 正赛 ${roundsToTi} 个回合` : ''}`;

  return (
    // pb-safe：底栏背景铺到 Home 横条下方，按钮在安全区之上；ref 把底栏高度写入 --chrome-bottom
    <footer ref={chromeRef} className="relative shrink-0 border-t border-line bg-panel/95 pb-safe shadow-[0_-8px_24px_rgba(0,0,0,0.35)] backdrop-blur">
      {/* TI 正赛回合：该届主题色点缀 */}
      <TiBarGlow />
      {phone ? (
        <PhoneBar actions={visible} main={main} infoText={infoText} />
      ) : (
        <>
          {/* sm–lg：BarRow 的右侧提示与左侧回合信息放不下（lg 起才显示），在操作行上方补一行；横屏矮视口（short）省掉这一行，把高度留给内容 */}
          <HintLine className="px-4 pt-1.5 short:hidden lg:hidden" hint={main.hint} bad={main.hintBad} fallback={infoText} />
          <BarRow
            left={left}
            right={right}
            fitKey={`${visible.map((a) => a.key).join(',')}|${main.label}|${main.sub ?? ''}|${lazy ? 1 : 0}`}
            info={
              <>
                <div className={cx('truncate font-semibold', kind === 'rest' || kind === 'preseason' ? 'text-ink' : 'text-gold')} title={`${KIND_LABEL[kind] ?? kind}${tourName}`}>
                  {KIND_LABEL[kind] ?? kind}
                  {tourName}
                </div>
                <div className="truncate text-faint">
                  {game.currentDate}
                  {game.roundIndex > 0 && roundsToTi > 0 ? ` · 距 TI 正赛 ${roundsToTi} 个回合` : ''}
                </div>
              </>
            }
            mainEl={
              /* 中：回合推进 */
              <Button
                variant={main.variant}
                size="lg"
                disabled={blocked}
                onClick={main.onClick}
                title={main.disabled ?? main.title}
                // relative z-10：两侧栏万一溢出也只会被主按钮盖住，不会盖住主按钮（测量随后会把溢出的操作收进「更多」）
                className={cx('relative z-10 h-12 min-w-[200px] text-base font-bold tracking-wider short:h-10 xl:min-w-[260px]', main.variant === 'gold' && 'glow')}
              >
                <span className="flex min-w-0 flex-col items-center leading-tight">
                  <span>{main.label}</span>
                  {main.sub && <span className="max-w-[220px] truncate xl:max-w-[300px] text-[11px] font-normal tracking-normal opacity-90">{main.sub}</span>}
                </span>
              </Button>
            }
            hint={main.hint}
            hintBad={main.hintBad}
          />
        </>
      )}
    </footer>
  );
}

/**
 * 一行提示（手机底栏顶部、sm–lg 底栏操作行上方）：有右侧提示时显示提示（阻塞为红色），否则为本回合信息；
 * 超出一行时截断，点按展开全文（点在提示里的按钮上时执行按钮，不展开）。
 */
function HintLine({ hint, bad, fallback, className }: { hint?: ReactNode; bad?: boolean; fallback: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const has = hint !== undefined && hint !== null && hint !== false && hint !== '';
  return (
    <div
      className={cx(
        'min-w-0 cursor-default text-[11px] leading-snug',
        has ? (bad ? 'text-bad' : 'text-mute') : 'text-faint',
        open ? 'whitespace-normal break-words' : 'truncate',
        className,
      )}
      aria-live="polite"
      onClick={(e) => {
        if ((e.target as Element).closest?.('button, a')) return;
        setOpen((v) => !v);
      }}
    >
      {has ? hint : fallback}
    </div>
  );
}

/**
 * 手机底栏（< 640px）：提示行 / 情境操作条（横向滑动，紧凑写法，次要操作不在条里）/ 「自动」开关 + 通栏主按钮 + 「更多」。
 * 主按钮被禁用时小字写原因（触屏点按禁用的主按钮也会弹出原因，见 Button）。
 */
function PhoneBar({ actions, main, infoText }: { actions: CtxAction[]; main: Main; infoText: string }) {
  const strip = actions.filter((a) => !a.secondary);
  const more = actions.filter((a) => a.secondary).map((a) => ({ a, narrowOnly: false }));
  const sub = main.sub ?? main.disabled;
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2 pt-1.5 short:gap-1 short:pb-1.5 short:pt-1">
      <HintLine hint={main.hint} bad={main.hintBad} fallback={infoText} />
      {strip.length > 0 && (
        // pt-1 / gap：待决事件按钮右上角的红点不被滚动容器裁掉
        <div className="no-scrollbar -mx-3 flex items-center gap-2 overflow-x-auto overscroll-x-contain px-3 pt-1">
          {strip.map((a) => (
            <span key={a.key} className="inline-flex shrink-0">
              {a.compactEl ?? a.el}
            </span>
          ))}
        </div>
      )}
      <div className={cx('grid items-center gap-2', more.length ? 'grid-cols-[auto_minmax(0,1fr)_auto]' : 'grid-cols-[auto_minmax(0,1fr)]')}>
        <LazyToggle phone />
        <Button
          variant={main.variant}
          size="lg"
          disabled={!!main.disabled}
          onClick={main.onClick}
          title={main.disabled ?? main.title}
          className={cx('h-12 w-full min-w-0 px-3 font-bold short:h-10', main.variant === 'gold' && 'glow')}
        >
          <span className="flex min-w-0 max-w-full flex-col items-center leading-tight">
            <span className="max-w-full truncate text-[15px] tracking-wide">{main.short ?? main.label}</span>
            {sub && <span className="max-w-full truncate text-[11px] font-normal tracking-normal opacity-90">{sub}</span>}
          </span>
        </Button>
        {more.length > 0 && <MoreButton items={more} />}
      </div>
    </div>
  );
}

/**
 * 底栏一行：左栏（「自动处理」开关 + 本回合信息 + 左侧操作）/ 主按钮 / 右栏（右侧操作 + 「更多」 + 提示）。
 * 按实际宽度测量：某一栏的按钮超出该栏时，按 CtxAction.demote / compact 的顺序逐步收紧——换成紧凑写法（去掉对手名、
 * 「待决事件」→「事件」、开关只留图标）或收进「更多」，
 * 直到放得下——宽屏一行显示全部；按钮多（待决事件、自动排阵与训练 / 赛事操作同时出现）或屏幕较窄时也不会压住主按钮、撑出屏幕。
 * 测量在 useLayoutEffect 中完成（绘制前，不闪烁）；操作集合、主按钮文字或窗口宽度变化时从头重新测量。
 */
function BarRow({
  left,
  right,
  fitKey,
  info,
  mainEl,
  hint,
  hintBad,
}: {
  left: CtxAction[];
  right: CtxAction[];
  fitKey: string;
  info: ReactNode;
  mainEl: ReactNode;
  hint?: ReactNode;
  hintBad?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const key = `${fitKey}|${vw}`;
  const [fit, setFit] = useState({ key, left: 0, right: 0 });
  // 操作集合 / 窗口宽度变了：从「全部放在栏里」重新开始测量
  const lv = fit.key === key ? fit : { key, left: 0, right: 0 };

  // 每一栏的收紧步骤（按顺序）：换成紧凑写法（c）或收进「更多」（d）
  type Step = { key: string; kind: 'c' | 'd'; r: number };
  const stepsOf = (items: CtxAction[], extra: Step[] = []): Step[] =>
    [
      ...items.flatMap((a): Step[] => [
        ...(a.compact !== undefined && a.compactEl !== undefined ? [{ key: a.key, kind: 'c' as const, r: a.compact }] : []),
        ...(a.demote !== undefined ? [{ key: a.key, kind: 'd' as const, r: a.demote }] : []),
      ]),
      ...extra,
    ].sort((a, b) => a.r - b.r);
  const leftSteps = stepsOf(left, [{ key: TOGGLE_KEY, kind: 'c', r: TOGGLE_COMPACT }]);
  const rightSteps = stepsOf(right);
  const applied = [...leftSteps.slice(0, lv.left), ...rightSteps.slice(0, lv.right)];
  const demoted = new Set(applied.filter((s) => s.kind === 'd').map((s) => s.key));
  const compacted = new Set(applied.filter((s) => s.kind === 'c').map((s) => s.key));

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const over = (el: Element | undefined) => !!el && el.scrollWidth > el.clientWidth + 1;
    const nl = over(row.children[0]) && lv.left < leftSteps.length ? lv.left + 1 : lv.left;
    const nr = over(row.children[2]) && lv.right < rightSteps.length ? lv.right + 1 : lv.right;
    if (fit.key !== key || nl !== fit.left || nr !== fit.right) setFit({ key, left: nl, right: nr });
  });

  const inlineLeft = left.filter((a) => !demoted.has(a.key));
  const inlineRight = right.filter((a) => !demoted.has(a.key));
  // 「更多」：放不下而收起的（任何宽度）+ 次要操作（只在 <1280px 时）
  const more = [...left, ...right]
    .filter((a) => demoted.has(a.key) || a.secondary)
    .map((a) => ({ a, narrowOnly: !demoted.has(a.key) }));
  const moreAlways = more.some((m) => !m.narrowOnly);
  const slot = (a: CtxAction) => (
    <span key={a.key} className={cx(a.secondary ? 'hidden xl:inline-flex' : 'inline-flex')}>
      {compacted.has(a.key) && a.compactEl !== undefined ? a.compactEl : a.el}
    </span>
  );

  return (
    <div ref={rowRef} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 short:py-1.5 xl:px-6">
      {/* 左：自动处理开关 + 本回合信息 + 主按钮左侧的情境操作 */}
      <div className="flex min-w-0 items-center gap-3">
        <LazyToggle compact={compacted.has(TOGGLE_KEY)} />
        {/* 本回合信息（顶栏已有赛季 / 回合）：左侧有情境操作时只在宽屏显示，避免挤成省略号 */}
        <div className={cx('hidden min-w-0 flex-1 text-xs', inlineLeft.length ? '2xl:block' : 'lg:block')}>{info}</div>
        {/* pr-1：待决事件按钮右上角的红点（absolute -right-1）不超出本栏，否则测量会误判为放不下而把整栏收紧 */}
        <div className="ml-auto flex shrink-0 items-center gap-2 pr-1">{inlineLeft.map(slot)}</div>
      </div>

      {mainEl}

      {/* 右：主按钮右侧的情境操作 + 「更多」 + 提示 */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex shrink-0 items-center gap-2">
          {inlineRight.map(slot)}
          {more.length > 0 && (
            <span className={cx('inline-flex', !moreAlways && 'xl:hidden')}>
              <MoreButton items={more} />
            </span>
          )}
        </div>
        <div className={cx('hidden min-w-0 flex-1 text-right text-xs lg:block', hintBad ? 'text-bad' : 'text-mute')}>
          <div className="line-clamp-2">{hint}</div>
        </div>
      </div>
    </div>
  );
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 「下一回合自动处理」开关
// ---------------------------------------------------------------------------
/**
 * compact：底栏放不下时只显示开关本身（说明在 tooltip 里）；phone：手机底栏里竖排「开关 + 自动」，与主按钮等高。
 * 触屏没有悬停：每次切换在开关旁显示一句说明（LAZY_ON_TIP / LAZY_OFF_TIP）。
 */
function LazyToggle({ compact = false, phone = false }: { compact?: boolean; phone?: boolean }) {
  const lazy = useGameStore((s) => s.lazyAdvance);
  const setLazy = useGameStore((s) => s.setLazyAdvance);
  const coarse = useCoarsePointer();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={lazy}
      aria-label="下一回合自动处理"
      title={LAZY_TIP}
      onClick={(e) => {
        const next = !lazy;
        setLazy(next);
        if (coarse) showTouchTip(e.currentTarget, next ? LAZY_ON_TIP : LAZY_OFF_TIP);
      }}
      className={cx(
        'flex shrink-0 cursor-pointer items-center rounded-md border text-[11px] transition-colors',
        phone ? 'h-12 flex-col justify-center gap-1 px-2 short:h-10' : 'gap-1.5 px-2 py-1',
        lazy ? 'border-gold/50 bg-gold/10 text-gold hover:bg-gold/15' : 'border-line bg-panel-2 text-mute hover:text-ink',
      )}
    >
      <span className={cx('relative h-3.5 w-6 rounded-full transition-colors', lazy ? 'bg-gold/80' : 'bg-panel-3')}>
        <span className={cx('absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all', lazy ? 'left-3' : 'left-0.5')} />
      </span>
      {phone ? (
        <span className="leading-none">自动</span>
      ) : (
        !compact && (
          <span className="leading-tight">
            自动处理
            <span className="hidden xl:inline">{lazy ? '：开' : '：关'}</span>
          </span>
        )
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 锚定在底栏按钮上方的小气泡（焦点切换 / 训练赛 / 更多）
// ---------------------------------------------------------------------------
function useBarPopover() {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return { anchorRef, open, close, toggle };
}

/**
 * 底栏按钮上方的气泡。宽度不超过视口（左右各留 8px），高度不超过按钮上方的空间（内容滚动）；
 * 手机（< 640px）：改为底栏上方的通栏抽屉（--chrome-bottom），不随按钮位置左右漂移。
 */
function BarPopover({
  open,
  anchorRef,
  onClose,
  width = 300,
  children,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();
  const [pos, setPos] = useState<{ left: number; bottom: number; w: number; maxH: number } | null>(null);
  const place = useCallback(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return;
    const vw = window.innerWidth;
    const w = Math.min(width, vw - 16);
    const left = Math.min(Math.max(8, a.left + a.width / 2 - w / 2), vw - w - 8);
    setPos({ left, bottom: Math.max(8, window.innerHeight - a.top + 8), w, maxH: Math.max(160, a.top - 16) });
  }, [anchorRef, width]);
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);
  useEffect(() => {
    if (!open) return;
    // Esc 用冒泡阶段：气泡里的确认气泡（ConfirmPopover，捕获阶段）先处理自己的 Esc
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // pointerdown：iOS Safari 点按页面空白处不发 mousedown
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || boxRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      // 点在其他气泡（嵌套的确认气泡）里不算点外部
      if (t.closest?.('[role="dialog"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
    };
  }, [open, onClose, anchorRef, place]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-modal="false"
      className={cx(
        'fixed z-[70] overflow-y-auto overscroll-contain rounded-lg border border-line bg-panel-2 p-2 text-sm shadow-2xl shadow-black/60',
        phone ? 'sheet-up' : 'fade-up',
      )}
      style={
        phone
          ? {
              left: 'calc(8px + env(safe-area-inset-left, 0px))',
              right: 'calc(8px + env(safe-area-inset-right, 0px))',
              bottom: 'calc(var(--chrome-bottom, 0px) + 8px)',
              maxHeight: 'calc(100dvh - var(--chrome-bottom, 0px) - var(--chrome-top, 0px) - 16px)',
            }
          : { left: pos?.left ?? -9999, bottom: pos?.bottom ?? -9999, width: pos?.w ?? width, maxHeight: pos?.maxH }
      }
    >
      {children}
    </div>,
    document.body,
  );
}

/** 「更多」气泡的收起函数（菜单项执行后收起） */
const MenuCloseCtx = createContext<(() => void) | null>(null);

function MenuItem({ onClick, title, children, disabled }: { onClick: () => void; title?: string; children: ReactNode; disabled?: boolean }) {
  const close = useContext(MenuCloseCtx);
  return (
    <Button
      variant="ghost"
      className="w-full justify-start max-sm:py-3 max-sm:text-[15px]"
      onClick={() => {
        close?.();
        onClick();
      }}
      title={title}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

/** 「更多」里需要就近确认的菜单项：确认后收起菜单 */
function MenuConfirm({
  title,
  confirm,
  onConfirm,
  children,
}: {
  title?: string;
  confirm: ConfirmSpec;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const close = useContext(MenuCloseCtx);
  return (
    <ConfirmButton
      variant="ghost"
      className="w-full justify-start max-sm:py-3 max-sm:text-[15px]"
      title={title}
      confirm={confirm}
      onConfirm={() => {
        close?.();
        onConfirm();
      }}
    >
      {children}
    </ConfirmButton>
  );
}

/** 「更多」：放不下的操作，以及窄屏（<1280px）收起的次要操作（narrowOnly：宽屏时它们在栏里，菜单中隐藏） */
function MoreButton({ items }: { items: { a: CtxAction; narrowOnly: boolean }[] }) {
  const pop = useBarPopover();
  return (
    <span ref={pop.anchorRef} className="inline-flex">
      <Button variant="ghost" onClick={pop.toggle} title="更多操作" className="max-sm:h-12 max-sm:px-2.5 max-sm:short:h-10" aria-haspopup="dialog" aria-expanded={pop.open}>
        更多 ▴
      </Button>
      <BarPopover open={pop.open} anchorRef={pop.anchorRef} onClose={pop.close} width={220}>
        <MenuCloseCtx.Provider value={pop.close}>
          <div className="flex flex-col gap-0.5">
            {items.map(({ a, narrowOnly }) => (
              <div key={a.key} className={cx('flex flex-col', narrowOnly && 'xl:hidden')}>
                {a.menu ?? a.el}
              </div>
            ))}
          </div>
        </MenuCloseCtx.Provider>
      </BarPopover>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 待决事件徽标：就近展开本回合需要先处理的事件，直接选择（默认选项标出），不用切换页面
// ---------------------------------------------------------------------------
function DecisionButton({
  game,
  count,
  lazy,
  emphasize,
  compact = false,
}: {
  game: GameState;
  count: number;
  lazy: boolean;
  emphasize: boolean;
  /** 底栏放不下时的短写法 */
  compact?: boolean;
}) {
  const call = useCall();
  const setView = useGameStore((s) => s.setView);
  const pop = useBarPopover();
  // 手机：正文不截断，每个选项的说明（原本只在悬停提示里）直接写在选项下方
  const phone = useIsPhone();
  const list = game.pendingDecisions.filter((d) => d.blocking);
  const choose = (d: PendingDecision, choiceId: string) => {
    void call('resolveDecision', d.id, choiceId).then((res) => {
      // 签证问题需要野外替补时（主动选择或现有替补不足），候选已生成：带玩家去转会市场雇佣（与消息中心一致）
      if (res?.ok && d.kind === 'visa' && (choiceId === 'temp_sub' || res.message.includes('临时替补'))) {
        pop.close();
        setView('market');
      }
    });
  };
  const go = (key: 'dashboard' | 'inbox') => {
    pop.close();
    setView(key);
  };
  return (
    <span ref={pop.anchorRef} className="inline-flex">
      <Button
        variant={emphasize ? 'gold' : 'secondary'}
        className={cx('relative', emphasize && 'glow')}
        onClick={pop.toggle}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        title={
          lazy
            ? `有 ${count} 个待决事件：点「下一回合」会按默认选项处理；想亲自决定请点这里`
            : `有 ${count} 个待决事件需要你做出选择`
        }
      >
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 animate-pulse rounded-full bg-bad" />! {compact ? '事件' : '待决事件'} {count}
      </Button>
      <BarPopover open={pop.open} anchorRef={pop.anchorRef} onClose={pop.close} width={380}>
        <div className={cx('space-y-2 pr-0.5', !phone && 'max-h-[60vh] overflow-y-auto')}>
          {list.length === 0 && <div className="px-1 py-2 text-xs text-faint">事件已全部处理。</div>}
          {list.map((d) => {
            const def = safe(() => defaultDecisionChoice(d), '');
            const choices = d.choices?.length ? d.choices : [{ id: 'ack', label: '知道了' }];
            return (
              <div key={d.id} className="rounded-md border border-dota/50 bg-dota/5 px-2.5 py-2">
                <div className="text-sm font-semibold">{d.title}</div>
                <p className={cx('mt-0.5 whitespace-pre-line text-xs leading-relaxed text-mute', !phone && 'line-clamp-3')} title={d.body}>
                  {d.body}
                </p>
                {phone ? (
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {choices.map((c) => (
                      <div key={c.id}>
                        <Button size="md" variant={c.id === def ? 'gold' : 'secondary'} className="w-full justify-start" onClick={() => choose(d, c.id)}>
                          {c.label}
                          {c.id === def && <span className="text-[10px] font-normal opacity-70">默认</span>}
                        </Button>
                        {c.description && c.description !== c.label && (
                          <div className="mt-0.5 px-1 text-[11px] leading-snug text-mute">{c.description}</div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {choices.map((c) => (
                      <Button
                        key={c.id}
                        size="sm"
                        variant={c.id === def ? 'gold' : 'secondary'}
                        title={`${c.description ?? c.label}${c.id === def ? '\n（默认选项：开启自动处理时按此处理）' : ''}`}
                        onClick={() => choose(d, c.id)}
                      >
                        {c.label}
                        {c.id === def && <span className="text-[10px] font-normal opacity-70">默认</span>}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 flex justify-end gap-3 px-1 text-[11px] text-mute">
          {/* 触屏：链接加高到 40px（手机上是底部抽屉的最后一行） */}
          <button type="button" className="cursor-pointer hover:text-gold pointer-coarse:min-h-10 pointer-coarse:px-2" onClick={() => go('dashboard')}>
            总览「待处理」›
          </button>
          <button type="button" className="cursor-pointer hover:text-gold pointer-coarse:min-h-10 pointer-coarse:px-2" onClick={() => go('inbox')}>
            消息中心 ›
          </button>
        </div>
      </BarPopover>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 训练（含焦点切换）
// ---------------------------------------------------------------------------
function TrainButton({ st }: { st: TrainingStatus }) {
  const call = useCall();
  const callSilent = useCallSilent();
  const pop = useBarPopover();
  const info = FOCUS_INFO[st.focus] ?? FOCUS_INFO.balanced;
  const pick = (f: TrainingFocus) => {
    if (f !== st.focus) void callSilent('setTrainingFocus', f);
    pop.close();
  };
  return (
    <span ref={pop.anchorRef} className="inline-flex">
      <Button
        variant="primary"
        className="rounded-r-none"
        disabled={!!st.trainReason}
        title={st.trainReason || `按「${info.title}」焦点训练 1 次（优先使用免费次数），收益即时展示在总览训练卡片`}
        onClick={() => void call('doTraining')}
      >
        ⚔ 训练{st.sessionsLeft > 0 ? `（${st.sessionsLeft}）` : ''}
      </Button>
      <Button
        variant="secondary"
        className="rounded-l-none border-l-0 px-2"
        onClick={pop.toggle}
        title={`训练焦点：${info.title}（${info.short}）· 点击切换`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
      >
        <span className="text-gold">{info.icon}</span>
        <span className="hidden xl:inline">{info.title}</span>▴
      </Button>
      <BarPopover open={pop.open} anchorRef={pop.anchorRef} onClose={pop.close} width={260}>
        <div className="mb-1 px-1 text-[11px] text-faint">训练焦点（未用完的训练回合结束时也按此焦点自动完成）</div>
        <div className="flex flex-col gap-0.5">
          {FOCUS_ORDER.map((f) => {
            const fi = FOCUS_INFO[f];
            const cur = f === st.focus;
            return (
              <button
                key={f}
                type="button"
                onClick={() => pick(f)}
                title={fi.desc}
                className={cx(
                  'flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-left',
                  cur ? 'border-dota bg-dota/10' : 'border-transparent hover:bg-panel-3',
                )}
              >
                <span className={cx('w-4 text-center', cur ? 'text-gold' : 'text-mute')}>{fi.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    {fi.title}
                    {cur && <span className="ml-1.5 text-[11px] font-normal text-dota-2">✓ 当前</span>}
                  </span>
                  <span className="block truncate text-[11px] text-mute">{fi.short}</span>
                </span>
              </button>
            );
          })}
        </div>
      </BarPopover>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 训练赛（推荐对手气泡）
// ---------------------------------------------------------------------------
function ScrimButton({ game, st }: { game: GameState; st: TrainingStatus }) {
  const call = useCall();
  const setTrainingOpen = useGameStore((s) => s.setTrainingOpen);
  const pop = useBarPopover();
  const suggested = pop.open ? suggestedScrims(scrimOptions(game, st.team, st.ownRating), SCRIM_SUGGEST) : [];
  const lock = !st.trainable ? st.lockTitle || '仅在休赛回合可训练' : st.sessionsLeft <= 0 ? '没有剩余训练次数（训练赛消耗 1 次训练），可先加练' : '';
  return (
    <span ref={pop.anchorRef} className="inline-flex">
      <Button
        variant="secondary"
        onClick={pop.toggle}
        title={lock || `约一场训练赛：消耗 1 次训练次数，${scrimRuleText()}。对手越强花费也越高`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
      >
        训练赛 ▴
      </Button>
      <BarPopover open={pop.open} anchorRef={pop.anchorRef} onClose={pop.close} width={340}>
        <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
          <span className="text-xs font-semibold text-mute">推荐训练赛（按收益倍数）</span>
          <span className="text-[11px] text-faint">剩余训练 {st.sessionsLeft} 次</span>
        </div>
        <div className="mb-1.5 px-1 text-[11px] leading-snug text-faint">{scrimRuleText()}</div>
        {lock && <div className="mb-1.5 rounded border border-gold/40 bg-gold/5 px-2 py-1 text-[11px] text-gold">{lock}</div>}
        {suggested.length === 0 ? (
          <div className="rounded border border-dashed border-line px-2 py-3 text-center text-xs text-faint">当前没有可约练的战队。</div>
        ) : (
          <div className="divide-y divide-line/60 rounded border border-line">
            {suggested.map((r) => {
              const why = scrimReason(st, r.cost, r.booked, r.t.name);
              return (
                <div key={r.t.id} className={cx('flex items-center gap-2 px-2 py-1 text-xs', r.booked && 'opacity-60')}>
                  <span className="min-w-0 flex-1 truncate" title={r.t.name}>
                    <TeamTag color={r.t.color} tag={r.t.tag} />
                    <span className="ml-1 text-faint">评分 {r.rating.toFixed(0)}</span>
                  </span>
                  <span className={cx('w-11 text-right font-semibold tabular', scrimMultTone(r.mult))}>×{r.mult.toFixed(2)}</span>
                  <Gold value={r.cost} className={cx('w-16 text-right', !r.booked && r.cost > st.team.gold && 'text-bad')} />
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={!!why}
                    title={why || `花费 ${formatGold(r.cost)} 与 ${r.t.name} 打一场训练赛`}
                    onClick={() => void call('doScrim', r.t.id)}
                  >
                    {r.booked ? SCRIM_BOOKED_LABEL : '约练'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <button
          type="button"
          className="mt-1.5 w-full cursor-pointer px-1 text-right text-[11px] text-mute hover:text-gold"
          onClick={() => {
            pop.close();
            setTrainingOpen(true);
          }}
        >
          查看训练结果与全部对手 ›
        </button>
      </BarPopover>
    </span>
  );
}

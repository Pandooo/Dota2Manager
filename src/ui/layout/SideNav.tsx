// 侧栏：7 个中心页（总览 · 战队 · 转会 · 赛事 · 俱乐部 · DotaPedia · 消息）。中心页内的细分页面用页内标签切换；
// 徽标（未读 / 报价 / 本回合抽到的新秀 / 进行中的赛事等）挂在对应中心页上；带「需处理」徽标时点击直接打开对应标签（hubEntryTab）。
// 比赛页为独立视图（高亮「赛事」）。
// 手机 / 窄屏（< md）与横屏手机（矮视口且 < lg，docs/UI.md「手机适配 · 导航」）：不渲染侧栏（App 按 mobile.useSideNav 决定），顶栏最左侧为 ☰（NavToggle），
// 点开为左侧导航抽屉（NavDrawer：同一份入口、徽标与 open() 逻辑，入口下方显示说明文字，导航后自动收起）；
// 有「需处理」徽标（待决事件、首发问题、报价、资金为负 / 荣誉告急）时 ☰ 带红点，只有新通知时带蓝点（窄屏不显示左下角的通知徽标）。
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { hubEntryTab, useGame, useGameStore, type HubKey } from '../../store/gameStore';
import {
  currentPlayerTournament, gachaLog, getCoach, isTransferWindowOpen, regularRoundCount, validateLineup,
} from '../../engine';
import { TeamTag, cx } from '../components/common';
import { safe } from '../components/ShellKit';
import { groupNotices } from '../components/PopupHost';
import { useSideNav } from '../mobile';
import { CountBadge, DotBadge, TextBadge } from './HubKit';

interface NavItem {
  key: Exclude<HubKey, 'match'>;
  label: string;
  icon: string;
  hint: string;
}

const ITEMS: NavItem[] = [
  { key: 'dashboard', label: '总览', icon: '◎', hint: '本回合要做的事、要闻与世界动态' },
  { key: 'team', label: '战队', icon: '☰', hint: '阵容 · 训练 · 教练' },
  { key: 'transfer', label: '转会', icon: '⇄', hint: '转会市场 · 新秀抽卡' },
  { key: 'events', label: '赛事', icon: '♜', hint: '赛事中心 · 赛程报名 · 排名 · 版本' },
  { key: 'club', label: '俱乐部', icon: '♛', hint: '财务 · 荣誉史' },
  { key: 'pedia', label: 'DotaPedia', icon: '✦', hint: '百科：历史数据总览 · 战队 / 选手词条 · 赛事 · 英雄（含实时历史地位）' },
  { key: 'inbox', label: '消息', icon: '✉', hint: '待决策事件与全部新闻' },
];

/** 导航入口的徽标与打开逻辑（侧栏与手机导航抽屉共用） */
function useNavModel() {
  const game = useGame();
  const view = useGameStore((s) => s.view);
  const openHub = useGameStore((s) => s.openHub);
  const setView = useGameStore((s) => s.setView);
  const hubTabs = useGameStore((s) => s.hubTabs);
  const me = game.settings.playerTeamId;
  const team = game.teams[me];

  const unread = (game.news ?? []).filter((n) => !n.read).length;
  const decisions = (game.pendingDecisions ?? []).length;
  const offers = (game.transferOffers ?? []).filter((o) => o && o.status === 'pending' && o.toTeamId === me).length;
  const tour = safe(() => currentPlayerTournament(game), null);
  // 本回合抽到、仍可退回的新秀
  const rookies = safe(() => gachaLog(game, me).filter((r) => r.round === game.roundIndex && !r.discarded && game.players[r.playerId]?.teamId === me).length, 0);
  const windowOpen = safe(() => isTransferWindowOpen(game), true);
  const lineupErrors = safe(() => validateLineup(game, me, tour && tour.status !== 'finished' ? tour.id : null), [] as string[]);
  const noCoach = safe(() => !getCoach(game, me), false);
  const notices = safe(() => groupNotices(game.popups ?? []).length, 0);
  const clubAlert = !!team && (team.gold < 0 || team.honor < 50);
  const entryCtx = {
    lineupProblem: lineupErrors.length > 0,
    offers,
    live: !!tour || !!game.activeMatch,
    preseason: game.phase === 'preseason',
    goldNegative: !!team && team.gold < 0,
  };
  // 带「需处理」徽标的入口直接打开徽标所指的标签，否则回到上次停留的标签
  const open = (key: NavItem['key']) => {
    const tab = hubEntryTab(key, entryCtx, hubTabs);
    if (tab) setView(key, tab);
    else openHub(key);
  };
  const isActive = (key: NavItem['key']) => view === key || (key === 'events' && view === 'match');

  const badge = (key: NavItem['key']): ReactNode => {
    switch (key) {
      case 'inbox':
        if (decisions) return <CountBadge n={decisions} tone="dota" title={`${decisions} 个待决策事件`} />;
        if (unread) return <CountBadge n={unread > 99 ? '99+' : unread} tone="mute" title={`${unread} 条未读消息`} />;
        return null;
      case 'team':
        if (lineupErrors.length) return <DotBadge tone="bad" title={`首发阵容有问题：\n${lineupErrors.join('\n')}`} />;
        if (noCoach) return <TextBadge title="教练岗位空缺">空缺</TextBadge>;
        return null;
      case 'transfer':
        if (offers) return <CountBadge n={offers} title={`收到 ${offers} 份转会报价`} />;
        if (rookies) return <TextBadge tone="gold" title={`本回合抽到 ${rookies} 名新秀（本回合内可退回）`}>新秀</TextBadge>;
        if (!windowOpen) return <TextBadge title="TI 阶段转会窗口锁定">锁定</TextBadge>;
        return null;
      case 'events':
        if (tour || game.activeMatch) return <DotBadge tone="live" title={tour ? `进行中：${tour.name}` : '比赛进行中'} />;
        return null;
      case 'club':
        if (clubAlert) {
          return <DotBadge tone="bad" title={team.gold < 0 ? '资金为负，将触发欠薪' : '荣誉告急：跌破 0 战队解散'} />;
        }
        return null;
      default:
        return null;
    }
  };

  /** ☰ 上的提示点：需处理（红）> 新通知（蓝） */
  const attention: 'bad' | 'info' | null = decisions > 0 || lineupErrors.length > 0 || offers > 0 || clubAlert ? 'bad' : notices > 0 ? 'info' : null;

  return { game, team, open, isActive, badge, notices, attention };
}

export default function SideNav() {
  const { open, isActive, badge, notices } = useNavModel();
  return (
    <nav className="w-40 shrink-0 overflow-y-auto overscroll-contain border-r border-line bg-panel/60 py-3 short:py-1.5">
      {ITEMS.map((it) => {
        const active = isActive(it.key);
        return (
          <button
            key={it.key}
            onClick={() => open(it.key)}
            title={it.hint}
            className={cx(
              'flex w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 text-left text-[15px] transition-colors short:py-1.5',
              active ? 'border-l-2 border-dota bg-panel-2 font-semibold text-ink' : 'border-l-2 border-transparent text-mute hover:bg-panel-2/60 hover:text-ink',
            )}
          >
            <span className="w-4 text-center opacity-70">{it.icon}</span>
            <span>{it.label}</span>
            <span className="ml-auto flex items-center">
              {badge(it.key)}
              {/* 横屏手机（short）不显示左下角的浮动通知徽标（NoticeBadge），新通知数写在「总览」上 */}
              {it.key === 'dashboard' && notices > 0 && (
                <span className="hidden short:inline-flex">
                  <CountBadge n={notices} tone="info" title={`${notices} 条新通知（总览顶部）`} />
                </span>
              )}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * 手机 / 窄屏（< md）：顶栏最左侧的 ☰ 按钮 + 导航抽屉。
 * footer：抽屉底部的附加入口（顶栏放不下的「存档」「更新说明」，参数 close 先收起抽屉再打开弹窗——抽屉层级高于弹窗）；
 * extraDot：附加入口有未读（如更新说明）时 ☰ 也带蓝点。
 */
export function NavToggle({ footer, extraDot = false }: { footer?: (close: () => void) => ReactNode; extraDot?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const model = useNavModel();
  const dot = model.attention ?? (extraDot ? 'info' : null);
  const label =
    model.attention === 'bad'
      ? '打开导航（有需要处理的事项）'
      : model.attention === 'info'
        ? `打开导航（${model.notices} 条新通知）`
        : extraDot
          ? '打开导航（有未读的更新说明）'
          : '打开导航';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative -ml-1 grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-md text-ink transition-colors hover:bg-panel-2"
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
          <path d="M3 5.5h14M3 10h14M3 14.5h14" />
        </svg>
        {dot && (
          <span
            className={cx('absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-panel', dot === 'bad' ? 'animate-pulse bg-bad' : 'bg-info')}
          />
        )}
      </button>
      {open && <NavDrawer model={model} onClose={close} footer={footer?.(close)} />}
    </>
  );
}

const PHASE_ROUND_LABEL: Record<string, string> = {
  ti_qualifier: 'TI 预选赛',
  ti: 'TI 正赛',
  season_end: 'TI 结算',
};

function NavDrawer({ model, onClose, footer }: { model: ReturnType<typeof useNavModel>; onClose: () => void; footer?: ReactNode }) {
  const { game, team, open, isActive, badge, notices } = model;
  // 出现侧栏（≥ md 且不是横屏手机，useSideNav）时自动收起
  const wide = useSideNav();
  useEffect(() => {
    if (wide) onClose();
  }, [wide, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  const R = regularRoundCount(game.season);
  const roundText =
    game.roundIndex === 0 ? '赛季初' : game.roundIndex <= R ? `第 ${game.roundIndex}/${R} 回合` : PHASE_ROUND_LABEL[game.phase] ?? `第 ${game.roundIndex} 回合`;
  const go = (key: NavItem['key']) => {
    open(key);
    onClose();
  };
  // portal 到 body：顶栏的 backdrop-filter 会成为 fixed 定位的包含块
  return createPortal(
    <div className="fixed inset-0 z-[55]" role="dialog" aria-modal="true" aria-label="导航">
      <div className="backdrop-in absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <nav className="drawer-in absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-panel pt-safe pb-safe shadow-2xl shadow-black/60 [padding-left:env(safe-area-inset-left,0px)]">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              <TeamTag color={team.color} tag={team.tag} teamId={team.id} />
              {/* 全名与简称相同（如 OG）时不重复 */}
              {team.name.trim().toLowerCase() !== team.tag.trim().toLowerCase() && <span className="ml-1.5 text-mute">{team.name}</span>}
            </div>
            <div className="mt-0.5 text-xs text-mute">
              TI{game.season.ti} 赛季 · {roundText}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭导航"
            className="-mr-2 grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-md text-mute hover:bg-panel-2 hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
          {ITEMS.map((it) => {
            const active = isActive(it.key);
            const b = it.key === 'dashboard' && notices > 0 ? <CountBadge n={notices} tone="info" title={`${notices} 条新通知（总览顶部）`} /> : badge(it.key);
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => go(it.key)}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex min-h-12 w-full cursor-pointer items-center gap-3 border-l-2 px-4 py-2 text-left transition-colors',
                  active ? 'border-dota bg-panel-2' : 'border-transparent hover:bg-panel-2/60',
                )}
              >
                <span className={cx('w-5 text-center text-base', active ? 'text-gold' : 'opacity-70')}>{it.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className={cx('block text-[15px]', active ? 'font-semibold text-ink' : 'text-ink/90')}>{it.label}</span>
                  {/* 触屏没有悬停：入口说明直接写在下方 */}
                  <span className="block truncate text-[11px] text-faint">{it.hint}</span>
                </span>
                <span className="flex shrink-0 items-center">{b}</span>
              </button>
            );
          })}
        </div>
        {footer && <div className="border-t border-line py-1">{footer}</div>}
      </nav>
    </div>,
    document.body,
  );
}

/** 导航抽屉底部的一行入口（存档、更新说明） */
export function DrawerRow({ onClick, children, dot, title }: { onClick: () => void; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-2 text-left text-sm text-mute transition-colors hover:bg-panel-2/60 hover:text-ink"
    >
      {children}
      {dot && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-info" aria-hidden />}
    </button>
  );
}

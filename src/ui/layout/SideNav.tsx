// 侧栏：7 个中心页（总览 · 战队 · 转会 · 赛事 · 俱乐部 · DotaPedia · 消息）。中心页内的细分页面用页内标签切换；
// 徽标（未读 / 报价 / 赛季初选中的新秀 / 进行中的赛事等）挂在对应中心页上；带「需处理」徽标时点击直接打开对应标签（hubEntryTab）。
// 比赛页为独立视图（高亮「赛事」）。
import type { ReactNode } from 'react';
import { hubEntryTab, useGame, useGameStore, type HubKey } from '../../store/gameStore';
import {
  currentPlayerTournament, draftedRookiesOf, getCoach, isTransferWindowOpen, validateLineup,
} from '../../engine';
import { cx } from '../components/common';
import { safe } from '../components/ShellKit';
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
  { key: 'transfer', label: '转会', icon: '⇄', hint: '转会市场 · 新秀选秀' },
  { key: 'events', label: '赛事', icon: '♜', hint: '赛事中心 · 赛程报名 · 排名 · 版本' },
  { key: 'club', label: '俱乐部', icon: '♛', hint: '财务 · 荣誉史' },
  { key: 'pedia', label: 'DotaPedia', icon: '✦', hint: '百科：历史数据总览 · 战队 / 选手词条 · 赛事 · 英雄（含实时历史地位）' },
  { key: 'inbox', label: '消息', icon: '✉', hint: '待决策事件与全部新闻' },
];

export default function SideNav() {
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
  const rookies = game.phase === 'preseason' ? safe(() => draftedRookiesOf(game, me).length, 0) : 0;
  const windowOpen = safe(() => isTransferWindowOpen(game), true);
  const lineupErrors = safe(() => validateLineup(game, me, tour && tour.status !== 'finished' ? tour.id : null), [] as string[]);
  const noCoach = safe(() => !getCoach(game, me), false);
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
        if (rookies) return <TextBadge tone="gold" title={`本届选秀选中 ${rookies} 名新秀（赛季初可保留或免费放弃）`}>新秀</TextBadge>;
        if (!windowOpen) return <TextBadge title="TI 阶段转会窗口锁定">锁定</TextBadge>;
        return null;
      case 'events':
        if (tour || game.activeMatch) return <DotBadge tone="live" title={tour ? `进行中：${tour.name}` : '比赛进行中'} />;
        return null;
      case 'club':
        if (team && (team.gold < 0 || team.honor < 50)) {
          return <DotBadge tone="bad" title={team.gold < 0 ? '资金为负，将触发欠薪' : '荣誉告急：跌破 0 战队解散'} />;
        }
        return null;
      default:
        return null;
    }
  };

  return (
    <nav className="w-40 shrink-0 overflow-y-auto border-r border-line bg-panel/60 py-3">
      {ITEMS.map((it) => {
        const active = view === it.key || (it.key === 'events' && view === 'match');
        return (
          <button
            key={it.key}
            onClick={() => open(it.key)}
            title={it.hint}
            className={cx(
              'flex w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 text-left text-[15px] transition-colors',
              active ? 'border-l-2 border-dota bg-panel-2 font-semibold text-ink' : 'border-l-2 border-transparent text-mute hover:bg-panel-2/60 hover:text-ink',
            )}
          >
            <span className="w-4 text-center opacity-70">{it.icon}</span>
            <span>{it.label}</span>
            <span className="ml-auto flex items-center">{badge(it.key)}</span>
          </button>
        );
      })}
    </nav>
  );
}

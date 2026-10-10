// 赛事中心页：赛事中心 | 赛程报名 | 排名 | 版本（比赛页为独立视图，从底部操作栏 / 赛事中心进入）
import { useGame } from '../../store/gameStore';
import { currentPlayerTournament, currentRound } from '../../engine';
import type { EventsTab as Tab } from '../../store/gameStore';
import { HubShell, useHubTab, DotBadge, TextBadge, type HubTabDef } from '../layout/HubKit';
import { safe } from '../components/ShellKit';
import TournamentCenter from './Tournament';
import Schedule from './Schedule';
import Rankings from './Rankings';
import Patches from './Patches';

export default function EventsHub() {
  const game = useGame();
  const tab = useHubTab<Tab>('events');
  const tour = safe(() => currentPlayerTournament(game), null);
  const patchesNow = safe(() => currentRound(game).patchVersions ?? [], [] as string[]);

  const tabs: HubTabDef[] = [
    {
      key: 'tournament',
      label: '赛事中心',
      badge: tour ? <DotBadge tone="live" title={`进行中：${tour.name}`} /> : undefined,
      title: '小组赛积分、淘汰赛对阵与赛事结算',
    },
    {
      key: 'schedule',
      label: '赛程报名',
      badge: game.phase === 'preseason' ? <TextBadge tone="gold" title="赛季初：确认本赛季的赛事报名">报名</TextBadge> : undefined,
    },
    { key: 'rankings', label: '排名', title: '赛季积分榜、战力榜、选手榜与 TI 历史' },
    {
      key: 'patches',
      label: '版本',
      badge: patchesNow.length ? <TextBadge tone="gold" title={`本回合生效：${patchesNow.join('、')}`}>新</TextBadge> : undefined,
    },
  ];

  return (
    <HubShell title="赛事" tabs={tabs} value={tab}>
      {tab === 'tournament' && <TournamentCenter />}
      {tab === 'schedule' && <Schedule />}
      {tab === 'rankings' && <Rankings />}
      {tab === 'patches' && <Patches />}
    </HubShell>
  );
}

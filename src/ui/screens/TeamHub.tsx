// 战队中心页：阵容 | 训练 | 教练
import { useGame } from '../../store/gameStore';
import { getCoach, trainingSessionsLeft, validateLineup, currentPlayerTournament } from '../../engine';
import type { TeamTab as Tab } from '../../store/gameStore';
import { HubShell, useHubTab, CountBadge, DotBadge, TextBadge, type HubTabDef } from '../layout/HubKit';
import { safe } from '../components/ShellKit';
import Squad from './Squad';
import Training from './Training';
import Coach from './Coach';

export default function TeamHub() {
  const game = useGame();
  const tab = useHubTab<Tab>('team');
  const me = game.settings.playerTeamId;
  const tour = safe(() => currentPlayerTournament(game), null);
  const lineupErrors = safe(() => validateLineup(game, me, tour && tour.status !== 'finished' ? tour.id : null), [] as string[]);
  const sessions = safe(() => trainingSessionsLeft(game), 0);
  const coach = safe(() => getCoach(game, me), null);

  const tabs: HubTabDef[] = [
    {
      key: 'squad',
      label: '阵容',
      badge: lineupErrors.length ? <DotBadge tone="bad" title={lineupErrors.join('\n')} /> : undefined,
      title: lineupErrors.length ? `首发阵容有 ${lineupErrors.length} 个问题` : '首发、替补与球员管理',
    },
    {
      key: 'training',
      label: '训练',
      badge: sessions > 0 ? <CountBadge n={sessions} tone="good" title={`本回合还有 ${sessions} 次训练`} /> : undefined,
      title: '训练安排、赛季汇总、成长曲线与训练历史',
    },
    {
      key: 'coach',
      label: '教练',
      badge: !coach ? <TextBadge title="教练岗位空缺">空缺</TextBadge> : undefined,
    },
  ];

  return (
    <HubShell title="战队" tabs={tabs} value={tab}>
      {tab === 'squad' && <Squad />}
      {tab === 'training' && <Training />}
      {tab === 'coach' && <Coach />}
    </HubShell>
  );
}

// 俱乐部中心页：财务 | 荣誉史
import { useGame } from '../../store/gameStore';
import type { ClubTab as Tab } from '../../store/gameStore';
import { HubShell, useHubTab, DotBadge, type HubTabDef } from '../layout/HubKit';
import Finance from './Finance';
import Club from './Club';

export default function ClubHub() {
  const game = useGame();
  const tab = useHubTab<Tab>('club');
  const team = game.teams[game.settings.playerTeamId];
  const gold = Number.isFinite(team?.gold) ? team!.gold : 0;
  const honor = Number.isFinite(team?.honor) ? team!.honor : 0;

  const tabs: HubTabDef[] = [
    {
      key: 'finance',
      label: '财务',
      badge: gold < 0 ? <DotBadge tone="bad" title="俱乐部资金为负，将触发欠薪" /> : undefined,
      title: '收支来源、赛季预测与账目',
    },
    {
      key: 'honors',
      label: '荣誉史',
      badge: honor < 50 ? <DotBadge tone="bad" title="荣誉告急：跌破 0 战队解散" /> : undefined,
      title: '奖杯、荣誉与资金走势、历届战绩',
    },
  ];

  return (
    <HubShell title="俱乐部" tabs={tabs} value={tab}>
      {tab === 'finance' && <Finance />}
      {tab === 'honors' && <Club />}
    </HubShell>
  );
}

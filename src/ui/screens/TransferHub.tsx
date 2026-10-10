// 转会中心页：转会市场（自由选手 / 转会求购 / 收到的报价 / 我的挂牌 / 临时替补）| 新秀选秀
import { useGame } from '../../store/gameStore';
import { draftedRookiesOf, isTransferWindowOpen } from '../../engine';
import type { TransferTab as Tab } from '../../store/gameStore';
import { HubShell, useHubTab, CountBadge, TextBadge, type HubTabDef } from '../layout/HubKit';
import { safe } from '../components/ShellKit';
import Market from './Market';
import RookieDraft from './RookieDraft';

export default function TransferHub() {
  const game = useGame();
  const tab = useHubTab<Tab>('transfer');
  const me = game.settings.playerTeamId;
  const offers = (game.transferOffers ?? []).filter((o) => o && o.status === 'pending' && o.toTeamId === me).length;
  const windowOpen = safe(() => isTransferWindowOpen(game), game.phase === 'preseason' || game.phase === 'regular');
  // 赛季初：本届选中的新秀（可保留 / 免费放弃）
  const rookies = game.phase === 'preseason' ? safe(() => draftedRookiesOf(game, me).length, 0) : 0;

  const tabs: HubTabDef[] = [
    {
      key: 'market',
      label: '转会市场',
      badge: offers ? (
        <CountBadge n={offers} title={`收到 ${offers} 份转会报价`} />
      ) : !windowOpen ? (
        <TextBadge title="TI 阶段转会窗口锁定，TI 结束后开放">锁定</TextBadge>
      ) : undefined,
    },
    {
      key: 'draft',
      label: '新秀选秀',
      badge: rookies ? <CountBadge n={rookies} tone="good" title={`本届选中 ${rookies} 名新秀，赛季初可保留或免费放弃`} /> : undefined,
      title: '每个赛季初自动举行：抽签概率、本届选秀结果、我的新秀、往届选秀',
    },
  ];

  return (
    <HubShell title="转会" tabs={tabs} value={tab}>
      {tab === 'market' && <Market />}
      {tab === 'draft' && <RookieDraft />}
    </HubShell>
  );
}

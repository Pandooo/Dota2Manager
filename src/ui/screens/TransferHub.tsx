// 转会中心页：转会市场（自由选手 / 转会求购 / 收到的报价 / 我的挂牌 / 临时替补）| 新秀抽卡（2026-10-14 取代选秀）
// | 新秀选秀（选秀默认关闭：只在 CONFIG.draft.enabled 或旧存档有选秀记录时显示，可查看往届选秀）
import { Suspense, lazy } from 'react';
import { useGame } from '../../store/gameStore';
import { CONFIG, draftedRookiesOf, gachaLog, isTransferWindowOpen, rookieDraftHistory } from '../../engine';
import type { TransferTab as Tab } from '../../store/gameStore';
import { HubShell, useHubTab, CountBadge, TextBadge, type HubTabDef } from '../layout/HubKit';
import { safe } from '../components/ShellKit';
import NewBadge from '../components/NewBadge';
import Market from './Market';
// 新秀抽卡页：按需加载（主包接近 vite.config.ts 的 800 kB 提示线）；进入「新秀抽卡」标签时才下载
const Gacha = lazy(() => import('./Gacha'));
// 选秀页（选秀默认关闭，只有旧存档 / 打开选秀开关时才显示）：按需加载，不进主包
const RookieDraft = lazy(() => import('./RookieDraft'));

export default function TransferHub() {
  const game = useGame();
  const raw = useHubTab<Tab>('transfer');
  const me = game.settings.playerTeamId;
  const offers = (game.transferOffers ?? []).filter((o) => o && o.status === 'pending' && o.toTeamId === me).length;
  const windowOpen = safe(() => isTransferWindowOpen(game), game.phase === 'preseason' || game.phase === 'regular');
  const showDraft = !!CONFIG.draft.enabled || safe(() => rookieDraftHistory(game).length > 0, false);
  const tab: Tab = raw === 'draft' && !showDraft ? 'gacha' : raw;
  // 赛季初：本届选秀选中的新秀（选秀开启时；可保留 / 免费放弃）
  const rookies = showDraft && game.phase === 'preseason' ? safe(() => draftedRookiesOf(game, me).length, 0) : 0;
  // 本回合抽到、仍可退回的新秀
  const fresh = safe(() => gachaLog(game, me).filter((r) => r.round === game.roundIndex && !r.discarded).length, 0);
  const poolOpen = !!game.gacha?.pool && game.gacha.pool.ti === game.season?.ti && windowOpen;

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
      key: 'gacha',
      label: '新秀抽卡',
      // 新功能徽标（v0.3.0）：点击标签后消失；与状态徽标并列
      badge: (
        <>
          <NewBadge feature="gacha" />
          {fresh ? (
            <CountBadge n={fresh} tone="good" title={`本回合抽到 ${fresh} 名新秀（本回合内可退回）`} />
          ) : !poolOpen ? (
            <TextBadge title="卡池在转会窗口开放期间开放（TI 预选赛转会锁定时关闭）">关闭</TextBadge>
          ) : null}
        </>
      ),
      title: '本赛季新秀卡池：真实新秀 / 请神新秀 / 虚构新秀，单抽 / 十连、SSR 保底、本回合内退回',
    },
  ];
  if (showDraft) {
    tabs.push({
      key: 'draft',
      label: '新秀选秀',
      badge: rookies ? <CountBadge n={rookies} tone="good" title={`本届选中 ${rookies} 名新秀，赛季初可保留或免费放弃`} /> : undefined,
      title: CONFIG.draft.enabled ? '每个赛季初自动举行：抽签概率、本届选秀结果、我的新秀、往届选秀' : '往届选秀（2026-10-14 起新秀改由抽卡进入联赛）',
    });
  }

  return (
    <HubShell title="转会" tabs={tabs} value={tab}>
      {tab === 'market' && <Market />}
      {tab === 'gacha' && (
        <Suspense fallback={<div className="py-16 text-center text-sm text-mute">正在载入新秀抽卡…</div>}>
          <Gacha />
        </Suspense>
      )}
      {tab === 'draft' && (
        <Suspense fallback={<div className="py-16 text-center text-sm text-mute">正在载入新秀选秀…</div>}>
          <RookieDraft />
        </Suspense>
      )}
    </HubShell>
  );
}

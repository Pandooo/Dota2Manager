// 转会市场：自由选手 / 转会求购 / 收到的报价 / 临时替补
import { useState } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, freeAgents, isTransferWindowOpen, listedPlayers, listingOffers, roundWageBill, rosterHardRoom, rosterRoom, teamPlayers,
  type Player,
} from '../../engine';
import { Badge, Button, EmptyState, Gold, Stat, Tabs, cx } from '../components/common';
import { ScreenHeader } from '../layout/HubKit';
import { Banner, num, safe } from '../components/MarketKit';
import MarketFreeAgents from '../components/MarketFreeAgents';
import MarketTransferList from '../components/MarketTransferList';
import MarketOffers from '../components/MarketOffers';
import MarketTempSubs, { missingPositions, tempSubTargetTournament } from '../components/MarketTempSubs';
import MarketListings from '../components/MarketListings';

type TabKey = 'free' | 'transfer' | 'offers' | 'listing' | 'temp';

const PHASE_LABEL: Record<string, string> = {
  preseason: '赛季初',
  regular: '常规赛季',
  ti_qualifier: 'TI 预选赛',
  ti: 'TI 正赛',
  season_end: 'TI 结算',
};

export default function Market() {
  const g = useGame();
  const setView = useGameStore((s) => s.setView);
  const me = g.settings.playerTeamId;
  const team = g.teams[me];

  const pendingOffers = (g.transferOffers ?? []).filter((o) => o && o.status === 'pending' && o.toTeamId === me).length;
  const [tab, setTab] = useState<TabKey>(pendingOffers > 0 ? 'offers' : 'free');

  if (!team) {
    return (
      <>
        <ScreenHeader title="转会市场" />
        <EmptyState text="找不到你的战队数据，无法使用转会市场。">
          <Button onClick={() => setView('dashboard')}>返回总览</Button>
        </EmptyState>
      </>
    );
  }

  const windowOpen = safe(() => isTransferWindowOpen(g), g.phase === 'preseason' || g.phase === 'regular');
  const room = safe(() => rosterRoom(g, me), 0);
  const hardRoom = safe(() => rosterHardRoom(g, me), 1);
  const roster = safe(() => teamPlayers(g, me), [] as Player[]);
  const regular = roster.filter((p) => !p.tempSubUntilTournament).length;
  const wage = safe(() => roundWageBill(g, me), 0);
  const faCount = safe(() => freeAgents(g).length, 0);
  const target = tempSubTargetTournament(g);
  const listed = safe(() => listedPlayers(g), [] as Player[]);
  const listingOfferCount = listed.reduce((n, p) => n + safe(() => listingOffers(g, p.id).length, 0), 0);
  const subNeeded = target ? missingPositions(g, target.id).length > 0 : false;

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="转会市场"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            TI{g.season.ti} · {PHASE_LABEL[g.phase] ?? g.phase}
            <Badge className={windowOpen ? 'bg-good/15 text-good' : 'bg-dota/20 text-dota-2'}>
              {windowOpen ? '转会窗口开放中' : '转会窗口已锁定'}
            </Badge>
          </span>
        }
        nav={
          <>
            <Button size="sm" variant="ghost" onClick={() => setView('squad')}>阵容</Button>
            <Button size="sm" variant="ghost" onClick={() => setView('finance')}>财务</Button>
          </>
        }
      />

      {!windowOpen && (
        <Banner tone="warn" title="TI 阶段转会锁定，TI 结束后开放">
          当前可以浏览选手与报价参考，但无法签约、求购或接受报价。临时替补不受转会窗口限制。
        </Banner>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="可用金币" value={<Gold value={num(team.gold)} />} hint="签约费 / 转会费从此支付" />
        <Stat
          label="阵容人数"
          value={
            <span className={cx(hardRoom <= 0 ? 'text-bad' : room < 0 && 'text-gold')}>
              {regular}
              <span className="text-sm text-faint"> / {CONFIG.team.maxRoster}</span>
            </span>
          }
          hint={
            hardRoom <= 0
              ? `已达绝对上限 ${CONFIG.team.hardMaxRoster} 人，需先解约或出售`
              : room > 0
                ? `常规上限内还可签 ${room} 人`
                : room === 0
                  ? `已到常规上限，仍可签约（绝对上限 ${CONFIG.team.hardMaxRoster}）`
                  : `超出常规上限 ${-room} 人：替补归属感下降更快、工资照付`
          }
        />
        <Stat label="俱乐部荣誉" value={Math.round(num(team.honor))} hint="荣誉越高，选手越愿意加盟" />
        <Stat label="每回合工资" value={<Gold value={wage} />} hint="选手 + 教练" />
        <Stat
          label="待处理报价"
          value={<span className={cx(pendingOffers > 0 && 'text-gold')}>{pendingOffers}</span>}
          hint={pendingOffers > 0 ? '请尽快答复，报价会过期' : '暂无'}
        />
      </div>

      <Tabs<TabKey>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'free', label: '自由选手', badge: <span className="text-[11px] text-faint tabular">{faCount}</span> },
          { key: 'transfer', label: '转会求购' },
          {
            key: 'offers',
            label: '收到的报价',
            badge: pendingOffers > 0 ? <span className="rounded-full bg-gold px-1.5 text-[10px] font-bold text-black">{pendingOffers}</span> : undefined,
          },
          {
            key: 'listing',
            label: '我的挂牌',
            badge: listed.length > 0 ? (
              <span
                className={cx('rounded-full px-1.5 text-[10px] font-bold', listingOfferCount > 0 ? 'bg-gold text-black' : 'bg-panel-3 text-mute')}
                title={listingOfferCount > 0 ? `挂牌选手收到 ${listingOfferCount} 份报价` : `${listed.length} 名选手挂牌中`}
              >
                {listed.length}
              </span>
            ) : undefined,
          },
          {
            key: 'temp',
            label: '临时替补',
            badge: subNeeded ? <span className="rounded-full bg-dota px-1.5 text-[10px] font-bold text-white" title="即将参加的赛事首发不完整">!</span> : undefined,
          },
        ]}
      />

      {/* 不用 fade-up（transform）包裹：子页里的弹窗（报价 / 签约确认，position: fixed）需要以视口为包含块 */}
      <div key={tab}>
        {tab === 'free' && <MarketFreeAgents windowOpen={windowOpen} />}
        {tab === 'transfer' && <MarketTransferList windowOpen={windowOpen} />}
        {tab === 'offers' && <MarketOffers windowOpen={windowOpen} />}
        {tab === 'listing' && <MarketListings windowOpen={windowOpen} />}
        {tab === 'temp' && <MarketTempSubs />}
      </div>
    </div>
  );
}

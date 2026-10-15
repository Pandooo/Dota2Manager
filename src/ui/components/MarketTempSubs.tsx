// 转会市场 · 临时替补（野外替补）：签证/伤病/首发不足时，为即将参加的赛事雇佣仅效力一项赛事的替补
import { useState } from 'react';
import { useCall, useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, POSITIONS, ageOf, currentPlayerTournament, effectiveAttr, effectivePower, formatGold,
  isAvailable, lineupPlayers, playerTier, teamPlayers, tempSubCost, validateLineup, POSITION_LABEL,
  REGION_LABEL, TOURNAMENT_TIER_LABEL, naturalPositions,
  type GameState, type Player, type Position, type Tournament,
} from '../../engine';
import { Badge, Button, Card, EmptyState, Gold, PlayerLink, PosBadge, TierBadge, cx } from './common';
import { AttrNum, BODY_FLUSH, Banner, Facts, Field, PHONE_LINK, PhoneList, PhoneRow, Select, TableWrap, num, safe, useCompactList } from './MarketKit';

/** 替补目标赛事：当前回合参加的赛事，否则赛程中下一项已报名/受邀且未结束的赛事 */
export function tempSubTargetTournament(g: GameState): Tournament | null {
  const cur = safe(() => currentPlayerTournament(g), null);
  if (cur && cur.status !== 'finished') return cur;
  const me = g.settings.playerTeamId;
  const ids = Array.isArray(g.seasonTournamentIds) ? g.seasonTournamentIds : [];
  // 与 market.hireTempSub 的参赛判定一致：受邀/已报名，或已在参赛名单（含封闭预选）中
  const entered = (t: Tournament) =>
    t.playerStatus === 'invited' ||
    t.playerStatus === 'registered' ||
    (t.playerStatus !== 'declined' && ((t.teamIds ?? []).includes(me) || (t.qualifierTeamIds ?? []).includes(me)));
  const upcoming = ids
    .map((id) => g.tournaments[id])
    .filter((t): t is Tournament => !!t && t.status !== 'finished' && entered(t) && t.roundIndex >= g.roundIndex)
    .sort((a, b) => a.roundIndex - b.roundIndex || a.startDate.localeCompare(b.startDate));
  return upcoming[0] ?? null;
}

/** 目标赛事下首发空缺/不可用的位置 */
export function missingPositions(g: GameState, tid: string | null): Position[] {
  const me = g.settings.playerTeamId;
  const slots = safe(() => lineupPlayers(g, me), [] as { pos: Position; player: Player | null }[]);
  return slots
    .filter(({ player }) => !player || !isAvailable(player, tid) || (!!player.tempSubUntilTournament && player.tempSubUntilTournament !== tid))
    .map(({ pos }) => pos);
}

export default function MarketTempSubs() {
  const g = useGame();
  const call = useCall();
  const callSilent = useCallSilent();
  const toast = useGameStore((s) => s.toast);
  const phone = useCompactList();
  const setView = useGameStore((s) => s.setView);
  const me = g.settings.playerTeamId;
  const team = g.teams[me];

  const target = tempSubTargetTournament(g);
  const tid = target?.id ?? null;
  const missing = missingPositions(g, tid);
  const [pos, setPos] = useState<'any' | Position>(missing[0] ?? 'any');

  const roster = safe(() => teamPlayers(g, me), [] as Player[]);
  const tempSubs = roster.filter((p) => p.tempSubUntilTournament);
  const unavailable = tid ? roster.filter((p) => !isAvailable(p, tid)) : [];
  const availableCount = tid
    ? roster.filter((p) => isAvailable(p, tid) && (!p.tempSubUntilTournament || p.tempSubUntilTournament === tid)).length
    : roster.length;
  const lineupErrors = tid ? safe(() => validateLineup(g, me, tid), [] as string[]) : [];
  const visaDecisions = (g.pendingDecisions ?? []).filter((d) => d.kind === 'visa');
  // 临时替补不受阵容人数上限限制；与 market.hireTempSub 一致，只限制同时在队的临时替补人数
  const tempMax = Math.max(1, Math.floor(num(CONFIG.market.tempSubMax)));
  const regularCount = roster.length - tempSubs.length;
  const gold = num(team?.gold);

  const candidates = (g.tempSubCandidates ?? [])
    .map((id) => g.players[id])
    .filter((p): p is Player => !!p && p.status === 'active' && !p.teamId);

  const findBlock = !team ? '找不到你的战队' : g.gameOver ? '游戏已结束' : !target ? '暂无即将参加的赛事，无需临时替补' : null;
  const search = () => {
    if (findBlock) return;
    void callSilent('generateTempSubCandidates', pos === 'any' ? undefined : pos).then((res) => {
      if (Array.isArray(res)) toast(res.length ? `在野外找到 ${res.length} 名候选替补` : '野外暂时没有合适的替补', res.length > 0);
    });
  };

  const hireBlock = (cost: number): string | null => {
    if (g.gameOver) return '游戏已结束';
    if (!target || !tid) return '暂无即将参加的赛事';
    if (tempSubs.length >= tempMax) return `临时替补已有 ${tempMax} 人，无需再招募`;
    if (gold < cost) return `金币不足（需要 ${formatGold(cost)}，当前 ${formatGold(gold)}）`;
    return null;
  };

  // 一键补齐（引擎 fillLineupWithTempSubs）：仅对本回合正在参加的赛事可用
  const current = safe(() => currentPlayerTournament(g), null);
  const autoFillBlock = !team
    ? '找不到你的战队'
    : !current || current.id !== tid
      ? '一键补齐仅在赛事回合可用（本回合没有你的赛事）'
      : lineupErrors.length === 0
        ? '首发阵容已完整，无需补齐'
        : null;
  const autoFill = () => {
    if (autoFillBlock) return;
    void call('fillLineupWithTempSubs');
  };

  const hireButton = (p: Player, cost: number, block: string | null, className?: string) => (
    <Button
      size={phone ? 'sm' : 'xs'}
      variant={block ? 'secondary' : 'primary'}
      className={className}
      disabled={!!block}
      title={block ?? `雇佣为「${target?.name}」临时替补，费用 ${formatGold(cost)}`}
      onClick={() => tid && void call('hireTempSub', p.id, tid)}
    >
      雇佣
    </Button>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        {/* 目标赛事 + 阵容状态 */}
        <Card title="替补需求" subtitle="临时替补只效力一项赛事，赛事结束后自动离队，费用远低于正式签约">
          {!target ? (
            <EmptyState text="当前没有即将参加的赛事。">
              <span className="text-xs text-faint">在「赛程报名」报名赛事后，若遇到签证问题或首发不足，可以回到这里寻找野外替补。</span>
              <Button size="sm" onClick={() => setView('schedule')}>前往赛程报名</Button>
            </EmptyState>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <div className="text-base font-semibold">{target.name}</div>
                <Badge className="bg-gold/15 text-gold">{TOURNAMENT_TIER_LABEL[target.tier]}</Badge>
                <span className="text-xs text-mute">
                  第 {target.roundIndex} 回合 · {target.startDate} · {target.online ? '线上赛' : `${target.city}（${REGION_LABEL[target.hostRegion]}）`}
                </span>
                {target.status === 'running' && <Badge className="bg-dota/20 text-dota-2">进行中</Badge>}
              </div>
              {/* 手机：三格只放数字，说明合并成格子下方的一行小字 */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-md border border-line px-2.5 py-2 sm:px-3">
                  <div className="text-faint">可出战选手</div>
                  <div className={cx('text-lg font-semibold tabular', availableCount < 5 ? 'text-bad' : 'text-ink')}>
                    {availableCount}<span className="text-xs text-faint max-sm:hidden">（首发需 5 人）</span>
                  </div>
                </div>
                <div className="rounded-md border border-line px-2.5 py-2 sm:px-3">
                  <div className="text-faint">无法参赛</div>
                  <div className={cx('text-lg font-semibold tabular', unavailable.length ? 'text-gold' : 'text-ink')}>{unavailable.length}</div>
                </div>
                <div className="rounded-md border border-line px-2.5 py-2 sm:px-3">
                  <div className="text-faint">阵容人数</div>
                  <div className="text-lg font-semibold tabular">
                    {regularCount}
                    <span className="text-xs text-faint">
                      {' '}/ {CONFIG.team.maxRoster}
                      {tempSubs.length ? <span className="max-sm:hidden"> + 临时替补 {tempSubs.length}</span> : null}
                      <span className="max-sm:hidden">（临时替补不占阵容名额，同时最多 {tempMax} 人）</span>
                    </span>
                  </div>
                </div>
              </div>
              <div className="-mt-1.5 text-[11px] leading-snug text-faint sm:hidden">
                首发需 5 人；临时替补不占阵容名额（当前 {tempSubs.length} 人，同时最多 {tempMax} 人）
              </div>
              {unavailable.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-mute">无法参加本赛事：</span>
                  {unavailable.map((p) => (
                    <span key={p.id} className="inline-flex items-center gap-1 rounded border border-gold/30 bg-gold/5 px-1.5 py-0.5">
                      <PosBadge pos={p.position} alt={p.altPositions} /> <PlayerLink player={p} />
                      <span className="text-faint">{p.status !== 'active' ? '禁赛' : '签证/伤病'}</span>
                    </span>
                  ))}
                </div>
              )}
              {lineupErrors.length > 0 ? (
                <Banner tone="warn" title={`首发存在 ${lineupErrors.length} 个问题`}
                  actions={
                    <>
                      {!autoFillBlock && (
                        <Button size="sm" variant="primary" onClick={autoFill} title="为每个空缺位置自动雇佣评分最高、负担得起的野外替补">
                          一键补齐
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setView('squad')}>调整阵容</Button>
                    </>
                  }>
                  {lineupErrors.slice(0, 4).join('；')}
                  {missing.length > 0 && <>。缺口位置：{missing.map((m) => POSITION_LABEL[m]).join('、')}</>}
                </Banner>
              ) : (
                <Banner tone="good" title="首发阵容完整">当前首发可以正常参加该赛事，无需临时替补（也可提前储备）。</Banner>
              )}
              {visaDecisions.length > 0 && (
                <Banner tone="info" title="有待处理的签证事件"
                  actions={<Button size="sm" onClick={() => setView('inbox')}>去消息中心</Button>}>
                  签证事件可在消息中心选择「用现有替补顶上」或「从野外找替补」。
                </Banner>
              )}
            </div>
          )}
        </Card>

        {/* 候选 */}
        <Card
          title="野外候选替补"
          subtitle={`每次搜索生成 ${CONFIG.tempSub.candidates} 名候选，等级分布受俱乐部荣誉影响`}
          actions={
            <div className="flex flex-wrap items-end gap-2">
              <Field label="位置">
                <Select value={pos} onChange={(e) => setPos(e.target.value as 'any' | Position)}>
                  <option value="any">任意位置</option>
                  {POSITIONS.map((x) => (
                    <option key={x} value={x}>
                      {POSITION_LABEL[x]}{missing.includes(x) ? '（缺）' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="primary" disabled={!!findBlock} title={findBlock ?? '在野外寻找候选替补（免费）'} onClick={search}>
                去野外找替补
              </Button>
            </div>
          }
          bodyClassName={BODY_FLUSH}
        >
          {candidates.length === 0 ? (
            <EmptyState text="还没有候选替补。">
              <span className="text-xs text-faint">选择位置后点击「去野外找替补」。</span>
            </EmptyState>
          ) : phone ? (
            <PhoneList>
              {candidates.map((p) => {
                const cost = safe(() => tempSubCost(g, p.id), 0);
                const block = hireBlock(cost);
                return (
                  <PhoneRow
                    key={p.id}
                    head={
                      <>
                        <TierBadge tier={playerTier(p)} />
                        <PlayerLink player={p} className={PHONE_LINK} />
                        {p.isReal && <span className="text-[10px] text-gold">真实选手</span>}
                        <span className="text-[10px] text-faint">{p.nationality ?? ''}</span>
                        <PosBadge pos={p.position} alt={p.altPositions} />
                        {naturalPositions(p).some((q) => missing.includes(q)) && <span className="text-[10px] text-gold">补缺</span>}
                      </>
                    }
                    action={hireButton(p, cost, block, 'min-h-10 min-w-16')}
                  >
                    <Facts
                      items={[
                        ['战力', <span className="font-semibold"><AttrNum value={effectivePower(p)} digits={1} /></span>],
                        ['灵性', <AttrNum value={effectiveAttr(p, 'insight')} />],
                        ['韧性', <AttrNum value={effectiveAttr(p, 'resilience')} />],
                        ['年龄', <span className="tabular text-ink">{ageOf(g, p)}</span>],
                      ]}
                    />
                    <Facts
                      items={[
                        ['雇佣费', <Gold value={cost} className="font-semibold" />],
                        ['工资', <><Gold value={num(p.salary)} />/回合</>],
                      ]}
                    />
                  </PhoneRow>
                );
              })}
            </PhoneList>
          ) : (
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>选手</th>
                    <th>位置</th>
                    <th className="num">年龄</th>
                    <th>等级</th>
                    <th className="num">战力</th>
                    <th className="num">灵性</th>
                    <th className="num">韧性</th>
                    <th className="num" title="在队期间按回合领取的工资">工资/回合</th>
                    <th className="num" title="仅效力一项赛事的一次性费用">雇佣费</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((p) => {
                    const cost = safe(() => tempSubCost(g, p.id), 0);
                    const block = hireBlock(cost);
                    return (
                      <tr key={p.id}>
                        <td>
                          <div className="flex items-center gap-1.5">
                            <PlayerLink player={p} />
                            {p.isReal && <span className="text-[10px] text-gold" title="真实选手">真</span>}
                            <span className="text-[10px] text-faint">{p.nationality ?? ''}</span>
                          </div>
                        </td>
                        <td>
                          <PosBadge pos={p.position} alt={p.altPositions} />
                          {naturalPositions(p).some((q) => missing.includes(q)) && <span className="ml-1 text-[10px] text-gold">补缺</span>}
                        </td>
                        <td className="num">{ageOf(g, p)}</td>
                        <td><TierBadge tier={playerTier(p)} /></td>
                        <td className="num font-semibold"><AttrNum value={effectivePower(p)} digits={1} /></td>
                        <td className="num"><AttrNum value={effectiveAttr(p, 'insight')} /></td>
                        <td className="num"><AttrNum value={effectiveAttr(p, 'resilience')} /></td>
                        <td className="num text-mute"><Gold value={num(p.salary)} /></td>
                        <td className="num font-semibold"><Gold value={cost} /></td>
                        <td className="text-right">{hireButton(p, cost, block)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      {/* 右栏：说明 + 当前临时替补 */}
      <div className="space-y-4">
        <Card title="当前临时替补">
          {tempSubs.length === 0 ? (
            <div className="py-3 text-center text-xs text-mute">队中暂无临时替补。</div>
          ) : (
            <div className="space-y-2">
              {tempSubs.map((p) => {
                const t = p.tempSubUntilTournament ? g.tournaments[p.tempSubUntilTournament] : undefined;
                return (
                  <div key={p.id} className="flex items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2.5 py-2">
                    <TierBadge tier={playerTier(p)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm">
                        <PlayerLink player={p} /> <PosBadge pos={p.position} alt={p.altPositions} />
                      </div>
                      <div className="truncate text-[11px] text-faint">效力：{t?.name ?? '指定赛事'} · 赛后自动离队</div>
                    </div>
                    <span className="text-xs tabular text-mute">{effectivePower(p).toFixed(1)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
        <Card title="什么时候需要临时替补？">
          <ul className="space-y-2 text-xs leading-relaxed text-mute">
            <li><span className="text-gold">签证问题</span>：赴北美等线下赛事时，CN/SEA/CIS/SA 选手较易被拒签，无法参赛。</li>
            <li><span className="text-gold">首发不足 5 人</span>：伤病、禁赛、出售或离队导致首发空缺时，赛事无法开打。</li>
            <li><span className="text-gold">费用低廉</span>：一次性雇佣费为该等级基础工资（单回合）的 {Math.round(CONFIG.tempSub.costMult * 100)}%，在队期间另按回合领工资；不占正式阵容名额，阵容再满也能招募（同时最多 {CONFIG.market.tempSubMax} 人）。</li>
            <li><span className="text-gold">候选刷新</span>：每次搜索会替换上一批候选；不指定位置时优先补全阵容缺失的位置。</li>
            <li><span className="text-gold">荣誉影响</span>：俱乐部荣誉越高，野外越容易遇到高等级选手。</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

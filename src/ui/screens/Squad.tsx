// 阵容页：首发编辑（5 个位置）+ 全部选手可排序列表
import { useState, type ReactNode } from 'react';
import { useCall, useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, POSITIONS, POSITION_LABEL, POSITION_SHORT, ageOf, currentPlayerTournament, effectiveAttr,
  getCoach, getPlayerTeam, marketValue, overallRating, playerRating, playerTier, rankTeamsByRating,
  rosterRoom, roundWageBill, teamInsight, teamRating, validateLineup, releaseCompensation,
  isTransferWindowOpen, formatGold, activeListing, listingDurationLabel, listingProgress, teamBuildingCost,
  teamBuildingDoneThisRound, SALARY_MOOD_LABEL, playerSalaryMood, ROLE_FIT_LABEL, roleFit, roleFitFactor,
} from '../../engine';
import type { GameState, Player, Position, RoleFit, SalaryMood, Team, Tournament } from '../../engine';
import {
  Button, Card, EmptyState, Gold, Hint, PlayerLink, PosBadge, Stat, TierBadge, cx,
} from '../components/common';
import { ConfirmButton } from '../components/ConfirmPopover';
import { SquadSynergyStrip } from '../components/SynergyKit';
import { ScreenHeader } from '../layout/HubKit';
import {
  Chip, Flag, PowerValue, SortTh, fmt1, loyaltyClass, modifierDuration, modifierPositive, modifierText, MOD_ATTR_LABEL,
  safe, sortList, upcomingPlayerTournament, useSort, ROLE_FIT_TEXT, RoleFitChip, roleFitTitle,
} from '../components/SquadShared';

type SortKey =
  | 'lineup' | 'handle' | 'pos' | 'age' | 'mmr' | 'power' | 'talent' | 'resilience' | 'insight' | 'loyalty'
  | 'mood' | 'rating' | 'salary' | 'contract' | 'value';

/** 选手在本队首发中的位置（不在首发 → null） */
function starterSlotMap(team: Team): Map<string, Position> {
  const m = new Map<string, Position>();
  for (const pos of POSITIONS) {
    const id = team.lineup?.[pos];
    if (id) m.set(id, pos);
  }
  return m;
}

/** 有效归属感（引擎的离队/挖角判定均基于有效值） */
function loyaltyOf(p: Player): number {
  return safe(() => effectiveAttr(p, 'loyalty'), p.loyalty);
}

/** 薪资满意度（定性；临时替补 / 非 active 不适用 → null）。隐藏的预期薪资不以数值展示 */
function salaryMoodOf(game: GameState, p: Player): SalaryMood | null {
  if (p.status !== 'active' || p.tempSubUntilTournament || p.isWildSub) return null;
  return safe(() => playerSalaryMood(game, p), null);
}

const MOOD_LEVEL: Record<SalaryMood, number> = { satisfied: 0, mild: 1, strong: 2 };

/** 薪资满意度小图标：笑脸 / 平 / 皱眉（颜色同语义） */
function SalaryMoodIcon({ mood }: { mood: SalaryMood }) {
  const color = mood === 'satisfied' ? 'text-good' : mood === 'mild' ? 'text-gold' : 'text-bad';
  const mouth = mood === 'satisfied' ? 'M5 9.6 Q8 12.2 11 9.6' : mood === 'mild' ? 'M5.4 10.6 H10.6' : 'M5 11.6 Q8 9 11 11.6';
  const label = `薪资满意度：${SALARY_MOOD_LABEL[mood]}`;
  return (
    <span title={label} className={cx('inline-flex', color)}>
      <svg viewBox="0 0 16 16" className="h-4 w-4" role="img" aria-label={label}>
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="5.8" cy="6.4" r="0.95" fill="currentColor" />
        <circle cx="10.2" cy="6.4" r="0.95" fill="currentColor" />
        <path d={mouth} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** 选手因签证/伤病无法参加的（未结束）赛事 */
function blockedTournaments(game: GameState, p: Player): Tournament[] {
  const out: Tournament[] = [];
  for (const id of p.unavailableTournamentIds ?? []) {
    const t = game.tournaments[id];
    if (t && t.status !== 'finished') out.push(t);
  }
  return out;
}

export default function Squad() {
  const game = useGame();
  const call = useCall();
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const openPlayer = useGameStore((s) => s.openPlayer);
  const sort = useSort<SortKey>('lineup', 'asc');
  // 批量解约：多选
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const team = safe(() => getPlayerTeam(game), null as Team | null);
  if (!team) {
    return (
      <Card title="阵容">
        <EmptyState text="找不到玩家战队数据，请重新读取存档。" />
      </Card>
    );
  }

  const maxRoster = CONFIG.team.maxRoster;
  const seen = new Set<string>();
  const roster: Player[] = [];
  for (const id of team.playerIds ?? []) {
    const p = game.players[id];
    if (!p || seen.has(id)) continue;
    seen.add(id);
    roster.push(p);
  }
  const active = roster.filter((p) => p.status === 'active');
  const slotOf = starterSlotMap(team);
  const regularCount = active.filter((p) => !p.tempSubUntilTournament).length;
  const room = safe(() => rosterRoom(game, team.id), maxRoster - regularCount);

  const curT = safe(() => currentPlayerTournament(game), null as Tournament | null);
  const ctxT = curT ?? upcomingPlayerTournament(game);
  const errors = safe(() => validateLineup(game, team.id, ctxT?.id ?? null), [] as string[]);

  const rating = safe(() => teamRating(game, team.id), 0);
  const insight = safe(() => teamInsight(game, team.id), 0);
  const ranking = safe(() => rankTeamsByRating(game), [] as string[]);
  const rank = ranking.indexOf(team.id) + 1;
  const coach = safe(() => getCoach(game, team.id), null);
  const coachBonus = coach ? Math.max(0, coach.insight) * CONFIG.coach.ratingBonusPerInsight : 0;
  const wage = safe(() => roundWageBill(game, team.id), active.reduce((s, p) => s + (p.salary || 0), 0));

  const starters = POSITIONS.map((pos) => {
    const id = team.lineup?.[pos];
    const p = id ? game.players[id] : undefined;
    return { pos, player: p && p.status === 'active' && p.teamId === team.id ? p : null };
  });
  const filled = starters.filter((s) => s.player) as { pos: Position; player: Player }[];
  const avgPower = filled.length ? filled.reduce((s, x) => s + safe(() => effectiveAttr(x.player, 'power'), x.player.power), 0) / filled.length : 0;
  const avgAge = filled.length ? filled.reduce((s, x) => s + ageOf(game, x.player), 0) / filled.length : 0;

  const assign = (pos: Position, id: string) => void callSilent('setLineupSlot', team.id, pos, id || null);

  const doAuto = () => void call('autoArrangeLineup', ctxT?.id ?? null);

  // 本回合赛事首发不合法 → 可一键临时招募补齐（引擎：仅在本回合有赛事时可用）
  const canFillTemp = !!curT && errors.length > 0;
  const doFillTemp = () => void call('fillLineupWithTempSubs');

  // ---------------- 排序 ----------------
  const sortValue = (p: Player): number | string => {
    switch (sort.key) {
      case 'lineup': {
        const slot = slotOf.get(p.id);
        if (p.status !== 'active') return 100;
        if (slot) return POSITIONS.indexOf(slot);
        return 10 + POSITIONS.indexOf(p.position) - safe(() => overallRating(p), 0) / 1000;
      }
      case 'handle': return p.handle.toLowerCase();
      case 'pos': return POSITIONS.indexOf(p.position);
      case 'age': return ageOf(game, p);
      case 'mmr': return safe(() => effectiveAttr(p, 'mmr'), p.mmr);
      case 'power': return safe(() => effectiveAttr(p, 'power'), p.power);
      case 'talent': return p.talent;
      case 'resilience': return p.resilience;
      case 'insight': return p.insight;
      case 'loyalty': return loyaltyOf(p);
      case 'mood': {
        const m = salaryMoodOf(game, p);
        return m ? MOOD_LEVEL[m] : -1;
      }
      case 'rating': return safe(() => overallRating(p), 0);
      case 'salary': return p.salary;
      case 'contract': return p.contractUntil;
      case 'value': return safe(() => marketValue(game, p), 0);
    }
  };
  const rows = sortList(roster, sortValue, sort.dir);

  // ---- 批量解约 ----
  const windowOpen = safe(() => isTransferWindowOpen(game), false);
  const canRelease = (p: Player) => p.status === 'active' && !p.tempSubUntilTournament;
  const releasable = active.filter(canRelease);
  const selectedPlayers = releasable.filter((p) => selected.has(p.id));
  const totalComp = selectedPlayers.reduce((sum, p) => sum + safe(() => releaseCompensation(game, p.id), 0), 0);
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ---- 批量挂牌（标价 = 身价）----
  const listable = selectedPlayers.filter((p) => !safe(() => activeListing(game, p), null));

  // ---- 团建 ----
  const tbCost = safe(() => teamBuildingCost(game), CONFIG.squadOps.teamBuildingCost);
  const tbDone = safe(() => teamBuildingDoneThisRound(game), false);
  const tbMembers = active.filter((p) => !p.tempSubUntilTournament).length;
  const tbBlock = game.gameOver
    ? '游戏已结束'
    : tbDone
      ? '本回合已组织过团建，下回合再安排'
      : tbMembers === 0
        ? '队中没有可参加团建的正式队员'
        : team.gold < tbCost
          ? `金币不足（需要 ${formatGold(tbCost)}，账上 ${formatGold(team.gold)}）`
          : '';
  const [tbLo, tbHi] = CONFIG.squadOps.teamBuildingLoyalty;

  const totalValue = active.reduce((s, p) => s + safe(() => marketValue(game, p), 0), 0);
  const totalSalary = active.reduce((s, p) => s + (p.salary || 0), 0);

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="阵容"
        subtitle={
          <>
            {team.name} · TI{game.season.ti} 赛季 · 阵容 <span className={cx('tabular', room < 0 && 'text-gold')}>{regularCount}/{maxRoster}</span>
            <span title={`常规上限 ${maxRoster} 人可以超出（不影响推进）；签约 / 求购的绝对上限 ${CONFIG.team.hardMaxRoster} 人`}>
              {room > 0
                ? `（常规上限内还可签 ${room} 人）`
                : room === 0
                  ? '（已到常规上限，仍可签约）'
                  : `（超出常规上限 ${-room} 人：替补归属感下降更快、工资照付${
                    regularCount >= CONFIG.team.hardMaxRoster ? `；已达签约绝对上限 ${CONFIG.team.hardMaxRoster} 人` : ''
                  }）`}
            </span>
          </>
        }
        actions={
          <>
            <Button
              variant="gold"
              size="sm"
              disabled={!!tbBlock}
              title={
                tbBlock ||
                `花费 ${formatGold(tbCost)} 组织全队团建：每名正式队员归属感 +${tbLo}~${tbHi}（越高收益越小），韧性 +${CONFIG.squadOps.teamBuildingResilience}。每回合一次`
              }
              onClick={() => void call('teamBuilding')}
            >
              {tbDone ? '✓ 本回合已团建' : `团建（${formatGold(tbCost)}）`}
            </Button>
          </>
        }
        nav={
          <>
            <Button variant="ghost" size="sm" onClick={() => setView('training')}>训练</Button>
            <Button variant="ghost" size="sm" onClick={() => setView('coach')}>教练</Button>
            <Button variant="secondary" size="sm" onClick={() => setView('market')}>转会市场</Button>
          </>
        }
      />

      {/* 羁绊（第十波 #5）：本队激活的羁绊；没有时若已集齐某个已解锁羁绊的 4 人则提示差谁（都没有则不渲染） */}
      <SquadSynergyStrip game={game} teamId={team.id} />

      {/* ---------------- 首发编辑 ---------------- */}
      <Card
        title="首发阵容"
        subtitle={ctxT ? `按「${ctxT.name}」校验参赛资格（第 ${ctxT.roundIndex} 回合）` : '当前没有待参加的赛事'}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={doAuto}
            disabled={active.length === 0}
            title={active.length === 0 ? '阵容中没有可上场的选手' : '在全部可用选手中搜索评分之和最高的首发组合'}
          >
            ⚡ 自动排阵
          </Button>
        }
      >
        {active.length === 0 ? (
          <EmptyState text="阵容中没有可上场的选手。去转会市场签约自由选手，或在赛季初的新秀选秀中挑选新人。">
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setView('market')}>前往转会市场</Button>
              <Button size="sm" variant="gold" onClick={() => setView('draft')}>新秀选秀</Button>
            </div>
          </EmptyState>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {starters.map(({ pos, player }) => (
                <SlotCard
                  key={pos}
                  game={game}
                  pos={pos}
                  player={player}
                  options={active}
                  slotOf={slotOf}
                  ctxT={ctxT}
                  onAssign={(id) => assign(pos, id)}
                />
              ))}
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                <Stat
                  label="战队评分"
                  value={<span className="text-gold">{fmt1(rating)}</span>}
                  hint={rank > 0 ? `全联盟第 ${rank} / ${ranking.length}` : '五名首发评分之和 + 教练加成'}
                />
                <Stat label="战队灵性" value={fmt1(insight)} hint={coach ? `含教练权重 ${Math.round(CONFIG.coach.insightWeightInDraft * 100)}%` : '首发灵性均值（无教练）'} />
                <Stat label="教练加成" value={coach ? `+${fmt1(coachBonus)}` : '—'} hint={coach ? coach.name : '教练岗位空缺'} />
                <Stat label="首发均战力" value={filled.length ? fmt1(avgPower) : '—'} hint="有效战力" />
                <Stat label="首发均年龄" value={filled.length ? avgAge.toFixed(1) : '—'} hint="≥26 岁战力开始衰减" />
                <Stat label="每回合工资" value={<Gold value={wage} />} hint="选手 + 教练" />
              </div>
              <div
                className={cx(
                  'rounded-lg border px-3 py-2.5 text-sm',
                  errors.length ? 'border-bad/40 bg-bad/5' : 'border-good/40 bg-good/5',
                )}
              >
                {errors.length === 0 ? (
                  <div className="text-good">
                    <div className="font-semibold">✓ 阵容完整</div>
                    <div className="mt-1 text-xs text-mute">
                      五个位置均有可上场的首发{ctxT ? `，可以参加「${ctxT.name}」` : ''}。
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mb-1 font-semibold text-bad">阵容问题（{errors.length}）</div>
                    <ul className="space-y-0.5 text-xs text-[#ffb4b4]">
                      {errors.map((e, i) => (
                        <li key={i}>· {e}</li>
                      ))}
                    </ul>
                    <div className="mt-2 text-[11px] text-mute">
                      赛事回合首发不合法将无法推进，可使用「自动排阵」或在转会市场临时招募替补。
                    </div>
                    {canFillTemp && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button
                          size="xs"
                          variant="gold"
                          onClick={doFillTemp}
                          title={`先自动排阵，仍有空位时为「${curT?.name ?? '本回合赛事'}」从野外招募评分最高、负担得起的临时替补（扣除费用）`}
                        >
                          一键补齐首发
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setView('market')}>
                          手动挑选替补
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <Hint className="mt-3">
              选手评分 = 有效战力 × 天梯倍数 × 位置系数（本位置 ×1；副位置 ×{CONFIG.team.altRoleFactor}；四五号位互换 ×
              {CONFIG.team.supportSwapFactor}；其他非本位置 ×{CONFIG.team.offRoleFactor}。副位置是真实生涯中担任过的其他位置，真实选手的本位置
              随真实生涯在新赛季调整）；战队评分 = 五名首发评分之和 + 教练灵性 ×
              {CONFIG.coach.ratingBonusPerInsight}。在下拉框中选择已在其他位置的首发，会与该位置互换。首发训练获得全额收益，替补 ×
              {CONFIG.growth.benchTrainingMult}，且连续替补超过 {CONFIG.loyalty.benchGraceRounds} 回合会降低归属感；阵容超出常规上限
              （{maxRoster} 人）时，每多 1 人替补归属感下降更快，所有签约选手的工资照付。
            </Hint>
          </>
        )}
      </Card>

      {/* ---------------- 全部选手 ---------------- */}
      <Card
        title={
          <>
            全部选手 <span className="ml-1 text-mute tabular">{regularCount}/{maxRoster}</span>
          </>
        }
        subtitle="点击表头排序，点击选手查看详情"
        bodyClassName="p-0"
        actions={
          <div className="flex items-center gap-3 text-xs text-mute">
            {selectedPlayers.length > 0 && (
              <span className="flex items-center gap-2">
                <span className="text-ink">已选 {selectedPlayers.length} 人</span>
                <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
                  清空
                </Button>
                <ConfirmButton
                  size="xs"
                  variant="gold"
                  disabled={!windowOpen || listable.length === 0}
                  title={
                    !windowOpen
                      ? '转会窗口已锁定（TI 阶段），无法挂牌'
                      : listable.length === 0
                        ? '选中的选手均已在挂牌中'
                        : `将选中的选手按身价挂牌出售（挂牌期为${safe(() => listingDurationLabel(), '一整个赛季')}，整个挂牌期没有收到任何报价则自动解约，无补偿）`
                  }
                  confirm={{
                    title: `批量挂牌（${listable.length} 人）`,
                    confirmLabel: '确认挂牌',
                    message: (
                      <>
                        <PlayerConfirmList
                          players={listable}
                          right={(p) => (
                            <>
                              标价 <Gold value={safe(() => marketValue(game, p), 0)} />
                            </>
                          )}
                        />
                        <span className="mt-1.5 block">
                          标价 = 身价。挂牌期为{safe(() => listingDurationLabel(), '一整个赛季')}，期间报价在「转会市场 → 我的挂牌」处理；
                          整个挂牌期没有收到任何报价则自动解约（无补偿、不扣荣誉），收到过报价则期满后挂牌结束、选手留队。自定义标价请在选手详情中单独挂牌。
                        </span>
                      </>
                    ),
                  }}
                  onConfirm={() => {
                    void call('listPlayersForTransfer', listable.map((p) => p.id));
                    setSelected(new Set());
                  }}
                >
                  批量挂牌（{listable.length}）
                </ConfirmButton>
                <ConfirmButton
                  size="xs"
                  variant="danger"
                  disabled={!windowOpen}
                  title={windowOpen ? '对选中的选手批量解约' : '转会窗口已锁定（TI 阶段），无法解约'}
                  confirm={{
                    title: `批量解约（${selectedPlayers.length} 人）`,
                    confirmLabel: '确认解约',
                    danger: true,
                    message: (
                      <>
                        <PlayerConfirmList
                          players={selectedPlayers}
                          right={(p) => (
                            <>
                              补偿 <Gold value={safe(() => releaseCompensation(game, p.id), 0)} />
                            </>
                          )}
                        />
                        <span className="mt-1.5 block">
                          共需支付补偿 <b className="text-bad">{formatGold(totalComp)}</b>
                          {CONFIG.honor.transfer.releasePenalty
                            ? `；提前解约每人荣誉 ${CONFIG.honor.transfer.releasePenalty}（合同已到期者不扣）`
                            : ''}
                          。解约后选手成为自由选手。
                        </span>
                      </>
                    ),
                  }}
                  onConfirm={() => {
                    void call('releasePlayers', selectedPlayers.map((p) => p.id));
                    setSelected(new Set());
                  }}
                >
                  批量解约（{selectedPlayers.length}）
                </ConfirmButton>
              </span>
            )}
            <span>
              身价合计 <Gold value={totalValue} />
            </span>
            <span>
              工资合计 <Gold value={totalSalary} />/回合
            </span>
          </div>
        }
      >
        {roster.length === 0 ? (
          <EmptyState text="还没有签约任何选手。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-8" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="cursor-pointer accent-[var(--color-dota)]"
                      title="全选（可挂牌 / 解约的选手）"
                      checked={releasable.length > 0 && releasable.every((p) => selected.has(p.id))}
                      onChange={(e) => setSelected(e.target.checked ? new Set(releasable.map((p) => p.id)) : new Set())}
                    />
                  </th>
                  <SortTh k="lineup" sort={sort} defaultDir="asc" title="按首发位置 → 替补排序">阵位</SortTh>
                  <SortTh k="handle" sort={sort} defaultDir="asc">选手</SortTh>
                  <SortTh k="pos" sort={sort} defaultDir="asc">位置</SortTh>
                  <SortTh k="age" sort={sort} className="num" defaultDir="asc">年龄</SortTh>
                  <SortTh k="mmr" sort={sort}>天梯</SortTh>
                  <SortTh k="power" sort={sort} className="num" title="基础 → 有效（存在临时状态时）">战力</SortTh>
                  <SortTh k="talent" sort={sort} className="num">天赋</SortTh>
                  <SortTh k="resilience" sort={sort} className="num">韧性</SortTh>
                  <SortTh k="insight" sort={sort} className="num">灵性</SortTh>
                  <SortTh k="loyalty" sort={sort} className="num" title={`低于 ${CONFIG.loyalty.leaveThreshold} 可能申请离队或被挖角`}>归属</SortTh>
                  <SortTh k="mood" sort={sort} title="薪资满意度：满意 / 略有不满 / 强烈不满（不满会加速归属感下降，并吸引其他俱乐部挖角）">薪资</SortTh>
                  <SortTh k="rating" sort={sort} className="num" title="本位置评分">评分</SortTh>
                  <SortTh k="salary" sort={sort} className="num">工资/回合</SortTh>
                  <SortTh k="contract" sort={sort} className="num" defaultDir="asc">合同</SortTh>
                  <SortTh k="value" sort={sort} className="num">身价</SortTh>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const slot = slotOf.get(p.id);
                  const tier = safe(() => playerTier(p), 'C' as const);
                  const mmr = safe(() => effectiveAttr(p, 'mmr'), p.mmr);
                  const loyalty = loyaltyOf(p);
                  const inactive = p.status !== 'active';
                  return (
                    <tr
                      key={p.id}
                      className={cx('cursor-pointer', inactive && 'opacity-50')}
                      onClick={() => openPlayer(p.id)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        {canRelease(p) && (
                          <input
                            type="checkbox"
                            className="cursor-pointer accent-[var(--color-dota)]"
                            checked={selected.has(p.id)}
                            onChange={() => toggle(p.id)}
                            title="选中后可批量挂牌 / 解约"
                          />
                        )}
                      </td>
                      <td>
                        {slot ? (
                          <span className={cx('text-xs font-semibold', ROLE_FIT_TEXT[roleFit(p, slot)])} title={`${POSITION_LABEL[slot]}首发 · ${roleFitTitle(p, slot)}`}>
                            首发·{POSITION_SHORT[slot]}
                          </span>
                        ) : (
                          <span className="text-xs text-faint">{inactive ? '—' : '替补'}</span>
                        )}
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-1.5">
                          <Flag cc={p.nationality} />
                          <PlayerLink player={p} />
                          {p.name && <span className="hidden text-[11px] text-faint 2xl:inline">{p.name}</span>}
                        </span>
                      </td>
                      <td>
                        <PosBadge pos={p.position} alt={p.altPositions} />
                      </td>
                      <td className="num">{ageOf(game, p)}</td>
                      <td>
                        <span className="inline-flex items-center gap-1.5">
                          <TierBadge tier={tier} />
                          <span className="tabular text-xs text-mute">{Math.round(mmr)}</span>
                        </span>
                      </td>
                      <td className="num">
                        <PowerValue player={p} />
                      </td>
                      <td className="num">{fmt1(p.talent)}</td>
                      <td className="num">{fmt1(p.resilience)}</td>
                      <td className="num">{fmt1(p.insight)}</td>
                      <td
                        className={cx('num', loyaltyClass(loyalty))}
                        title={Math.abs(loyalty - p.loyalty) >= 0.05 ? `基础 ${fmt1(p.loyalty)}（受临时状态影响）` : undefined}
                      >
                        {fmt1(loyalty)}
                      </td>
                      <td className="text-center">
                        {(() => {
                          const m = salaryMoodOf(game, p);
                          return m ? <SalaryMoodIcon mood={m} /> : <span className="text-xs text-faint">—</span>;
                        })()}
                      </td>
                      <td className="num font-semibold text-gold">{fmt1(safe(() => overallRating(p), 0))}</td>
                      <td className="num">
                        <Gold value={p.salary || 0} />
                      </td>
                      {p.tempSubUntilTournament ? (
                        <td className="num text-info" title={`仅效力：${game.tournaments[p.tempSubUntilTournament]?.name ?? '指定赛事'}`}>
                          临时
                        </td>
                      ) : (
                        <td className={cx('num', p.contractUntil <= game.season.ti && 'text-gold')}>TI{p.contractUntil}</td>
                      )}
                      <td className="num">
                        <Gold value={safe(() => marketValue(game, p), 0)} />
                      </td>
                      <td>
                        <StatusChips game={game} player={p} slot={slot ?? null} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** 就近确认气泡里的选手清单（批量挂牌 / 解约）：位置 · ID · 等级 + 右侧金额，人多时滚动 */
function PlayerConfirmList({ players, right }: { players: Player[]; right: (p: Player) => ReactNode }) {
  return (
    <span className="block max-h-40 space-y-0.5 overflow-y-auto pr-1">
      {players.map((p) => (
        <span key={p.id} className="flex items-center justify-between gap-2 rounded bg-panel-3/60 px-1.5 py-0.5">
          <span className="flex min-w-0 items-center gap-1 text-ink">
            <PosBadge pos={p.position} alt={p.altPositions} />
            <span className="truncate">{p.handle}</span>
            <TierBadge tier={safe(() => playerTier(p), 'C' as const)} />
          </span>
          <span className="shrink-0 text-[11px]">{right(p)}</span>
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 首发位置卡片
// ---------------------------------------------------------------------------
function SlotCard({
  game,
  pos,
  player,
  options,
  slotOf,
  ctxT,
  onAssign,
}: {
  game: GameState;
  pos: Position;
  player: Player | null;
  options: Player[];
  slotOf: Map<string, Position>;
  ctxT: Tournament | null;
  onAssign: (id: string) => void;
}) {
  const sorted = options
    .slice()
    .sort((a, b) => safe(() => playerRating(b, pos), 0) - safe(() => playerRating(a, pos), 0));
  const rating = player ? safe(() => playerRating(player, pos), 0) : 0;
  const fit: RoleFit = player ? safe(() => roleFit(player, pos), 'off' as RoleFit) : 'main';
  const blocked = player && ctxT ? (player.unavailableTournamentIds ?? []).includes(ctxT.id) : false;
  const otherTemp = !!player?.tempSubUntilTournament && !!ctxT && player.tempSubUntilTournament !== ctxT.id;
  const mods = player?.modifiers ?? [];

  return (
    <div
      className={cx(
        'flex flex-col gap-2 rounded-lg border p-3 transition-colors',
        player ? 'border-line bg-panel-2/60' : 'border-dashed border-bad/50 bg-bad/5',
        (blocked || otherTemp) && 'border-bad/60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <PosBadge pos={pos} full />
        {player && (
          <span className="text-right leading-none">
            <span className="block text-[10px] text-faint">位置评分</span>
            <span className={cx('text-base font-bold tabular', ROLE_FIT_TEXT[fit])} title={roleFitTitle(player, pos)}>{rating.toFixed(1)}</span>
          </span>
        )}
      </div>

      {player ? (
        <>
          <div className="flex min-w-0 items-center gap-1.5">
            <Flag cc={player.nationality} />
            <PlayerLink player={player} className="truncate text-base" />
            <TierBadge tier={safe(() => playerTier(player), 'C' as const)} />
          </div>
          <div className="grid grid-cols-3 gap-1 text-[11px]">
            <MiniStat label="战力" value={<PowerValue player={player} />} />
            <MiniStat label="天梯" value={Math.round(safe(() => effectiveAttr(player, 'mmr'), player.mmr))} />
            <MiniStat label="年龄" value={ageOf(game, player)} />
          </div>
          <div className="flex min-h-5 flex-wrap gap-1">
            <RoleFitChip player={player} slot={pos} />
            {blocked && ctxT && <Chip tone="bad" title={`无法参加「${ctxT.name}」（签证/伤病）`}>无法参赛</Chip>}
            {player.tempSubUntilTournament && (
              <Chip tone={otherTemp ? 'bad' : 'info'} title={`仅效力：${game.tournaments[player.tempSubUntilTournament]?.name ?? '指定赛事'}`}>
                临时替补
              </Chip>
            )}
            {mods.slice(0, 2).map((m) => (
              <Chip key={m.id} tone={modifierPositive(m) ? 'good' : 'bad'} title={`${MOD_ATTR_LABEL[m.attr]} ${modifierText(m)} · ${modifierDuration(m)}`}>
                {m.source}
              </Chip>
            ))}
            {mods.length > 2 && <Chip>+{mods.length - 2}</Chip>}
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center py-3 text-center">
          <div className="text-sm font-semibold text-bad">空缺</div>
          <div className="mt-0.5 text-[11px] text-mute">参赛时需补齐首发</div>
        </div>
      )}

      <select
        value={player?.id ?? ''}
        onChange={(e) => onAssign(e.target.value)}
        className="mt-auto w-full cursor-pointer rounded-md border border-line bg-panel px-2 py-1 text-xs text-ink [color-scheme:dark] focus:border-dota focus:outline-none"
        title="选择该位置首发"
      >
        <option value="">— 空缺 —</option>
        {sorted.map((p) => {
          const other = slotOf.get(p.id);
          const r = safe(() => playerRating(p, pos), 0);
          const optFit = safe(() => roleFit(p, pos), 'off' as RoleFit);
          const tags: string[] = [];
          if (other && other !== pos) {
            // setLineupSlot：原位置由本位置当前首发顶上；本位置为空时原位置变为空缺
            tags.push(player ? `现${POSITION_SHORT[other]}号位首发，将互换` : `现${POSITION_SHORT[other]}号位首发，移来后该位空缺`);
          }
          else if (!other) tags.push('替补');
          // 位置适配：本位置 / 副位置 / 四五号位互换 / 非本位置（评分已含系数）
          if (optFit === 'off') tags.push(`非本位置·本位${POSITION_SHORT[p.position]}号`);
          else if (optFit !== 'main') tags.push(`${ROLE_FIT_LABEL[optFit]} ×${roleFitFactor(optFit)}`);
          if (ctxT && (p.unavailableTournamentIds ?? []).includes(ctxT.id)) tags.push('无法参赛');
          if (p.tempSubUntilTournament) tags.push('临时替补');
          return (
            <option key={p.id} value={p.id}>
              {p.handle} · {r.toFixed(1)}
              {tags.length ? `（${tags.join('，')}）` : ''}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded bg-panel-3/50 px-1.5 py-1">
      <div className="text-[10px] text-faint">{label}</div>
      <div className="tabular text-xs text-ink">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 状态标签
// ---------------------------------------------------------------------------
function StatusChips({ game, player: p, slot }: { game: GameState; player: Player; slot: Position | null }) {
  const chips: ReactNode[] = [];
  if (p.status === 'banned') chips.push(<Chip key="ban" tone="bad" title="永久禁赛，无法上场">禁赛</Chip>);
  if (p.status === 'retired') chips.push(<Chip key="ret">已退役</Chip>);
  if (p.status === 'active') {
    if (slot) {
      chips.push(
        <Chip key="st" tone="gold" title={`首发 ${POSITION_LABEL[slot]}（${ROLE_FIT_LABEL[roleFit(p, slot)]}）`}>
          首发
        </Chip>,
      );
    } else if (!p.tempSubUntilTournament) {
      const n = p.benchRounds ?? 0;
      chips.push(
        <Chip
          key="bench"
          tone={n > CONFIG.loyalty.benchGraceRounds ? 'bad' : 'mute'}
          title={n > 0 ? `已连续替补 ${n} 回合（超过 ${CONFIG.loyalty.benchGraceRounds} 回合后每回合归属感 ${CONFIG.loyalty.benchPerRound}）` : '替补'}
        >
          替补{n > 0 ? ` ${n}` : ''}
        </Chip>,
      );
    }
    if (p.tempSubUntilTournament) {
      const t = game.tournaments[p.tempSubUntilTournament];
      chips.push(
        <Chip key="tmp" tone="info" title={`仅效力：${t?.name ?? '指定赛事'}，赛事结束后自动离队`}>
          临时替补
        </Chip>,
      );
    }
    const blocked = blockedTournaments(game, p);
    if (blocked.length) {
      chips.push(
        <Chip key="visa" tone="bad" title={`无法参加：${blocked.map((t) => t.name).join('、')}（签证/伤病）`}>
          签证受限
        </Chip>,
      );
    }
    if (!p.tempSubUntilTournament && p.contractUntil <= game.season.ti) {
      chips.push(
        <Chip key="ct" tone="gold" title={`合同将于 TI${p.contractUntil} 结束后到期`}>
          合同到期
        </Chip>,
      );
    }
    if (loyaltyOf(p) < CONFIG.loyalty.leaveThreshold) {
      chips.push(
        <Chip key="loy" tone="bad" title="归属感过低：可能主动申请离队或被 AI 战队挖角">
          想走
        </Chip>,
      );
    }
    const listing = safe(() => activeListing(game, p), null);
    if (listing) {
      const left = safe(() => listingProgress(listing).roundsLeft, listing.roundsLeft);
      chips.push(
        <Chip
          key="list"
          tone="gold"
          title={
            left > 0
              ? `标价 ${formatGold(listing.askingPrice)}；挂牌期剩余 ${left} 个转会回合（TI 锁定期间暂停），` +
                (listing.hadBids
                  ? '已收到过报价：挂牌期满后挂牌结束、选手留队'
                  : '整个挂牌期没有收到任何报价将自动解约（无补偿）')
              : `标价 ${formatGold(listing.askingPrice)}；挂牌期已满，待处理报价处理完后挂牌结束、选手留队（收到过报价不会自动解约）`
          }
        >
          {left > 0 ? `挂牌中·剩${left}回合` : '挂牌中·已到期'}
        </Chip>,
      );
    }
    if (p.isRookie) chips.push(<Chip key="rk" tone="info">新秀</Chip>);
    const mods = p.modifiers ?? [];
    if (mods.length) {
      const good = mods.filter(modifierPositive).length;
      const bad = mods.length - good;
      const tip = mods.map((m) => `${m.source}：${MOD_ATTR_LABEL[m.attr]} ${modifierText(m)}（${modifierDuration(m)}）`).join('\n');
      if (good) chips.push(<Chip key="mg" tone="good" title={tip}>▲{good}</Chip>);
      if (bad) chips.push(<Chip key="mb" tone="bad" title={tip}>▼{bad}</Chip>);
    }
  }
  return <span className="inline-flex flex-wrap gap-1">{chips}</span>;
}

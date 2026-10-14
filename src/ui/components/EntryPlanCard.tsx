// ============================================================================
// 总览「赛事报名」卡片（第十四波）：本赛季尚未开赛的常规赛事——受邀 / 已报名 / 可报名 / 未解锁（附原因）与操作按钮，
// 赛季中可随时报名、重新接受或退出（退出代价见 TourEntry / schedule.withdrawPenaltyOf）。
// 本回合收到补充邀请时自动展开并高亮；按钮与赛程页共用 entryControls（经 call 调用引擎）。
// ============================================================================
import { useState } from 'react';
import type { GameState, Tournament } from '../../engine/types';
import { CONFIG } from '../../engine';
import { useCall, useGame, useGameStore } from '../../store/gameStore';
import { cx } from './common';
import NewBadge, { useNewFeature } from './NewBadge';
import { entryControls, entryStatusOf } from './TourEntry';
import { Segmented, TourTierBadge, openTournamentView, safe } from './TourShared';
import { seatSpectating } from './TourModalLogic';

type Scope = 'mine' | 'all';

const TIER_ORDER: Record<string, number> = { ti: 0, major: 1, premier: 2, minor: 3, qualifier: 4 };

/** 本赛季尚未开赛、仍可修改报名的常规赛事（不含 TI 与 TI 赛区预选），按回合 / 等级排序 */
export function upcomingRegularTournaments(game: GameState): Tournament[] {
  const ti = game.season?.ti;
  const ids = new Set<string>(game.seasonTournamentIds ?? []);
  for (const r of game.season?.rounds ?? []) for (const id of r.tournamentIds ?? []) ids.add(id);
  const out: Tournament[] = [];
  for (const id of ids) {
    const t = game.tournaments[id];
    if (!t || t.season !== ti || t.status !== 'scheduled' || t.roundIndex <= game.roundIndex) continue;
    if (t.tier === 'ti' || t.advanceToTi || t.id.startsWith('tiq-')) continue;
    out.push(t);
  }
  return out.sort((a, b) => a.roundIndex - b.roundIndex || (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9)
    || (a.startDate || '').localeCompare(b.startDate || '') || a.name.localeCompare(b.name));
}

/** 「我的」：受邀 / 已报名 / 补充邀请 / 在受邀名单中已婉拒（可重新接受） */
function isMineEntry(game: GameState, t: Tournament): boolean {
  const me = game.settings.playerTeamId;
  const st = entryStatusOf(game, t);
  return st === 'invited' || st === 'registered' || t.lateInvites?.[me] !== undefined
    || (st === 'declined' && (t.invitedTeamIds ?? []).includes(me));
}

export function EntryPlanCard({ className }: { className?: string }) {
  const game = useGame();
  const call = useCall();
  const setView = useGameStore((s) => s.setView);
  const me = game.settings.playerTeamId;
  const roundKey = `${game.season?.ti ?? 0}-${game.roundIndex}`;
  const [toggle, setToggle] = useState<{ key: string; open: boolean } | null>(null);
  const [scope, setScope] = useState<Scope>('mine');
  // 新功能徽标（v0.3.0）：显示在卡片标题旁，展开 / 收起卡片后消失
  const entryNew = useNewFeature('seasonEntry');
  if (!game.teams[me] || game.gameOver || safe(() => seatSpectating(game), false)) return null;
  const tours = safe(() => upcomingRegularTournaments(game), [] as Tournament[]);
  if (tours.length === 0) return null;

  const statuses = tours.map((t) => safe(() => entryStatusOf(game, t), t.playerStatus));
  const count = (s: string) => statuses.filter((x) => x === s).length;
  // 「可报名」只计现在真能报名 / 重新接受的（同回合已有安排而按钮禁用的不算）
  const canEnter = tours.filter((t) => safe(() => entryControls(game, t, call, { size: 'xs' }).canEnter, false)).length;
  const newLate = tours.filter((t) => t.lateInvites?.[me] === game.roundIndex);
  const open = toggle?.key === roundKey ? toggle.open : newLate.length > 0;
  const rows = scope === 'mine' ? tours.filter((t) => isMineEntry(game, t)) : tours;
  const H = CONFIG.honor;
  const ruleText = `赛季中可随时报名、重新接受或退出尚未开赛的赛事。退出（婉拒 / 取消报名）在报名或接受邀请的同一回合内不扣荣誉，`
    + `之后按等级扣荣誉（Major ${-H.withdraw.major} / 顶级赛事 ${-H.withdraw.premier} / Minor ${-H.withdraw.minor} / 线上公开赛 ${-H.withdrawOpenCup}，`
    + `距开赛 ≥ ${H.withdrawFarRounds} 个回合减半，低荣誉减损）；TI 与 TI 预选赛必须参加。`
    + `每回合结束时，本赛季积分榜靠前或荣誉达到受邀线的战队会收到尚未开赛赛事的补充邀请（默认接受，收到的回合内婉拒不扣荣誉）。`;

  return (
    <section className={cx('overflow-hidden rounded-xl border bg-panel/90', newLate.length ? 'border-gold/50' : 'border-line', className)}>
      <button
        onClick={() => {
          setToggle({ key: roundKey, open: !open });
          entryNew.dismiss();
        }}
        className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-panel-2/50"
        title={ruleText}
      >
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
          赛事报名 <NewBadge feature="seasonEntry" dismissOn="none" />
        </span>
        <span className="text-xs text-mute">
          未开赛 {tours.length} 项 · <span className="text-good">参赛 {count('invited') + count('registered')}</span>
          <span className="text-faint">（受邀 {count('invited')} · 自行报名 {count('registered')}）</span>
          {' · '}
          <span className="text-info">可报名 {canEnter}</span>
        </span>
        {newLate.length > 0 && (
          <span className="rounded border border-gold/50 bg-gold/15 px-2 py-0.5 text-xs font-semibold text-gold">
            本回合收到 {newLate.length} 项补充邀请 · 本回合内婉拒不扣荣誉
          </span>
        )}
        <span className="ml-auto text-xs text-faint">{open ? '收起 ▴' : '展开 ▾'}</span>
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-faint">{ruleText}</p>
            <div className="flex shrink-0 items-center gap-2">
              <Segmented<Scope>
                value={scope}
                onChange={setScope}
                options={[
                  { key: 'mine', label: '我的安排' },
                  { key: 'all', label: '全部未开赛' },
                ]}
              />
              <button className="cursor-pointer text-[11px] text-gold hover:underline" onClick={() => setView('schedule')}>
                赛程报名 ›
              </button>
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="px-1 py-2 text-xs text-faint">没有已受邀或已报名的未开赛赛事，切换到「全部未开赛」报名。</div>
          ) : (
            <div className="max-h-[360px] overflow-y-auto">
              {rows.map((t) => {
                const { chip, action } = entryControls(game, t, call, { size: 'xs' });
                const fresh = t.lateInvites?.[me] === game.roundIndex;
                return (
                  <div
                    key={t.id}
                    className={cx(
                      'flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line/50 px-1 py-1.5 text-xs last:border-b-0',
                      fresh && 'bg-gold/5',
                    )}
                  >
                    <span className="w-9 shrink-0 font-semibold tabular text-mute">R{t.roundIndex}</span>
                    <button
                      className="min-w-[140px] flex-1 cursor-pointer truncate text-left hover:text-gold hover:underline"
                      onClick={() => openTournamentView(game, t.id)}
                      title="在赛事中心查看"
                    >
                      {t.name}
                    </button>
                    <TourTierBadge tier={t.tier} className="shrink-0" />
                    <span className="shrink-0">{chip}</span>
                    <span className="flex shrink-0 justify-end">{action}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

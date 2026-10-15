// ============================================================================
// 比赛页 · BP 面板（队长模式）：双方禁选位、BP 顺序、推荐、英雄池
// 「采纳首推」「开始比赛」在底部吸附操作栏（MatchDock）；推荐由比赛页计算后传入。
// 手机 / 平板（< lg，docs/UI.md「手机适配」）：顶部为吸附的紧凑 BP 看板（双方 5 选 + 5 禁头像、当前步骤），推荐横向滑动、
// 英雄池紧随其后（不再嵌套滚动）；BP 顺序为横向条，完整的双方禁选位放在最后。≥ lg 布局不变。
// 触屏：点按推荐 / 英雄先选中（onSelect，比赛页本地状态），再点一次或点底栏按钮确认；鼠标仍为单击直接禁选。
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DraftAction, DraftState, DraftStep, GameState, HeroAttr, Position, Team } from '../../engine/types';
import { POSITIONS } from '../../engine/types';
import { DRAFT_SEQUENCE, POSITION_SHORT, lineupPlayers } from '../../engine';
import type { DraftSuggestion } from '../../engine';
import { Badge, Button, Card, EmptyState, Hint, PosBadge, StatBar, TeamTag, cx } from './common';
import { TeamEmblem } from './TeamEmblem';
import { ATTR_DOT, ATTR_LABEL, HeroAvatar, MetaTag, heroCn, heroInfo, heroTooltip } from './MatchHero';
import { FACTION_LABEL, FACTION_TEXT, FactionBadge, MineBadge, factionOf, safe, type Side } from './MatchShared';
import { useIsPhone, useMinWidth } from '../mobile';

interface SlotInfo {
  idx: number;
  step: DraftStep;
  action?: DraftAction;
  /** 本方同类型（禁/选）中的序号（0 起） */
  ord: number;
}

function buildSlots(draft: DraftState): SlotInfo[] {
  const seq = draft.sequence?.length ? draft.sequence : DRAFT_SEQUENCE;
  const counters: Record<string, number> = {};
  return seq.map((step, idx) => {
    const key = `${step.side}-${step.type}`;
    const ord = counters[key] ?? 0;
    counters[key] = ord + 1;
    return { idx, step, action: draft.actions[idx], ord };
  });
}

const TYPE_LABEL = { ban: '禁用', pick: '选择' } as const;

export default function MatchDraft({
  game,
  draft,
  teams,
  mySide,
  radiant,
  manual,
  suggestions,
  onAction,
  selected = null,
  onSelect,
}: {
  game: GameState;
  draft: DraftState;
  teams: { A: Team; B: Team };
  mySide: Side;
  /** 本局天辉方（BP 阶段为预测值） */
  radiant?: Side;
  manual: boolean;
  /** 当前我方回合的 BP 推荐（非我方回合为空） */
  suggestions: DraftSuggestion[];
  onAction: (heroId: string) => void;
  /** 触屏：当前选中（尚未确认）的英雄 */
  selected?: string | null;
  /** 触屏：传入时点按推荐 / 英雄只选中（再点一次确认），不直接禁选；null = 取消选中 */
  onSelect?: (heroId: string | null) => void;
}) {
  // < lg：紧凑看板 + 横向 BP 顺序（桌面三栏布局不变）
  const wide = useMinWidth(1024);
  /** 点按英雄：触屏先选中、再点一次确认；鼠标直接禁选 */
  const tapHero = (heroId: string) => {
    if (!onSelect) onAction(heroId);
    else if (selected === heroId) onAction(heroId);
    else onSelect(heroId);
  };
  const slots = buildSlots(draft);
  const cur = draft.done ? -1 : draft.actions.length;
  const curSlot = cur >= 0 ? slots[cur] : undefined;
  const myTurn = !!curSlot && curSlot.step.side === mySide && !draft.done;
  const total = slots.length;

  const sigOf = (teamId: string) => {
    const set = new Set<string>();
    for (const { player } of safe(() => lineupPlayers(game, teamId), [])) {
      for (const h of player?.signatureHeroes ?? []) set.add(h);
    }
    return set;
  };
  const myTeam = teams[mySide];
  const oppTeam = teams[mySide === 'A' ? 'B' : 'A'];
  const mySig = sigOf(myTeam.id);
  const oppSig = sigOf(oppTeam.id);

  const takenPos = new Set(draft.actions.filter((a) => a.side === mySide && a.type === 'pick').map((a) => a.position));
  const myOpen: Position[] = POSITIONS.filter((p) => !takenPos.has(p));

  const sideOf = (s: Side) => slots.filter((x) => x.step.side === s);

  // BP 顺序列表：自动滚动到当前步骤（只滚动列表自身，不影响页面）
  const orderRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const box = orderRef.current;
    if (!box || cur < 0) return;
    const el = box.querySelector<HTMLElement>('[data-cur="1"]');
    if (!el) return;
    box.scrollTo({ top: Math.max(0, el.offsetTop - box.clientHeight / 2), behavior: 'smooth' });
  }, [cur]);

  return (
    <div className="space-y-4">
      {/* ------------------------------ BP 面板 ------------------------------ */}
      {!wide && (
        <CompactBoard
          game={game}
          teams={teams}
          radiant={radiant}
          mySide={mySide}
          slots={slots}
          cur={cur}
          done={draft.done}
          manual={manual}
          myTurn={myTurn}
          myOpen={myOpen}
        />
      )}
      {wide && (
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_260px_minmax(0,1fr)]">
        <TeamDraftColumn game={game} team={teams.A} side="A" faction={factionOf(radiant, 'A')} mine={mySide === 'A'} slots={sideOf('A')} cur={cur} align="left" />

        <div className="order-first lg:col-span-2 xl:order-none xl:col-span-1">
          <Card bodyClassName="p-3" className="h-full">
            <div className="text-center">
              {draft.done ? (
                <>
                  <div className="text-[11px] uppercase tracking-[0.25em] text-faint">Draft Complete</div>
                  <div className="mt-1 text-lg font-bold text-gold">BP 完成</div>
                  <Hint className="mt-1">{manual ? '双方阵容已锁定' : '自动 BP 已完成，可先查看双方阵容'}</Hint>
                  <div className="mt-3 rounded-md border border-gold/40 bg-gold/10 px-2 py-1.5 text-xs text-gold">↓ 点击底部「开始比赛」</div>
                </>
              ) : curSlot ? (
                <>
                  <div className="text-[11px] uppercase tracking-[0.25em] text-faint">
                    第 {cur + 1} / {total} 步
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-base font-bold">
                    <span className="text-mute">轮到</span>
                    {(() => {
                      const f = factionOf(radiant, curSlot.step.side);
                      return f ? <span className={FACTION_TEXT[f]}>{FACTION_LABEL[f]}</span> : null;
                    })()}
                    <TeamTag color={teams[curSlot.step.side].color} tag={teams[curSlot.step.side].tag} />
                    <span className={curSlot.step.type === 'ban' ? 'text-bad' : 'text-good'}>· {TYPE_LABEL[curSlot.step.type]}</span>
                  </div>
                  <div className="mt-1 text-xs text-mute">
                    {curSlot.step.side === 'A' ? '先手方' : '后手方'} ·{' '}
                    {myTurn ? <span className="font-semibold text-gold">我方回合，请在下方操作</span> : '对手思考中…'}
                  </div>
                  {myTurn && curSlot.step.type === 'pick' && (
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-1 text-[11px] text-mute">
                      待补位置
                      {myOpen.map((p) => (
                        <PosBadge key={p} pos={p} />
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-mute">BP 数据异常</div>
              )}
            </div>
            <div className="mt-3 border-t border-line pt-2">
              <div className="mb-1 flex items-center justify-between text-[11px] text-faint">
                <span>BP 顺序</span>
                <span className="tabular">
                  {draft.actions.length}/{total}
                </span>
              </div>
              <ol
                ref={orderRef}
                className="relative grid max-h-[360px] gap-0.5 overflow-y-auto pr-1 lg:grid-flow-col lg:grid-rows-10 lg:gap-x-4 xl:grid-flow-row xl:grid-rows-none"
              >
                {slots.map((s) => {
                  const t = teams[s.step.side];
                  const isCur = s.idx === cur;
                  return (
                    <li
                      key={s.idx}
                      data-cur={isCur ? '1' : undefined}
                      className={cx(
                        'flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px]',
                        isCur && 'bg-gold/10 ring-1 ring-gold/60',
                        !s.action && !isCur && 'opacity-50',
                      )}
                    >
                      <span className="w-4 text-right tabular text-faint">{s.idx + 1}</span>
                      <TeamEmblem tag={t.tag} color={t.color} teamId={t.id} />
                      <span className="w-10 truncate font-semibold">{t.tag}</span>
                      <span className={cx('w-6', s.step.type === 'ban' ? 'text-bad' : 'text-good')}>{s.step.type === 'ban' ? '禁' : '选'}</span>
                      {s.action ? (
                        <span className="flex min-w-0 items-center gap-1">
                          <HeroAvatar heroId={s.action.heroId} size="xs" banned={s.step.type === 'ban'} />
                          <span className={cx('truncate', s.step.type === 'ban' && 'text-mute line-through')}>{heroCn(s.action.heroId)}</span>
                        </span>
                      ) : isCur ? (
                        <span className="animate-pulse text-gold">进行中…</span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          </Card>
        </div>

        <TeamDraftColumn game={game} team={teams.B} side="B" faction={factionOf(radiant, 'B')} mine={mySide === 'B'} slots={sideOf('B')} cur={cur} align="right" />
      </div>
      )}

      {/* ------------------------------ 操作区 ------------------------------ */}
      {!draft.done && myTurn && curSlot && (
        <>
          <Card
            title={
              <span>
                BP 推荐 · <span className={curSlot.step.type === 'ban' ? 'text-bad' : 'text-good'}>{TYPE_LABEL[curSlot.step.type]}</span>
              </span>
            }
            subtitle={onSelect ? '点按选中，再点一次或点底部按钮确认 · 推荐质量受战队灵性与教练影响' : '推荐质量受战队灵性与教练影响，仅供参考'}
            bodyClassName="p-4 max-sm:px-0 max-sm:py-3"
          >
            {suggestions.length === 0 ? (
              <Hint className="max-sm:px-4">暂无推荐，可直接在下方英雄池中搜索英雄。</Hint>
            ) : (
              // 手机：推荐横向滑动（一屏约 1.3 张），英雄池紧随其后
              <div className="grid grid-cols-[minmax(0,1fr)] gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 max-sm:no-scrollbar max-sm:flex max-sm:snap-x max-sm:snap-mandatory max-sm:overflow-x-auto max-sm:scroll-px-4 max-sm:px-4 max-sm:py-1">
                {suggestions.map((s, i) => (
                  <SuggestionCard
                    key={s.heroId}
                    s={s}
                    rank={i}
                    game={game}
                    type={curSlot.step.type}
                    selected={selected === s.heroId}
                    onClick={() => tapHero(s.heroId)}
                  />
                ))}
              </div>
            )}
          </Card>
          <HeroPool
            game={game}
            available={draft.available}
            type={curSlot.step.type}
            mySig={mySig}
            oppSig={oppSig}
            onPick={tapHero}
            selected={selected}
            touch={!!onSelect}
          />
        </>
      )}

      {!draft.done && !myTurn && (
        <Card>
          <EmptyState text="对手正在 BP，请稍候…">
            <Hint>若长时间无响应，可返回赛事中心后重新进入比赛。</Hint>
          </EmptyState>
        </Card>
      )}

      {/* < lg：BP 顺序（横向）与完整的双方禁选位放在最后 */}
      {!wide && (
        <>
          <OrderStrip slots={slots} cur={cur} teams={teams} />
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            <TeamDraftColumn game={game} team={teams.A} side="A" faction={factionOf(radiant, 'A')} mine={mySide === 'A'} slots={sideOf('A')} cur={cur} align="left" />
            <TeamDraftColumn game={game} team={teams.B} side="B" faction={factionOf(radiant, 'B')} mine={mySide === 'B'} slots={sideOf('B')} cur={cur} align="right" />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// < lg：吸附在顶部的紧凑 BP 看板（当前步骤 + 双方 5 选 / 5 禁头像，点按头像显示英雄与选手）
// ---------------------------------------------------------------------------
function CompactBoard({
  game,
  teams,
  radiant,
  mySide,
  slots,
  cur,
  done,
  manual,
  myTurn,
  myOpen,
}: {
  game: GameState;
  teams: { A: Team; B: Team };
  radiant?: Side;
  mySide: Side;
  slots: SlotInfo[];
  cur: number;
  done: boolean;
  manual: boolean;
  myTurn: boolean;
  myOpen: Position[];
}) {
  const curSlot = cur >= 0 ? slots[cur] : undefined;
  const curFaction = curSlot ? factionOf(radiant, curSlot.step.side) : null;
  return (
    // 通栏出血（与 main 的内边距一致），滚动时吸附在主区顶部（sticky 以 main 的内容区为准，负 top 抵消 main 的上内边距）；
    // 横屏矮视口不吸附（高度留给英雄池）
    <section className="sticky -top-4 z-10 -mx-3 border-y border-line bg-panel/95 px-3 py-2 shadow-lg shadow-black/30 backdrop-blur sm:-top-5 sm:-mx-6 sm:px-6 short:static">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        {done ? (
          <>
            <span className="font-bold text-gold">BP 完成</span>
            <span className="min-w-0 truncate text-mute">{manual ? '双方阵容已锁定' : '自动 BP 已完成'} · 点击底部「开始比赛」</span>
          </>
        ) : curSlot ? (
          <>
            <span className="shrink-0 tabular text-faint">
              {cur + 1}/{slots.length}
            </span>
            {curFaction && <span className={cx('shrink-0 font-semibold', FACTION_TEXT[curFaction])}>{FACTION_LABEL[curFaction]}</span>}
            <span className="min-w-0 truncate font-semibold">{teams[curSlot.step.side].tag}</span>
            <span className={cx('shrink-0 font-bold', curSlot.step.type === 'ban' ? 'text-bad' : 'text-good')}>{TYPE_LABEL[curSlot.step.type]}</span>
            <span className={cx('ml-auto shrink-0', myTurn ? 'font-semibold text-gold' : 'animate-pulse text-mute')}>
              {myTurn ? '我方回合' : '对手思考中…'}
            </span>
          </>
        ) : (
          <span className="text-mute">BP 数据异常</span>
        )}
      </div>
      {myTurn && curSlot?.step.type === 'pick' && myOpen.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-mute">
          待补位置
          {myOpen.map((p) => (
            <PosBadge key={p} pos={p} />
          ))}
        </div>
      )}
      <div className="mt-1.5 grid grid-cols-2 gap-3">
        {(['A', 'B'] as Side[]).map((side) => (
          <BoardSide
            key={side}
            game={game}
            team={teams[side]}
            faction={factionOf(radiant, side)}
            mine={side === mySide}
            slots={slots.filter((x) => x.step.side === side)}
            cur={cur}
            right={side === 'B'}
          />
        ))}
      </div>
    </section>
  );
}

function BoardSide({
  game,
  team,
  faction,
  mine,
  slots,
  cur,
  right,
}: {
  game: GameState;
  team: Team;
  faction: ReturnType<typeof factionOf>;
  mine: boolean;
  slots: SlotInfo[];
  cur: number;
  right: boolean;
}) {
  const picks = slots.filter((s) => s.step.type === 'pick').sort((a, b) => a.ord - b.ord);
  const bans = slots.filter((s) => s.step.type === 'ban').sort((a, b) => a.ord - b.ord);
  const row = cx('flex items-center gap-1', right && 'flex-row-reverse');
  return (
    <div className="min-w-0">
      <div className={cx(row, 'mb-1 text-[11px]')}>
        <span className="inline-block h-3 w-1 shrink-0 rounded-full" style={{ background: team.color }} />
        <span className="min-w-0 truncate font-semibold">{team.tag}</span>
        <FactionBadge faction={faction} />
        {mine && <MineBadge />}
      </div>
      <div className={row}>
        {picks.map((s) => {
          const a = s.action;
          const isCur = s.idx === cur;
          if (a) {
            const p = a.playerId ? game.players[a.playerId] : undefined;
            const who = [a.position ? `${POSITION_SHORT[a.position]}号位` : '', p?.handle ?? ''].filter(Boolean).join(' ');
            return <HeroAvatar key={s.idx} heroId={a.heroId} size="sm" tip title={`${heroTooltip(a.heroId)}${who ? ` · ${who}` : ''}`} />;
          }
          return (
            <span
              key={s.idx}
              className={cx(
                'grid h-7 w-7 shrink-0 place-items-center rounded-md border border-dashed text-[10px]',
                isCur ? 'animate-pulse border-gold bg-gold/10 text-gold' : 'border-line/70 text-faint',
              )}
            >
              {isCur ? '选' : s.ord + 1}
            </span>
          );
        })}
      </div>
      <div className={cx(row, 'mt-1')}>
        {bans.map((s) =>
          s.action ? (
            <HeroAvatar key={s.idx} heroId={s.action.heroId} size="xs" banned tip />
          ) : (
            <span
              key={s.idx}
              className={cx(
                'grid h-5 w-5 shrink-0 place-items-center rounded border border-dashed text-[9px]',
                s.idx === cur ? 'animate-pulse border-bad bg-bad/10 text-bad' : 'border-line/70 text-faint',
              )}
            >
              {s.idx === cur ? '禁' : ''}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/** < lg：BP 顺序横向条，自动滑到当前步骤 */
function OrderStrip({ slots, cur, teams }: { slots: SlotInfo[]; cur: number; teams: { A: Team; B: Team } }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box || cur < 0) return;
    const el = box.querySelector<HTMLElement>('[data-cur="1"]');
    if (!el) return;
    box.scrollTo({ left: Math.max(0, el.offsetLeft - box.clientWidth / 2 + el.offsetWidth / 2), behavior: 'smooth' });
  }, [cur]);
  const done = slots.filter((s) => s.action).length;
  return (
    <section className="rounded-xl border border-line bg-panel/90 p-3 shadow-lg shadow-black/20">
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-faint">
        <span>BP 顺序</span>
        <span className="tabular">
          {done}/{slots.length}
        </span>
      </div>
      <ol ref={ref} className="no-scrollbar flex gap-1.5 overflow-x-auto overscroll-x-contain">
        {slots.map((s) => {
          const t = teams[s.step.side];
          const isCur = s.idx === cur;
          const ban = s.step.type === 'ban';
          return (
            <li
              key={s.idx}
              data-cur={isCur ? '1' : undefined}
              className={cx(
                'flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-md border px-1 py-1 text-[10px]',
                isCur ? 'border-gold/70 bg-gold/10' : 'border-line',
                !s.action && !isCur && 'opacity-50',
              )}
            >
              <span className="flex items-center gap-1">
                <span className="tabular text-faint">{s.idx + 1}</span>
                <span className={ban ? 'text-bad' : 'text-good'}>{ban ? '禁' : '选'}</span>
              </span>
              <span className="w-full truncate text-center font-semibold">{t.tag}</span>
              {s.action ? (
                <HeroAvatar heroId={s.action.heroId} size="sm" banned={ban} tip />
              ) : (
                <span className={cx('grid h-7 w-7 place-items-center rounded-md border border-dashed', isCur ? 'animate-pulse border-gold text-gold' : 'border-line/70 text-faint')}>
                  {isCur ? '…' : '—'}
                </span>
              )}
              <span className={cx('w-full truncate text-center', ban ? 'text-mute line-through' : 'text-ink/90')}>
                {s.action ? heroCn(s.action.heroId) : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 一方的禁/选位
// ---------------------------------------------------------------------------
function TeamDraftColumn({
  game,
  team,
  side,
  faction,
  mine,
  slots,
  cur,
  align,
}: {
  game: GameState;
  team: Team;
  side: Side;
  faction: ReturnType<typeof factionOf>;
  mine: boolean;
  slots: SlotInfo[];
  cur: number;
  align: 'left' | 'right';
}) {
  const picks = slots.filter((s) => s.step.type === 'pick').sort((a, b) => a.ord - b.ord);
  const bans = slots.filter((s) => s.step.type === 'ban').sort((a, b) => a.ord - b.ord);
  const right = align === 'right';
  return (
    <section
      className={cx(
        'rounded-xl border bg-panel/90 p-3 shadow-lg shadow-black/20',
        mine ? 'border-gold/40' : 'border-line',
      )}
      style={{ backgroundImage: `linear-gradient(${right ? '270deg' : '90deg'}, ${team.color}22, transparent 45%)` }}
    >
      <header className={cx('mb-3 flex items-center gap-2', right && 'flex-row-reverse')}>
        <span className="inline-block h-6 w-1.5 rounded-full" style={{ background: team.color }} />
        <div className={cx('min-w-0', right && 'text-right')}>
          <div className={cx('flex items-center gap-1.5', right && 'flex-row-reverse')}>
            <span className="truncate text-base font-bold">{team.name}</span>
            <FactionBadge faction={faction} />
            {mine && <MineBadge />}
          </div>
          <div className="text-[11px] text-faint">{side === 'A' ? '先手方' : '后手方'} · {team.tag}</div>
        </div>
      </header>

      <div className="space-y-1.5">
        {picks.map((s) => (
          <PickSlot key={s.idx} game={game} slot={s} isCur={s.idx === cur} right={right} />
        ))}
      </div>

      <div className={cx('mt-3 flex items-center gap-1.5', right && 'flex-row-reverse')}>
        <span className="text-[10px] uppercase tracking-widest text-faint">禁用</span>
        {bans.map((s) => {
          const isCur = s.idx === cur;
          return s.action ? (
            <HeroAvatar key={s.idx} heroId={s.action.heroId} size="md" banned className="fade-up" />
          ) : (
            <span
              key={s.idx}
              className={cx(
                'grid h-9 w-9 place-items-center rounded-md border border-dashed text-[10px] text-faint',
                isCur ? 'glow animate-pulse border-bad bg-bad/10 text-bad' : 'border-line/70',
              )}
            >
              {isCur ? '禁' : s.ord + 1}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function PickSlot({ game, slot, isCur, right }: { game: GameState; slot: SlotInfo; isCur: boolean; right: boolean }) {
  const a = slot.action;
  const h = a ? heroInfo(a.heroId) : undefined;
  const player = a?.playerId ? game.players[a.playerId] : undefined;
  return (
    <div
      className={cx(
        'flex items-center gap-2.5 rounded-lg border px-2 py-1.5 transition-colors',
        right && 'flex-row-reverse text-right',
        a ? 'fade-up border-line bg-panel-2/70' : 'border-dashed border-line/70 bg-panel/30',
        isCur && 'glow border-gold bg-gold/5',
      )}
    >
      {a ? (
        <HeroAvatar heroId={a.heroId} size="lg" />
      ) : (
        <span className={cx('grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-dashed text-xs', isCur ? 'animate-pulse border-gold text-gold' : 'border-line text-faint')}>
          {isCur ? '选择中' : `选${slot.ord + 1}`}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {a ? (
          <>
            <div className="truncate text-sm font-semibold">{h?.cn ?? heroCn(a.heroId)}</div>
            <div className="truncate text-[11px] text-faint">{h?.name ?? a.heroId}</div>
          </>
        ) : (
          <div className="text-xs text-faint">{isCur ? '等待选择…' : '未选择'}</div>
        )}
      </div>
      {a && (
        <div className={cx('flex shrink-0 flex-col gap-0.5', right ? 'items-start' : 'items-end')}>
          {a.position && <PosBadge pos={a.position} />}
          <span className="max-w-24 truncate text-[11px] text-mute">{player?.handle ?? '—'}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 推荐卡片
// ---------------------------------------------------------------------------
function SuggestionCard({
  s,
  rank,
  game,
  type,
  selected,
  onClick,
}: {
  s: DraftSuggestion;
  rank: number;
  game: GameState;
  type: 'ban' | 'pick';
  /** 触屏：已选中、等待确认 */
  selected?: boolean;
  onClick: () => void;
}) {
  const h = heroInfo(s.heroId);
  const player = s.playerId ? game.players[s.playerId] : undefined;
  const score = Math.max(0, Math.min(100, Math.round(s.score)));
  return (
    <button
      onClick={onClick}
      aria-pressed={selected || undefined}
      title={`${type === 'ban' ? '禁用' : '选择'} ${h?.cn ?? s.heroId}`}
      className={cx(
        'group fade-up flex cursor-pointer items-start gap-2.5 rounded-lg border bg-panel-2/60 p-2.5 text-left transition-colors hover:bg-panel-3',
        // 手机：横向滑动的卡片（约一屏 1.3 张）
        'max-sm:w-[76%] max-sm:shrink-0 max-sm:snap-start',
        selected ? 'border-gold bg-panel-3 ring-2 ring-gold' : rank === 0 ? 'border-gold/50' : 'border-line hover:border-gold/50',
      )}
    >
      <div className="relative">
        <HeroAvatar heroId={s.heroId} size="lg" />
        {rank === 0 && <span className="absolute -left-1 -top-1 rounded bg-gold px-1 text-[9px] font-black leading-4 text-black">首推</span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1">
          <span className="truncate text-sm font-semibold group-hover:text-gold">{h?.cn ?? heroCn(s.heroId)}</span>
          <MetaTag meta={game.heroMeta?.[s.heroId]} />
        </div>
        {(s.position || player) && (
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-mute">
            {s.position && <PosBadge pos={s.position} />}
            {player && <span className="truncate">{player.handle}</span>}
          </div>
        )}
        <div className="mt-1 flex items-center gap-1.5">
          <StatBar value={score} className="flex-1" />
          <span className="w-7 text-right text-[11px] tabular text-mute">{score}</span>
        </div>
        <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-mute">{s.reason || '—'}</div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 英雄池
// ---------------------------------------------------------------------------
type AttrFilter = 'all' | HeroAttr;
type PosFilter = 'all' | Position;
type SortKey = 'meta' | 'name';

function HeroPool({
  game,
  available,
  type,
  mySig,
  oppSig,
  onPick,
  selected = null,
  touch = false,
}: {
  game: GameState;
  available: string[];
  type: 'ban' | 'pick';
  mySig: Set<string>;
  oppSig: Set<string>;
  /** 点按英雄（触屏时由比赛页决定选中还是确认） */
  onPick: (heroId: string) => void;
  /** 触屏：已选中、等待确认的英雄 */
  selected?: string | null;
  /** 触屏的「先选中再确认」模式 */
  touch?: boolean;
}) {
  const phone = useIsPhone();
  const [query, setQuery] = useState('');
  const [attr, setAttr] = useState<AttrFilter>('all');
  const [pos, setPos] = useState<PosFilter>('all');
  const [sort, setSort] = useState<SortKey>('meta');

  const all = useMemo(
    () =>
      available.map((id) => {
        const h = heroInfo(id);
        return { id, h, cn: h?.cn ?? heroCn(id), en: h?.name ?? id, meta: game.heroMeta?.[id] ?? 0 };
      }),
    // available 由引擎原地修改（splice），因此以长度作为依赖
    [available, available.length, game.heroMeta],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length, str: 0, agi: 0, int: 0, uni: 0 };
    for (const x of all) if (x.h) c[x.h.attr] = (c[x.h.attr] ?? 0) + 1;
    return c;
  }, [all]);

  const list = useMemo(() => {
    const raw = query.trim();
    const q = raw.toLowerCase();
    const out = all.filter((x) => {
      if (attr !== 'all' && x.h?.attr !== attr) return false;
      if (pos !== 'all' && (x.h?.positions?.[pos] ?? 0) < 0.6) return false;
      if (q && !(x.cn.includes(raw) || x.en.toLowerCase().includes(q) || x.id.includes(q))) return false;
      return true;
    });
    out.sort((a, b) => (sort === 'meta' ? b.meta - a.meta || a.cn.localeCompare(b.cn, 'zh') : a.cn.localeCompare(b.cn, 'zh')));
    return out;
  }, [all, query, attr, pos, sort]);

  // 搜到的英雄被禁 / 选走后（BP 前进一步），搜索没有结果时自动清空：不必再点「清除筛选」（手机上还要滚回去、键盘重新弹出）
  const availLen = available.length;
  const seenLen = useRef(availLen);
  useEffect(() => {
    if (seenLen.current === availLen) return;
    seenLen.current = availLen;
    if (query.trim() && list.length === 0) setQuery('');
  }, [availLen, list.length, query]);

  const verb = type === 'ban' ? '禁用' : '选择';
  const ATTRS: AttrFilter[] = ['all', 'str', 'agi', 'int', 'uni'];

  return (
    <Card
      title={touch ? `英雄池 · 点按选中，再点${verb}` : `英雄池 · 点击${verb}`}
      subtitle={`可用 ${all.length} 名英雄 · 金点=我方招牌 · 红点=对手招牌`}
      actions={
        <div className="flex items-center gap-1 text-xs">
          <span className="text-faint">排序</span>
          {(['meta', 'name'] as SortKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              className={cx(
                'cursor-pointer whitespace-nowrap rounded px-2 py-0.5 pointer-coarse:min-h-9 pointer-coarse:px-2.5',
                sort === k ? 'bg-panel-3 text-ink' : 'text-mute hover:text-ink',
              )}
            >
              {k === 'meta' ? '版本强度' : '名称'}
            </button>
          ))}
        </div>
      }
    >
      {/* 手机：搜索框占满一行；属性 / 位置筛选各一行、不换字，放不下时横向滑动 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder="搜索英雄（中文/英文）"
            className="w-full rounded-md border border-line bg-panel-2 px-3 py-1.5 text-sm outline-none placeholder:text-faint focus:border-gold/60 pointer-coarse:py-2 pointer-coarse:pr-10 sm:w-56"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 grid -translate-y-1/2 cursor-pointer place-items-center text-xs text-faint hover:text-ink pointer-coarse:right-0 pointer-coarse:h-10 pointer-coarse:w-10"
              aria-label="清空"
            >
              ✕
            </button>
          )}
        </div>
        <div className="no-scrollbar flex max-w-full overflow-x-auto rounded-md border border-line">
          {ATTRS.map((k) => (
            <button
              key={k}
              onClick={() => setAttr(k)}
              className={cx(
                'flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap px-2.5 py-1 text-xs transition-colors pointer-coarse:min-h-9',
                attr === k ? 'bg-panel-3 text-ink' : 'text-mute hover:bg-panel-2 hover:text-ink',
              )}
            >
              {k !== 'all' && <span className={cx('inline-block h-2 w-2 rounded-full', ATTR_DOT[k])} />}
              {k === 'all' ? '全部' : ATTR_LABEL[k]}
              <span className="tabular text-faint">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="no-scrollbar flex max-w-full items-center gap-1 overflow-x-auto text-xs">
          <span className="shrink-0 text-faint">位置</span>
          {(['all', ...POSITIONS] as PosFilter[]).map((p) => (
            <button
              key={p}
              onClick={() => setPos(p)}
              className={cx(
                'shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 pointer-coarse:min-h-9 pointer-coarse:px-2.5',
                pos === p ? 'bg-panel-3 text-ink' : 'text-mute hover:text-ink',
              )}
            >
              {p === 'all' ? '全部' : `${POSITION_SHORT[p]}号位`}
            </button>
          ))}
        </div>
        <span className="ml-auto shrink-0 text-xs text-faint tabular">{list.length} 个结果</span>
      </div>

      {list.length === 0 ? (
        <EmptyState text="没有符合条件的英雄">
          <Button
            size="sm"
            onClick={() => {
              setQuery('');
              setAttr('all');
              setPos('all');
            }}
          >
            清除筛选
          </Button>
        </EmptyState>
      ) : (
        // 手机：格子收窄（一行 5 个）、不再嵌套滚动（页面整体滚动，顶部 BP 看板吸附）；横屏矮视口同样不嵌套滚动
        <div className="grid grid-cols-[repeat(auto-fill,minmax(54px,1fr))] gap-1.5 sm:max-h-[460px] sm:grid-cols-[repeat(auto-fill,minmax(78px,1fr))] sm:overflow-y-auto sm:pr-1 short:max-h-none short:overflow-visible">
          {list.map((x) => {
            const tip = `${verb} ${heroTooltip(x.id, x.meta)}`;
            const sel = touch && selected === x.id;
            return (
              <button
                key={x.id}
                onClick={() => onPick(x.id)}
                title={tip}
                aria-pressed={sel || undefined}
                className={cx(
                  'group relative flex cursor-pointer flex-col items-center gap-1 rounded-lg border bg-panel-2/50 px-1 pb-1 pt-1.5 transition-colors hover:border-gold/60 hover:bg-panel-3',
                  sel ? 'border-gold bg-panel-3 ring-2 ring-gold' : 'border-line',
                )}
              >
                <span className="relative">
                  <HeroAvatar heroId={x.id} size={phone ? 'md' : 'lg'} title={tip} />
                  <span
                    className={cx(
                      'pointer-events-none absolute inset-0 grid place-items-center rounded-lg text-[11px] font-bold transition-opacity group-hover:opacity-100',
                      sel ? 'opacity-100' : 'opacity-0',
                      type === 'ban' ? 'bg-bad/70 text-white' : 'bg-good/70 text-black',
                    )}
                  >
                    {verb}
                  </span>
                </span>
                <span className="w-full truncate text-center text-[11px] leading-tight">{x.cn}</span>
                <span className="absolute right-0.5 top-0.5">
                  <MetaTag meta={x.meta} />
                </span>
                <span className="absolute left-1 top-1 flex flex-col gap-0.5">
                  {mySig.has(x.id) && <span className="h-1.5 w-1.5 rounded-full bg-gold" title="我方招牌英雄" />}
                  {oppSig.has(x.id) && <span className="h-1.5 w-1.5 rounded-full bg-bad" title="对手招牌英雄" />}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-faint">
        <Badge className="bg-gold/20 text-gold">强势</Badge>版本强度 ≥ +1
        <Badge className="bg-good/15 text-good">热门</Badge>≥ +0.4
        <Badge className="bg-panel-3 text-faint">偏弱</Badge>≤ -1
      </div>
    </Card>
  );
}

// DotaPedia · 羁绊图鉴（第十波 #5）：历届 TI 冠军阵容（及少数经典阵容）的隐藏羁绊。
// 未解锁只显示提示（「TI6 冠军之魂 · ？？？」）；任意战队（含 AI）首次集齐五人后解锁，显示成员现状、激活战队与首次觉醒记录。只读。
import { useMemo, useState } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import { CONFIG, SYNERGY_KIND_LABEL, synergyBonusText, synergyCatalog, synergyProgress } from '../../engine';
import type { GameState, SynergyAttr, SynergyCatalogEntry } from '../../engine';
import { Card, EmptyState, PosBadge, cx } from '../components/common';
import { Chip } from '../components/SquadShared';
import { PPlayer, PStat, PTeam, safe } from '../components/PediaKit';
import { SYNERGY_ATTR_COLOR, SynergyEmblem, sinceText } from '../components/SynergyKit';

type Filter = 'all' | 'unlocked' | 'locked' | 'active';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unlocked', label: '已解锁' },
  { key: 'locked', label: '未解锁' },
  { key: 'active', label: '激活中' },
];
const ATTRS: SynergyAttr[] = ['insight', 'resilience', 'talent', 'power', 'mmr'];

export default function PediaSynergies() {
  const game = useGame();
  const version = useGameStore((s) => s.version);
  const myTeamId = game.settings.playerTeamId || null;
  const [filter, setFilter] = useState<Filter>('all');
  const entries = useMemo(() => safe(() => synergyCatalog(game, myTeamId), [] as SynergyCatalogEntry[]), [game, version, myTeamId]);
  const prog = useMemo(() => safe(() => synergyProgress(game), { unlocked: 0, total: 0, active: 0 }), [game, version]);
  const mine = entries.filter((e) => e.active && e.active.teamId === myTeamId).length;
  const shown = entries.filter((e) =>
    filter === 'all' ? true : filter === 'unlocked' ? e.unlocked : filter === 'locked' ? !e.unlocked : !!e.active,
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="grid grid-cols-3 gap-3 self-start">
          <PStat label="已解锁" value={`${prog.unlocked} / ${prog.total}`} accent sub="任意战队首次集齐即解锁" />
          <PStat label="当前激活" value={prog.active} sub="全联盟" />
          <PStat label="本方激活" value={myTeamId ? mine : '—'} sub={myTeamId ? game.teams[myTeamId]?.name : '观战中'} />
        </div>
        <RulesCard />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cx(
                'cursor-pointer px-3 py-1 text-xs',
                filter === f.key ? 'bg-panel-3 font-semibold text-ink' : 'bg-panel-2 text-mute hover:text-ink',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-faint">按届次排列 · 共 {shown.length} 条</span>
      </div>

      {shown.length === 0 ? (
        <Card>
          <EmptyState text={filter === 'active' ? '目前没有激活中的羁绊' : filter === 'unlocked' ? '还没有解锁任何羁绊' : '没有符合条件的羁绊'} />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {shown.map((e) => (e.unlocked ? <UnlockedCard key={e.def.id} game={game} e={e} myTeamId={myTeamId} /> : <LockedCard key={e.def.id} e={e} />))}
        </div>
      )}
    </div>
  );
}

/** 规则说明（数值取自 CONFIG） */
function RulesCard() {
  const after = CONFIG.synergy.activateAfterRealTi;
  return (
    <div className="rounded-xl border border-line bg-panel/90 px-4 py-3 text-xs leading-relaxed text-mute">
      <div className="mb-1.5 text-[13px] font-semibold text-ink">羁绊规则</div>
      <p>
        历届 TI 冠军阵容（及少数经典阵容）各带一个隐藏羁绊：五名成员同时效力于同一支战队（{CONFIG.synergy.requireStarters ? '均为首发' : '签约队员即可，不必都是首发；赛事临时替补不算'}）即觉醒，
        该队每名队员获得对应加成，有成员离队即失效。AI 战队同样可以觉醒。
        {after ? '该届真实 TI 打完之后（下一赛季起）才能觉醒。' : ''}
        {CONFIG.synergy.stackSameAttr ? '' : '同一战队的多个同属性羁绊不叠加。'}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ATTRS.map((a) => (
          <span key={a} className="inline-flex items-center gap-1 rounded border border-line bg-panel-2/70 py-0.5 pl-0.5 pr-1.5">
            <SynergyEmblem attr={a} size={18} />
            <span className="tabular" style={{ color: SYNERGY_ATTR_COLOR[a] }}>{synergyBonusText(a)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function LockedCard({ e }: { e: SynergyCatalogEntry }) {
  const what = e.def.kind === 'champion' ? `TI${e.def.ti} 冠军阵容` : `TI${e.def.ti} 一支经典阵容`;
  return (
    <div className="flex gap-3 rounded-xl border border-dashed border-line bg-panel/60 px-4 py-3">
      <SynergyEmblem locked size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-mute">{e.hint}</span>
          <Chip>未解锁</Chip>
        </div>
        <div className="mt-1 text-xs text-faint">集齐 {what}的五名选手即可觉醒 · 加成：？？？</div>
        {!e.available && <div className="mt-1 text-xs text-faint">TI{e.def.ti + 1} 赛季起可觉醒</div>}
      </div>
    </div>
  );
}

function UnlockedCard({ game, e, myTeamId }: { game: GameState; e: SynergyCatalogEntry; myTeamId: string | null }) {
  const d = e.def;
  const color = SYNERGY_ATTR_COLOR[d.attr];
  const origin = d.kind === 'champion'
    ? `${e.visibleTis.map((t) => `TI${t}`).join('、')} 冠军 ${d.club}`
    : `TI${d.ti} ${d.club}${d.result && /^\d/.test(d.result) ? `（第 ${d.result} 名）` : ''}`;
  const holder = e.active?.teamId ?? null;
  const u = e.unlock;
  return (
    <div className={cx('overflow-hidden rounded-xl border bg-panel/90 shadow-lg shadow-black/20', e.active ? 'border-gold/40' : 'border-line')}>
      <div className="h-1" style={{ background: d.color }} />
      <div className="px-4 py-3">
        <div className="flex gap-3">
          <SynergyEmblem attr={d.attr} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{d.name}</span>
              <Chip tone={d.kind === 'champion' ? 'gold' : 'info'}>{SYNERGY_KIND_LABEL[d.kind]}</Chip>
            </div>
            <div className="mt-0.5 text-xs text-mute">
              {origin} · <span className="tabular" style={{ color }}>全队{synergyBonusText(d.attr)}</span>
            </div>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {e.active ? (
            <>
              <Chip tone="good">● 激活中</Chip>
              <PTeam id={holder} />
              {!e.active.effective && <span className="text-faint">（与该队更早的同属性羁绊不叠加）</span>}
              <span className="text-faint">{sinceText(e.active.ti, e.active.round)}</span>
            </>
          ) : (
            <>
              <Chip>未激活</Chip>
              {myTeamId && e.owned > 0 && <span className="text-mute">本方已有 {e.owned}/5 名成员</span>}
            </>
          )}
        </div>

        <ul className="mt-2 divide-y divide-line/40 rounded-lg border border-line/60 bg-panel-2/40 text-[13px]">
          {e.members.map((m) => {
            const withHolder = !!holder && m.teamId === holder;
            return (
              <li key={m.id} className="flex items-center gap-2 px-2.5 py-1">
                <PosBadge pos={m.position} />
                <PPlayer id={m.id} handle={m.handle} className="min-w-0 truncate" />
                <span className="ml-auto flex min-w-0 items-center gap-1 text-xs">
                  {m.status === 'active' ? (
                    m.teamId ? <PTeam id={m.teamId} tag className={cx(withHolder ? 'text-ink' : 'text-mute')} /> : <span className="text-info">自由选手</span>
                  ) : (
                    <span className="text-faint">{m.status === 'retired' ? '已退役' : m.status === 'banned' ? '禁赛' : '—'}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        {u && (
          <div className="mt-2 text-[11px] text-faint">
            首次觉醒：TI{u.ti} 赛季{u.round > 0 ? `第 ${u.round} 回合` : '初'} · <PTeam id={u.teamId} name={u.teamName} noSwatch className="inline-flex" />
            {u.count > 1 && ` · 累计觉醒 ${u.count} 次`}
          </div>
        )}
      </div>
    </div>
  );
}

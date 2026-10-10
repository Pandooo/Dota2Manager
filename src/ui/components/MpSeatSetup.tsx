// ============================================================================
// 房间内「我的战队」设置：
// - 各自组建战队：俱乐部名称 / 简称 / 赛区 / 颜色（填写有效后自动同步到服务器）；
// - 选择已有战队：从起始 TI 的真实战队中挑选（已被其他玩家选择的战队不可选）。
// 已准备时锁定，取消准备后可修改。
// ============================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { CONFIG, REGIONS, REGION_LABEL, tierOf, type Region, type RosterFile, type SeedTeam } from '../../engine';
import type { MpMode, NewClubSpec, RoomInfo, RoomSeat } from '../../shared/protocol';
import { useGameStore } from '../../store/gameStore';
import { Badge, Button, Card, EmptyState, Hint, PosBadge, RegionBadge, TeamTag, TierBadge, cx } from './common';
import { Spinner } from './ShellKit';
import { MP_MODE_RULE, MP_SWATCHES, MpField, mpInputBase, mpInputCls } from './MpKit';

/** 首发 5 人的平均战力 */
function avgPower(team: SeedTeam): number {
  const ps = (team.players ?? []).slice(0, 5);
  return ps.length ? ps.reduce((s, p) => s + (p.power || 0), 0) / ps.length : 0;
}

function sameClub(a: NewClubSpec | undefined | null, b: NewClubSpec | undefined | null): boolean {
  if (!a || !b) return !a && !b;
  return a.name === b.name && a.tag === b.tag && a.region === b.region && a.color === b.color;
}

/** 新俱乐部信息校验（与新游戏向导同口径，另检查与房间内其他玩家重名/重简称） */
export function clubErrors(club: NewClubSpec | undefined | null, others: RoomSeat[], realTeams: SeedTeam[]): { name: string | null; tag: string | null } {
  const name = (club?.name ?? '').trim();
  const tag = (club?.tag ?? '').trim().toUpperCase();
  const otherClubs = others.map((s) => s.newClub).filter((c): c is NewClubSpec => !!c);
  const nameErr = !name
    ? '请填写俱乐部名称'
    : name.length > 24
      ? '名称最多 24 个字'
      : realTeams.some((t) => t.name.toLowerCase() === name.toLowerCase())
        ? '与现有战队重名'
        : otherClubs.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())
          ? '与房间内其他玩家的俱乐部重名'
          : null;
  const tagErr = !/^[A-Z0-9]{2,5}$/.test(tag)
    ? '简称需 2–5 个字母或数字'
    : realTeams.some((t) => t.tag.toUpperCase() === tag)
      ? '与现有战队的简称重复'
      : otherClubs.some((c) => c.tag.toUpperCase() === tag)
        ? '与房间内其他玩家的简称重复'
        : null;
  return { name: nameErr, tag: tagErr };
}

/** 座位设置是否完整（准备前置条件）；返回错误原因或 null */
export function seatSetupError(mode: MpMode, seat: RoomSeat | undefined, room: RoomInfo, realTeams: SeedTeam[] | null): string | null {
  if (!seat) return '你不在该房间中';
  const others = room.seats.filter((s) => s.seatKey !== seat.seatKey);
  if (mode === 'build') {
    if (!seat.newClub) return '请先填写俱乐部信息';
    const e = clubErrors(seat.newClub, others, realTeams ?? []);
    return e.name ?? e.tag;
  }
  if (!seat.teamId) return '请先选择一支战队';
  if (others.some((s) => s.teamId === seat.teamId)) return '该战队已被其他玩家选择';
  if (realTeams && !realTeams.some((t) => t.id === seat.teamId)) return '所选战队不在起始 TI 的阵容中，请重新选择';
  return null;
}

// ---------------------------------------------------------------------------
// 新俱乐部表单
// ---------------------------------------------------------------------------
function ClubForm({ room, seat, seatIndex, locked, realTeams }: { room: RoomInfo; seat: RoomSeat; seatIndex: number; locked: boolean; realTeams: SeedTeam[] }) {
  const send = useGameStore((s) => s.mpSend);
  const defaults = (): NewClubSpec => ({ name: '', tag: '', region: 'CN', color: MP_SWATCHES[seatIndex % MP_SWATCHES.length] });
  const [draft, setDraft] = useState<NewClubSpec>(() => seat.newClub ?? defaults());
  const lastSent = useRef<NewClubSpec | null>(seat.newClub ?? null);
  const others = room.seats.filter((s) => s.seatKey !== seat.seatKey);
  const errs = clubErrors(draft, others, realTeams);
  const valid = !errs.name && !errs.tag;

  // 服务器上的设置变化（重连、被重置）时同步到表单
  useEffect(() => {
    if (!sameClub(seat.newClub, lastSent.current)) {
      lastSent.current = seat.newClub ?? null;
      setDraft(seat.newClub ?? defaults());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seat.newClub]);

  // 有效且有改动时自动同步（防抖）
  useEffect(() => {
    if (locked || !valid) return;
    const clean: NewClubSpec = { name: draft.name.trim(), tag: draft.tag.toUpperCase(), region: draft.region, color: draft.color };
    if (sameClub(clean, seat.newClub)) return;
    const t = setTimeout(() => {
      lastSent.current = clean;
      send({ t: 'updateSeat', newClub: clean });
    }, 450);
    return () => clearTimeout(t);
  }, [draft, valid, locked, seat.newClub, send]);

  const set = (patch: Partial<NewClubSpec>) => setDraft((d) => ({ ...d, ...patch }));
  const synced = sameClub(seat.newClub, { name: draft.name.trim(), tag: draft.tag.toUpperCase(), region: draft.region, color: draft.color });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
      <div className="space-y-3">
        <MpField label="俱乐部名称" error={draft.name ? errs.name : null} hint="最多 24 个字">
          <input className={mpInputCls} value={draft.name} maxLength={30} disabled={locked} onChange={(e) => set({ name: e.target.value })} placeholder="俱乐部名称" />
        </MpField>
        <MpField label="简称（TAG）" error={draft.tag ? errs.tag : null} hint="2–5 个大写字母或数字，用于赛程与比分">
          <input
            className={cx(mpInputBase, 'w-40 font-semibold uppercase tracking-widest')}
            value={draft.tag}
            maxLength={5}
            disabled={locked}
            onChange={(e) => set({ tag: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) })}
            placeholder="TAG"
          />
        </MpField>
        <div>
          <div className="mb-1 text-xs font-medium text-mute">所属赛区</div>
          <div className="flex flex-wrap gap-1.5">
            {REGIONS.map((r) => (
              <button
                key={r}
                disabled={locked}
                onClick={() => set({ region: r as Region })}
                className={cx(
                  'cursor-pointer rounded-md border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  draft.region === r ? 'border-gold/60 bg-gold/15 text-gold' : 'border-line bg-panel-2/50 text-mute hover:text-ink',
                )}
              >
                <span className="font-semibold">{r}</span> <span className="opacity-80">{REGION_LABEL[r]}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-mute">主色</div>
          <div className="flex flex-wrap items-center gap-2">
            {MP_SWATCHES.map((c) => (
              <button
                key={c}
                disabled={locked}
                onClick={() => set({ color: c })}
                title={c}
                className={cx('h-7 w-7 cursor-pointer rounded-md border-2 transition-transform hover:scale-110 disabled:cursor-not-allowed', draft.color === c ? 'border-white' : 'border-transparent')}
                style={{ background: c }}
              />
            ))}
            <label className="flex cursor-pointer items-center gap-1 text-xs text-mute" title="自定义颜色">
              <input type="color" value={draft.color} disabled={locked} onChange={(e) => set({ color: e.target.value })} className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent" />
              自定义
            </label>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <div className="overflow-hidden rounded-xl border border-line bg-panel-2/60">
          <div className="h-14" style={{ background: `linear-gradient(120deg, ${draft.color}, transparent 85%)` }} />
          <div className="-mt-6 px-4 pb-4">
            <div className="grid h-12 w-12 place-items-center rounded-xl border-2 border-panel text-base font-black tracking-wide text-white shadow-lg" style={{ background: draft.color }}>
              <span className="drop-shadow">{(draft.tag || '??').slice(0, 3)}</span>
            </div>
            <div className="mt-2 truncate text-base font-bold">{draft.name.trim() || '未命名俱乐部'}</div>
            <div className="text-xs text-mute">
              {draft.tag || 'TAG'} · {REGION_LABEL[draft.region]} · 初始荣誉 {CONFIG.team.newClubHonor}
            </div>
          </div>
        </div>
        <div className={cx('text-[11px]', synced && valid ? 'text-good' : 'text-faint')}>
          {locked ? '已准备：取消准备后可修改' : synced && valid ? '✓ 已同步到房间' : valid ? '正在同步…' : '填写完整后自动同步'}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 选择真实战队
// ---------------------------------------------------------------------------
function TeamPicker({ room, seat, locked, roster }: { room: RoomInfo; seat: RoomSeat; locked: boolean; roster: RosterFile }) {
  const send = useGameStore((s) => s.mpSend);
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState<Region | 'ALL'>('ALL');
  const takenBy = new Map<string, string>();
  for (const s of room.seats) if (s.seatKey !== seat.seatKey && s.teamId) takenBy.set(s.teamId, s.name);
  const teams = useMemo(() => (roster.teams ?? []).filter((t) => t && t.id), [roster]);
  const q = search.trim().toLowerCase();
  const list = teams
    .filter((t) => region === 'ALL' || t.region === region)
    .filter((t) => !q || t.name.toLowerCase().includes(q) || t.tag.toLowerCase().includes(q) || (t.players ?? []).some((p) => p.handle.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.atTI) - Number(a.atTI) || avgPower(b) - avgPower(a));

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gold/30 bg-gold/5 px-3 py-2 text-xs leading-relaxed text-mute">
        <span className="font-semibold text-gold">公平规则：</span>
        {MP_MODE_RULE.existing}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className={cx(mpInputBase, 'w-56 max-w-full py-1.5 text-xs')} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索战队 / 简称 / 选手" />
        <div className="flex flex-wrap gap-1">
          {(['ALL', ...REGIONS] as (Region | 'ALL')[]).map((r) => (
            <button
              key={r}
              onClick={() => setRegion(r)}
              className={cx('cursor-pointer rounded-md border px-2 py-1 text-xs', region === r ? 'border-gold/60 bg-gold/15 text-gold' : 'border-line text-mute hover:text-ink')}
            >
              {r === 'ALL' ? '全部' : REGION_LABEL[r]}
            </button>
          ))}
        </div>
        {locked && <span className="ml-auto text-[11px] text-faint">已准备：取消准备后可更换</span>}
      </div>
      {list.length === 0 ? (
        <EmptyState text="没有符合条件的战队" />
      ) : (
        <div className="grid max-h-[420px] gap-2 overflow-y-auto pr-1 md:grid-cols-2">
          {list.map((t) => {
            const mine = seat.teamId === t.id;
            const by = takenBy.get(t.id);
            const disabled = locked || !!by;
            const starters = (t.players ?? []).slice(0, 5);
            return (
              <button
                key={t.id}
                disabled={disabled && !mine}
                onClick={() => !disabled && !mine && send({ t: 'updateSeat', teamId: t.id })}
                title={by ? `已被 ${by} 选择` : mine ? '你选择的战队' : `选择 ${t.name}`}
                className={cx(
                  'relative flex flex-col overflow-hidden rounded-lg border px-3 py-2 pl-4 text-left transition-colors disabled:cursor-not-allowed',
                  mine ? 'border-gold bg-gold/10 ring-1 ring-gold/40' : by ? 'border-line bg-panel-2/30 opacity-45' : 'cursor-pointer border-line bg-panel-2/50 hover:border-gold/40',
                )}
              >
                <span className="absolute inset-y-0 left-0 w-1" style={{ background: t.color || '#8b96ab' }} />
                <div className="flex items-center gap-2">
                  <TeamTag color={t.color || '#8b96ab'} tag={t.tag} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.name}</span>
                  <RegionBadge region={t.region} />
                  {mine && <Badge className="bg-gold font-bold text-black">✓ 我的</Badge>}
                  {by && <Badge className="bg-panel-3 text-mute">{by}</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-mute">
                  {starters.map((p) => (
                    <span key={p.id} className="inline-flex items-center gap-1">
                      <PosBadge pos={p.position} />
                      <span className="text-ink">{p.handle}</span>
                      <TierBadge tier={tierOf(p.mmr)} />
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      )}
      <Hint>选手属性将按新俱乐部水平重置（保留姓名、ID 与天赋），因此这里只展示阵容名单，不代表开局实力。</Hint>
    </div>
  );
}

export default function MpSeatSetup({
  room,
  seat,
  roster,
  rosterError,
  onRetry,
}: {
  room: RoomInfo;
  seat: RoomSeat;
  roster: RosterFile | null;
  rosterError: string | null;
  onRetry: () => void;
}) {
  const mode = room.settings.mode;
  const locked = seat.lobbyReady;
  const seatIndex = Math.max(0, room.seats.findIndex((s) => s.seatKey === seat.seatKey));
  return (
    <Card title="我的战队" subtitle={mode === 'build' ? '各自组建战队：填写你的新俱乐部' : `选择已有战队：从 TI${room.settings.startTi} 的真实战队中挑选`}>
      {mode === 'build' ? (
        <ClubForm room={room} seat={seat} seatIndex={seatIndex} locked={locked} realTeams={roster?.teams ?? []} />
      ) : rosterError ? (
        <EmptyState text={`阵容数据加载失败：${rosterError}`}>
          <Button size="sm" onClick={onRetry}>
            重试
          </Button>
        </EmptyState>
      ) : !roster ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-mute">
          <Spinner className="h-5 w-5 text-gold" /> 正在加载 TI{room.settings.startTi} 阵容…
        </div>
      ) : (
        <TeamPicker room={room} seat={seat} locked={locked} roster={roster} />
      )}
    </Card>
  );
}

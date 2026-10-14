// ============================================================================
// 多人房间：座位列表（昵称 / 准备 / 在线 / 所选战队）、房主设置（起止 TI、难度、玩法）、
// 我的战队设置（新俱乐部或真实战队）、准备、房主开始 / 踢人、离开、房间码与邀请地址（局域网服务器且来自局域网时为局域网地址，
// 否则为当前页面地址）、服务器在线人数、聊天。
// ============================================================================
import { useEffect, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { getManualServer, invitePageUrl, onRequestError } from '../../store/net';
import { REGION_LABEL, type RosterFile } from '../../engine';
import { loadRoster } from '../../data/index';
import { isRoomHost, mySeat, type RoomInfo, type RoomSeat, type RoomSettings } from '../../shared/protocol';
import { Badge, Button, Card, Hint, TeamTag, cx } from '../components/common';
import { ConfirmButton } from '../components/ConfirmPopover';
import { Spinner } from '../components/ShellKit';
import { ConnBadge, CopyButton, OnlineDot, ServerStatsLine, settingsSummary } from '../components/MpKit';
import MpRoomSettings from '../components/MpRoomSettings';
import MpSeatSetup, { seatSetupError } from '../components/MpSeatSetup';
import MpChat from '../components/MpChat';

const rosterCache = new Map<number, RosterFile>();
/** 开局最少人数（与服务器 server/validate.ts LIMITS.minPlayers 一致） */
const MIN_PLAYERS = 2;

/** 起始 TI 的真实阵容（existing 选队、build 查重名） */
function useRoster(ti: number): { roster: RosterFile | null; error: string | null; retry: () => void } {
  const [roster, setRoster] = useState<RosterFile | null>(() => rosterCache.get(ti) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    const hit = rosterCache.get(ti);
    if (hit) {
      setRoster(hit);
      setError(null);
      return;
    }
    let cancelled = false;
    setRoster(null);
    setError(null);
    loadRoster(ti)
      .then((r) => {
        if (cancelled) return;
        rosterCache.set(ti, r);
        setRoster(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error)?.message || '阵容数据加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [ti, key]);
  return { roster, error, retry: () => setKey((k) => k + 1) };
}

function SeatRow({
  seat,
  room,
  roster,
  me,
  isHost,
  onKick,
}: {
  seat: RoomSeat;
  room: RoomInfo;
  roster: RosterFile | null;
  me: boolean;
  isHost: boolean;
  onKick: () => void;
}) {
  const host = seat.seatKey === room.hostSeatKey;
  const mode = room.settings.mode;
  const real = mode === 'existing' && seat.teamId ? roster?.teams.find((t) => t.id === seat.teamId) : undefined;
  const club = mode === 'build' ? seat.newClub : undefined;
  const choice =
    mode === 'existing' ? (
      real ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <TeamTag color={real.color || '#8b96ab'} tag={real.tag} />
          <span className="truncate">{real.name}</span>
        </span>
      ) : seat.teamId ? (
        <span className="text-mute">{seat.teamId}</span>
      ) : (
        <span className="text-faint">尚未选择战队</span>
      )
    ) : club ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <TeamTag color={club.color} tag={club.tag} />
        <span className="truncate">{club.name}</span>
        <span className="shrink-0 text-faint">{REGION_LABEL[club.region]}</span>
      </span>
    ) : (
      <span className="text-faint">尚未填写俱乐部</span>
    );
  return (
    <div className={cx('flex items-center gap-3 rounded-lg border px-3 py-2', me ? 'border-gold/50 bg-gold/5' : 'border-line bg-panel-2/40')}>
      <OnlineDot online={seat.connected} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm">
          <span className={cx('truncate font-semibold', me && 'text-gold')}>{seat.name}</span>
          {host && (
            <span className="text-gold" title="房主">
              ♛
            </span>
          )}
          {me && <Badge className="bg-gold/15 text-gold">我</Badge>}
          {!seat.connected && <Badge className="bg-panel-3 text-faint">离线</Badge>}
        </div>
        <div className="mt-0.5 min-w-0 text-xs">{choice}</div>
      </div>
      {seat.lobbyReady ? <Badge className="bg-good/15 font-semibold text-good">✓ 已准备</Badge> : <Badge className="bg-panel-3 text-mute">未准备</Badge>}
      {isHost && !me && (
        <ConfirmButton
          size="xs"
          variant="danger"
          title={`把 ${seat.name} 移出房间`}
          confirm={{
            title: '移出玩家',
            message: (
              <>
                确定把 <span className="font-semibold text-ink">{seat.name}</span> 移出房间吗？
              </>
            ),
            confirmLabel: '确认移出',
            danger: true,
          }}
          onConfirm={onKick}
        >
          踢出
        </ConfirmButton>
      )}
    </div>
  );
}

export default function Room() {
  const mp = useGameStore((s) => s.mp);
  const send = useGameStore((s) => s.mpSend);
  const leave = useGameStore((s) => s.mpLeaveRoom);
  const room = mp.room;
  const [starting, setStarting] = useState(false);
  /** 服务器拒绝开始游戏的原因（就地显示在按钮下方；提示同时由 store 弹出） */
  const [startRejected, setStartRejected] = useState<string | null>(null);
  const { roster, error: rosterError, retry } = useRoster(room?.settings.startTi ?? 1);

  // 开始请求发出后：被服务器拒绝（error 带 ref: startGame）、房间状态变化、连接中断或数秒无响应时复位
  useEffect(
    () =>
      onRequestError('startGame', (message) => {
        setStarting(false);
        setStartRejected(message);
      }),
    [],
  );
  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(() => setStarting(false), 15000);
    return () => clearTimeout(t);
  }, [starting]);
  useEffect(() => setStarting(false), [room?.status]);
  useEffect(() => {
    if (mp.net.status !== 'open') setStarting(false);
  }, [mp.net.status]);
  // 座位或设置变化后，上一次的拒绝原因可能已不成立
  const seatsSig = room ? room.seats.map((s) => `${s.seatKey}:${s.lobbyReady ? 1 : 0}${s.connected ? 1 : 0}`).join('|') : '';
  const settingsSig = room ? JSON.stringify(room.settings) : '';
  useEffect(() => setStartRejected(null), [seatsSig, settingsSig]);

  if (!room) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-mute">
        <div className="flex items-center gap-2">
          <Spinner className="h-5 w-5 text-gold" /> 正在进入房间…
        </div>
        <Button variant="ghost" size="sm" onClick={leave}>
          返回大厅
        </Button>
      </div>
    );
  }

  const me = mySeat(room);
  const isHost = isRoomHost(room);
  const playing = room.status !== 'lobby';
  const setupError = seatSetupError(room.settings.mode, me, room, roster?.teams ?? null);
  const allReady = room.seats.length > 0 && room.seats.every((s) => s.lobbyReady);
  const notReady = room.seats.filter((s) => !s.lobbyReady).map((s) => s.name);
  const offline = room.seats.filter((s) => !s.connected).map((s) => s.name);
  const startBlock = !isHost
    ? '只有房主可以开始游戏'
    : room.seats.length < MIN_PLAYERS
      ? `至少需要 ${MIN_PLAYERS} 名玩家才能开始`
      : !allReady
        ? `等待玩家准备：${notReady.join('、')}`
        : offline.length
          ? `有玩家离线：${offline.join('、')}`
          : null;
  // 局域网地址只发给局域网内的连接（公网服务器从不发送）；没有时邀请朋友打开当前页面地址
  const lanPages = mp.serverMode === 'public' ? [] : mp.lanUrls.filter(Boolean);
  const pageUrl = lanPages[0] ?? invitePageUrl();

  const updateSettings = (patch: Partial<RoomSettings>) => send({ t: 'updateSettings', settings: patch });
  const toggleReady = () => {
    if (!me) return;
    if (!me.lobbyReady && setupError) return;
    send({ t: 'setLobbyReady', ready: !me.lobbyReady });
  };
  const start = () => {
    if (startBlock || starting) return;
    setStartRejected(null);
    if (send({ t: 'startGame' })) setStarting(true);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 手机宽度（< sm）：收紧间距、按钮缩为「‹ 离开」、隐藏「房间码」字样与在线人数（大厅里仍可看到）、房间码字距收窄，
          房间码与连接状态不被挤出（375px 实测：离开按钮不再折成三行，房间名有更多空间） */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel/95 px-3 sm:gap-3 sm:px-5">
        <Button variant="ghost" size="sm" onClick={leave} title="离开房间，回到大厅" className="shrink-0 whitespace-nowrap">
          ‹ 离开<span className="hidden sm:inline">房间</span>
        </Button>
        <div className="min-w-0 flex-1 sm:flex-none">
          <div className="truncate text-base font-bold tracking-wide">{room.name}</div>
          <div className="truncate text-[11px] text-faint">{settingsSummary(room.settings)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-md border border-gold/40 bg-gold/10 py-0.5 pl-2 pr-1 sm:ml-3 sm:gap-1.5 sm:pl-2.5" title="房间码">
          <span className="hidden text-[11px] text-mute sm:inline">房间码</span>
          <span className="font-mono text-sm font-bold tracking-[0.08em] text-gold sm:text-base sm:tracking-[0.25em]">{room.id}</span>
          <CopyButton text={room.id} title="复制房间码" />
        </div>
        <div className="flex shrink-0 items-center gap-3 sm:ml-auto">
          {mp.net.status === 'open' && (
            <span className="hidden sm:inline-flex">
              <ServerStatsLine stats={mp.serverStats} compact />
            </span>
          )}
          <ConnBadge net={mp.net} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {playing && (
          <div className="mx-auto mb-4 flex max-w-6xl items-center gap-2 rounded-lg border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-gold">
            <Spinner className="h-4 w-4" />
            {room.status === 'finished' ? '对局已结束，正在同步最终状态…' : '游戏已开始，正在同步游戏状态…'}
          </div>
        )}
        <div className="mx-auto grid max-w-6xl gap-5 xl:grid-cols-[1fr_380px]">
          <div className="min-w-0 space-y-5">
            <MpRoomSettings settings={room.settings} editable={isHost && !playing} onChange={updateSettings} />
            {me && !playing && <MpSeatSetup room={room} seat={me} roster={roster} rosterError={rosterError} onRetry={retry} />}
          </div>

          <div className="space-y-4">
            <Card title={`玩家（${room.seats.length}/${room.maxPlayers}）`} subtitle={isHost ? '你是房主' : `房主：${room.seats.find((s) => s.seatKey === room.hostSeatKey)?.name ?? '—'}`}>
              <div className="space-y-2">
                {room.seats.map((s) => (
                  <SeatRow
                    key={s.seatKey}
                    seat={s}
                    room={room}
                    roster={roster}
                    me={s.seatKey === room.yourSeatKey}
                    isHost={isHost && !playing}
                    onKick={() => send({ t: 'kick', seatKey: s.seatKey })}
                  />
                ))}
                {Array.from({ length: Math.max(0, room.maxPlayers - room.seats.length) }, (_, i) => (
                  <div key={`empty-${i}`} className="rounded-lg border border-dashed border-line px-3 py-2.5 text-xs text-faint">
                    空位 · 等待玩家加入
                  </div>
                ))}
              </div>

              {!playing && me && (
                <div className="mt-4 space-y-2">
                  <Button
                    variant={me.lobbyReady ? 'secondary' : 'primary'}
                    size="lg"
                    className="w-full"
                    disabled={!me.lobbyReady && !!setupError}
                    title={!me.lobbyReady && setupError ? setupError : undefined}
                    onClick={toggleReady}
                  >
                    {me.lobbyReady ? '取消准备' : '准备'}
                  </Button>
                  {!me.lobbyReady && setupError && <div className="text-center text-[11px] text-bad">{setupError}</div>}
                  {isHost && (
                    <Button variant="gold" size="lg" className={cx('w-full', !startBlock && 'glow')} disabled={!!startBlock || starting} title={startBlock ?? '所有玩家已准备，开始游戏'} onClick={start}>
                      {starting ? '正在创建游戏…' : '开始游戏 ▶'}
                    </Button>
                  )}
                  {isHost && startBlock && <div className="text-center text-[11px] text-faint">{startBlock}</div>}
                  {isHost && !startBlock && !starting && startRejected && (
                    <div className="text-center text-[11px] text-bad" role="alert">
                      未能开始：{startRejected}
                    </div>
                  )}
                  {!isHost && <Hint className="text-center">全部玩家准备后，由房主开始游戏。</Hint>}
                </div>
              )}
            </Card>

            <Card
              title="邀请朋友"
              subtitle={
                lanPages.length
                  ? '同一局域网内打开下面的地址，进入多人对战后输入房间码'
                  : `把${getManualServer() ? '服务器的网页地址' : '本页地址'}发给朋友，进入「多人对战」后用房间码加入`
              }
            >
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2 py-1">
                  <span className="text-faint">网页</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-ink">{pageUrl}</span>
                  <CopyButton text={pageUrl} title="复制邀请地址" />
                </div>
                {lanPages.slice(1).map((u) => (
                  <div key={u} className="flex items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2 py-1">
                    <span className="text-faint">备选</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-ink">{u}</span>
                    <CopyButton text={u} />
                  </div>
                ))}
                <div className="flex items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2 py-1">
                  <span className="text-faint">房间码</span>
                  <span className="min-w-0 flex-1 font-mono font-bold tracking-[0.25em] text-gold">{room.id}</span>
                  <CopyButton text={`${room.name} · 房间码 ${room.id} · ${pageUrl}`} label="复制邀请" title="复制邀请文字（房间名、房间码与地址）" />
                </div>
              </div>
            </Card>

            <Card title="房间聊天" bodyClassName="p-0">
              <MpChat height="h-56" />
            </Card>
          </div>
        </div>
      </div>

    </div>
  );
}

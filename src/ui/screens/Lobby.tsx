// ============================================================================
// 多人大厅：连接状态与在线统计 / 服务器地址 / 玩家昵称 / 房间列表 / 创建房间 / 房间码加入
// 局域网：房主在电脑上运行 `npm run server`，朋友在浏览器打开 http://<房主局域网IP>:8686 即可进入；
// 公网服务器（welcome.publicServer）：不显示任何局域网说明，邀请地址为当前页面地址。
// ============================================================================
import { useEffect, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { defaultServerUrl, getManualServer, getNetIdentity, invitePageUrl, normalizeServerAddress } from '../../store/net';
import { DEFAULT_SERVER_PORT, type RoomSummary } from '../../shared/protocol';
import { Badge, Button, Card, EmptyState, Hint, cx } from '../components/common';
import { ConnBadge, CopyButton, MpField, ServerStatsLine, mpInputBase, mpInputCls, settingsSummary } from '../components/MpKit';
import NewBadge from '../components/NewBadge';

const ROOM_STATUS: Record<RoomSummary['status'], { text: string; cls: string }> = {
  lobby: { text: '等待中', cls: 'bg-good/15 text-good' },
  playing: { text: '进行中', cls: 'bg-gold/15 text-gold' },
  finished: { text: '已结束', cls: 'bg-panel-3 text-faint' },
};

function timeAgo(ts: number | null): string {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 5 ? '刚刚' : s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分钟前`;
}

export default function Lobby() {
  const mp = useGameStore((s) => s.mp);
  const exit = useGameStore((s) => s.mpExit);
  const connect = useGameStore((s) => s.mpConnect);
  const reconnect = useGameStore((s) => s.mpReconnect);
  const send = useGameStore((s) => s.mpSend);
  const setName = useGameStore((s) => s.mpSetName);
  const identity = getNetIdentity();
  const connected = mp.net.status === 'open';
  /** 局域网服务器（收到 welcome 且不是公网模式）：显示房主运行服务器、局域网地址等说明 */
  const lan = mp.serverMode === 'lan';
  const pub = mp.serverMode === 'public';

  const [addr, setAddr] = useState(() => getManualServer() ?? '');
  const [nameDraft, setNameDraft] = useState(mp.playerName);
  const [roomName, setRoomName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [code, setCode] = useState('');

  useEffect(() => setNameDraft(mp.playerName), [mp.playerName]);

  // 连接后定时刷新房间列表
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => send({ t: 'listRooms' }), 10000);
    return () => clearInterval(t);
  }, [connected, send]);

  const addrNorm = addr.trim() ? normalizeServerAddress(addr) : null;
  const addrError = addr.trim() && !addrNorm ? (pub ? '地址格式不正确，请填写「地址:端口」' : `地址格式不正确，例如 192.168.1.5:${DEFAULT_SERVER_PORT}`) : null;
  const usingManual = !!getManualServer();

  const nameTrim = nameDraft.trim();
  const nameError = !nameTrim ? '请填写昵称' : nameTrim.length > 16 ? '最多 16 个字' : null;
  const commitName = () => {
    if (nameError || nameTrim === mp.playerName) return;
    setName(nameTrim);
  };

  const roomNameTrim = roomName.trim() || `${mp.playerName || '玩家'}的房间`;
  const create = () => {
    if (!connected) return;
    commitName();
    send({ t: 'createRoom', name: roomNameTrim.slice(0, 24), maxPlayers });
  };
  const codeNorm = code.trim().toUpperCase();
  const codeOk = /^[A-Z0-9]{6}$/.test(codeNorm);
  const join = (roomId: string) => {
    if (!connected) return;
    commitName();
    send({ t: 'joinRoom', roomId });
  };

  // 自己有座位的房间（可回去继续 / 查看结算）排在最前，其次是等待中的房间
  const rooms = mp.rooms
    .slice()
    .sort((a, b) => (a.mine ? 0 : 1) - (b.mine ? 0 : 1) || (a.status === 'lobby' ? 0 : 1) - (b.status === 'lobby' ? 0 : 1) || a.name.localeCompare(b.name));
  // 局域网地址只有局域网内的连接才会收到；没有时邀请朋友打开当前页面地址（手动连接其他服务器时为该服务器的地址）
  const lanPages = pub ? [] : Array.from(new Set(mp.lanUrls.filter(Boolean)));
  const invitePage = invitePageUrl();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 手机宽度（< sm）：按钮、标题与连接状态不换行（原来逐字折行），服务器名与「玩家」字样隐藏（下方卡片里都有） */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel/95 px-3 sm:gap-4 sm:px-5">
        <Button variant="ghost" size="sm" onClick={exit} title="断开连接，返回主菜单" className="shrink-0 whitespace-nowrap">
          ‹ 主菜单
        </Button>
        <div className="shrink-0 whitespace-nowrap text-base font-bold tracking-wide">{lan ? '多人对战（局域网）' : '多人对战'}</div>
        <ConnBadge net={mp.net} className="shrink-0 whitespace-nowrap sm:ml-2" />
        {mp.serverName && <span className="hidden min-w-0 truncate text-xs text-faint sm:inline">服务器：{mp.serverName}</span>}
        <span className="ml-auto min-w-0 truncate text-xs text-mute">
          <span className="hidden sm:inline">玩家 </span><span className="font-semibold text-ink">{mp.playerName}</span>
          {identity.alias && <Badge className="ml-1.5 bg-info/15 text-info" title="URL 参数 ?as= 指定的测试身份（独立会话）">测试身份 {identity.alias}</Badge>}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[340px_1fr]">
          {/* ---------------- 左栏 ---------------- */}
          <div className="space-y-4">
            <Card
              title="服务器"
              subtitle={
                lan
                  ? '房主电脑运行 npm run server 后，同一局域网内的玩家即可连接'
                  : pub
                    ? '在线服务器：朋友打开同一网页地址即可加入'
                    : '连接多人服务器后即可创建或加入房间'
              }
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <ConnBadge net={mp.net} />
                  {mp.net.status !== 'open' && (
                    <Button size="xs" onClick={reconnect} disabled={mp.net.status === 'connecting'}>
                      立即重连
                    </Button>
                  )}
                </div>
                {connected && <ServerStatsLine stats={mp.serverStats} badge={<NewBadge feature="onlineStats" dismissOn="view" />} />}
                <div className="break-all rounded-md border border-line bg-panel-2/60 px-2.5 py-1.5 font-mono text-[11px] text-mute">{mp.net.url || defaultServerUrl()}</div>
                {mp.net.error && mp.net.status !== 'open' && <div className="text-[11px] text-bad">{mp.net.error}</div>}
                <MpField
                  label="手动地址（可选）"
                  hint={pub ? '连接其他服务器时填写「地址:端口」；留空 = 使用当前网页地址' : `填写房主的 IP:端口，例如 192.168.1.5:${DEFAULT_SERVER_PORT}；留空 = 使用当前网页地址`}
                  error={addrError}
                >
                  <div className="flex gap-2">
                    <input
                      className={cx(mpInputBase, 'min-w-0 flex-1 font-mono')}
                      value={addr}
                      placeholder={pub ? '地址:端口' : `192.168.1.5:${DEFAULT_SERVER_PORT}`}
                      onChange={(e) => setAddr(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && !addrError && connect(addr.trim() || null)}
                    />
                    <Button variant="primary" size="sm" disabled={!!addrError} onClick={() => connect(addr.trim() || null)}>
                      连接
                    </Button>
                  </div>
                </MpField>
                {usingManual && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setAddr('');
                      connect(null);
                    }}
                  >
                    恢复默认地址（本页）
                  </Button>
                )}
                {lanPages.length > 0 ? (
                  <div>
                    <div className="mb-1 text-xs font-medium text-mute">邀请朋友打开（局域网地址）</div>
                    <div className="space-y-1">
                      {lanPages.map((u) => (
                        <div key={u} className="flex items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2 py-1">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{u}</span>
                          <CopyButton text={u} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  connected && (
                    <div>
                      <div className="mb-1 text-xs font-medium text-mute">邀请朋友打开</div>
                      <div className="flex items-center gap-2 rounded-md border border-line bg-panel-2/50 px-2 py-1">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{invitePage}</span>
                        <CopyButton text={invitePage} title="复制邀请地址" />
                      </div>
                    </div>
                  )
                )}
              </div>
            </Card>

            <Card title="玩家">
              <MpField label="昵称" hint="显示在房间与其他玩家的快讯中（最多 16 字）" error={nameDraft ? nameError : '请填写昵称'}>
                <input
                  className={mpInputCls}
                  value={nameDraft}
                  maxLength={20}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => e.key === 'Enter' && commitName()}
                />
              </MpField>
              {/* 开发调试用的提示：公网服务器上对普通玩家没有意义，不显示 */}
              {!pub && (
                <Hint className="mt-2">
                  同一浏览器多开测试：在网址后加 <span className="font-mono text-ink">?as=小明</span> 使用独立身份。
                </Hint>
              )}
            </Card>

            <Card title="加入房间">
              <div className="flex gap-2">
                <input
                  className={cx(mpInputBase, 'min-w-0 flex-1 font-mono uppercase tracking-[0.3em]')}
                  value={code}
                  maxLength={6}
                  placeholder="房间码"
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                  onKeyDown={(e) => e.key === 'Enter' && codeOk && join(codeNorm)}
                />
                <Button variant="primary" disabled={!connected || !codeOk} onClick={() => join(codeNorm)} title={!connected ? '未连接到服务器' : !codeOk ? '房间码为 6 位字母或数字' : undefined}>
                  加入
                </Button>
              </div>
            </Card>

            <Card title="创建房间" subtitle="你将成为房主，负责设置起止 TI、难度与玩法">
              <div className="space-y-3">
                <MpField label="房间名称">
                  <input className={mpInputCls} value={roomName} maxLength={24} placeholder={roomNameTrim} onChange={(e) => setRoomName(e.target.value)} />
                </MpField>
                <div>
                  <div className="mb-1 text-xs font-medium text-mute">最大人数</div>
                  <div className="flex gap-1.5">
                    {[2, 3, 4, 5, 6].map((n) => (
                      <button
                        key={n}
                        onClick={() => setMaxPlayers(n)}
                        className={cx(
                          'h-8 w-10 cursor-pointer rounded-md border text-sm font-semibold transition-colors',
                          maxPlayers === n ? 'border-gold/70 bg-gold/15 text-gold' : 'border-line bg-panel-2/50 text-mute hover:text-ink',
                        )}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <Button variant="gold" className="w-full" disabled={!connected} onClick={create} title={!connected ? '未连接到服务器' : undefined}>
                  创建房间
                </Button>
              </div>
            </Card>
          </div>

          {/* ---------------- 房间列表 ---------------- */}
          <Card
            title="房间列表"
            subtitle={mp.roomsLoadedAt ? `共 ${rooms.length} 个房间 · 更新于 ${timeAgo(mp.roomsLoadedAt)}` : connected ? '正在获取…' : '连接服务器后显示'}
            actions={
              <Button size="sm" onClick={() => send({ t: 'listRooms' })} disabled={!connected}>
                ⟳ 刷新
              </Button>
            }
            bodyClassName="p-0"
          >
            {!connected ? (
              <EmptyState
                text={
                  mp.net.status !== 'closed'
                    ? '正在连接服务器…'
                    : pub
                      ? '未连接到服务器。请稍后点「立即重连」，或刷新页面。'
                      : '未连接到服务器。请确认房主已运行服务器，或填写房主的 IP:端口。'
                }
              />
            ) : rooms.length === 0 ? (
              <EmptyState text="暂时没有房间，创建一个邀请朋友加入吧。" />
            ) : (
              <div className="divide-y divide-line/60">
                {rooms.map((r) => {
                  const st = ROOM_STATUS[r.status] ?? ROOM_STATUS.lobby;
                  const full = r.players >= r.maxPlayers;
                  // 服务器只把已结束的对局列给原座位玩家；进行中的对局只有原座位玩家能重新加入
                  const why = r.mine
                    ? null
                    : r.status === 'finished'
                      ? '对局已结束'
                      : r.status === 'playing'
                        ? '对局进行中，只有原座位的玩家可以重新加入'
                        : full
                          ? '房间已满'
                          : null;
                  const label = r.mine ? (r.status === 'finished' ? '查看结算' : r.status === 'playing' ? '回到对局' : '回到房间') : r.status === 'playing' ? '进行中' : '加入';
                  return (
                    <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-panel-2/40">
                      <div className="min-w-[200px] flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">{r.name}</span>
                          <Badge className={st.cls}>{st.text}</Badge>
                          {r.mine && <Badge className="bg-info/15 text-info">我的座位</Badge>}
                        </div>
                        <div className="mt-0.5 text-xs text-mute">
                          房主 {r.hostName} · <span className="font-mono text-faint">{r.id}</span>
                        </div>
                        <div className="text-[11px] text-faint">{settingsSummary(r.settings)}</div>
                      </div>
                      <div className="text-sm tabular">
                        <span className={cx('font-semibold', full ? 'text-bad' : 'text-ink')}>{r.players}</span>
                        <span className="text-faint"> / {r.maxPlayers} 人</span>
                      </div>
                      <Button
                        size="sm"
                        variant={r.mine || r.status === 'lobby' ? 'primary' : 'secondary'}
                        disabled={!!why}
                        title={why ?? (r.mine ? (r.status === 'finished' ? '回到已结束的对局查看结算' : `回到「${r.name}」`) : `加入「${r.name}」`)}
                        onClick={() => join(r.id)}
                      >
                        {label}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="mx-auto mt-5 max-w-6xl rounded-lg border border-line bg-panel/70 px-4 py-3 text-xs leading-relaxed text-mute">
          <span className="font-semibold text-ink">怎么开局：</span>
          {lan ? (
            <>
              房主在电脑上运行 <span className="font-mono text-ink">npm run server</span>（默认端口 {DEFAULT_SERVER_PORT}），朋友在浏览器打开{' '}
              <span className="font-mono text-ink">{lanPages[0] ?? invitePage}</span>
              ，进入「多人对战」后用房间码加入。
            </>
          ) : (
            <>
              {usingManual ? '把服务器的网页地址' : '把本页地址'} <span className="font-mono text-ink">{invitePage}</span> 发给朋友，进入「多人对战」后用房间码加入。
            </>
          )}
          所有玩家共享同一个回合，各自完成操作后点「准备」，全员准备后回合推进；其他玩家的转会、签约、赛果等公开动态会实时推送。
        </div>
      </div>
    </div>
  );
}

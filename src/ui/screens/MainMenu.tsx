// 主菜单（入口）：匿名会话 → 继续当前进度 / 新建游戏；另可导入存档、查看玩法说明
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useGameStore } from '../../store/gameStore';
import { getSession, type ProgressMeta } from '../../store/session';
import { formatGold } from '../../engine';
import { availableStartTis } from '../../data/index';
import { Button, Modal, cx } from '../components/common';
import ChangelogButton from '../components/ChangelogPanel';
import { ConfirmPopover, useConfirmPopover } from '../components/ConfirmPopover';
import { Spinner, safe } from '../components/ShellKit';
import ShellRules from '../components/ShellRules';

const MENU_CSS = `
@keyframes shell-drift-a { 0% { transform: translate(0,0) scale(1); } 50% { transform: translate(6%, 4%) scale(1.15); } 100% { transform: translate(-3%, 8%) scale(1.05); } }
@keyframes shell-drift-b { 0% { transform: translate(0,0) scale(1.1); } 50% { transform: translate(-8%, -3%) scale(0.95); } 100% { transform: translate(-2%, -9%) scale(1.12); } }
@keyframes shell-ember { 0% { transform: translate3d(0, 0, 0); opacity: 0; } 12% { opacity: .9; } 80% { opacity: .5; } 100% { transform: translate3d(var(--dx), -105vh, 0); opacity: 0; } }
@keyframes shell-shimmer { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
@keyframes shell-river { 0%, 100% { opacity: .35; } 50% { opacity: .6; } }
@keyframes shell-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
.shell-rise { animation: shell-rise .6s cubic-bezier(.2,.8,.2,1) both; }
.shell-title-grad {
  background: linear-gradient(90deg, #ff5a3c, #e5b24d, #fff1c9, #e5b24d, #ff5a3c);
  background-size: 200% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: shell-shimmer 7s linear infinite;
  filter: drop-shadow(0 0 24px rgba(226, 82, 59, .45));
}
`;

/** 确定性伪随机（避免每次渲染粒子跳动） */
function h(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function Embers() {
  const embers = useMemo(
    () =>
      Array.from({ length: 30 }, (_, i) => ({
        left: h(i, 1) * 100,
        size: 2 + h(i, 2) * 3,
        delay: -h(i, 3) * 14,
        dur: 9 + h(i, 4) * 9,
        dx: `${(h(i, 5) - 0.5) * 120}px`,
        gold: h(i, 6) > 0.45,
      })),
    [],
  );
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {embers.map((e, i) => (
        <span
          key={i}
          className="absolute bottom-[-10px] rounded-full"
          style={{
            left: `${e.left}%`,
            width: e.size,
            height: e.size,
            background: e.gold ? '#f3c76a' : '#ff6a4a',
            boxShadow: `0 0 ${e.size * 3}px ${e.gold ? 'rgba(243,199,106,.8)' : 'rgba(255,106,74,.8)'}`,
            animation: `shell-ember ${e.dur}s linear ${e.delay}s infinite`,
            ['--dx' as string]: e.dx,
          }}
        />
      ))}
    </div>
  );
}

/** 抽象「小地图」徽记：天辉左下、夜魇右上、河道斜穿 */
function MinimapEmblem({ size = 92 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="drop-shadow-[0_0_18px_rgba(226,82,59,0.35)]">
      <defs>
        <radialGradient id="mm-rad" cx="18%" cy="82%" r="45%">
          <stop offset="0%" stopColor="#63c24f" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#63c24f" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mm-dire" cx="82%" cy="18%" r="45%">
          <stop offset="0%" stopColor="#e2523b" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#e2523b" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="mm-border" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e5b24d" />
          <stop offset="100%" stopColor="#c23c2a" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="92" height="92" rx="16" fill="#0d121b" stroke="url(#mm-border)" strokeWidth="2.5" />
      <rect x="4" y="4" width="92" height="92" rx="16" fill="url(#mm-rad)" />
      <rect x="4" y="4" width="92" height="92" rx="16" fill="url(#mm-dire)" />
      {/* 三路 */}
      <path d="M20 80 L20 20 L80 20 M20 80 L80 80 L80 20 M20 80 L80 20" fill="none" stroke="#e7eaf1" strokeOpacity="0.28" strokeWidth="2.2" strokeLinecap="round" />
      {/* 河道 */}
      <path d="M7 34 C 34 40, 60 62, 66 93" fill="none" stroke="#4ea1ff" strokeOpacity="0.75" strokeWidth="4" strokeLinecap="round" style={{ animation: 'shell-river 4s ease-in-out infinite' }} />
      {/* 基地 */}
      <rect x="13" y="73" width="14" height="14" rx="3" fill="#63c24f" />
      <rect x="73" y="13" width="14" height="14" rx="3" fill="#e2523b" />
      {/* 中路交锋点 */}
      <circle cx="50" cy="50" r="4" fill="#e5b24d" />
    </svg>
  );
}

function MenuButton({
  label,
  desc,
  onClick,
  disabled,
  title,
  primary,
  icon,
  delay,
}: {
  label: string;
  desc?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  icon: string;
  delay: number;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ animationDelay: `${delay}ms` }}
      className={cx(
        'shell-rise group relative flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg border px-4 py-3 text-left transition-all',
        'disabled:cursor-not-allowed disabled:opacity-40',
        primary
          ? 'border-dota-2/60 bg-gradient-to-r from-dota/90 to-dota-2/70 text-white shadow-lg shadow-dota/30 enabled:hover:from-dota enabled:hover:to-dota-2'
          : 'border-line bg-panel/80 text-ink backdrop-blur enabled:hover:border-gold/50 enabled:hover:bg-panel-2',
      )}
    >
      <span
        className={cx(
          'absolute inset-y-0 left-0 w-1 transition-all',
          primary ? 'bg-gold' : 'bg-dota/0 group-enabled:group-hover:bg-gold',
        )}
      />
      <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-md text-base', primary ? 'bg-black/25' : 'bg-panel-3 text-gold')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold tracking-wide">{label}</span>
        {desc && <span className={cx('block truncate text-xs', primary ? 'text-white/75' : 'text-mute')}>{desc}</span>}
      </span>
      <span className={cx('text-lg opacity-0 transition-all group-enabled:group-hover:translate-x-0.5 group-enabled:group-hover:opacity-100', primary ? 'text-white' : 'text-gold')}>›</span>
    </button>
  );
}

function roundText(round: number, total: number): string {
  if (round === 0) return '赛季初';
  if (total && round >= total - 1) return 'TI 正赛';
  if (total && round === total - 2) return 'TI 预选';
  return `第 ${round} 回合`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 当前会话进度卡片 */
function ProgressCard({ meta, onContinue, busy }: { meta: ProgressMeta; onContinue: () => void; busy: boolean }) {
  return (
    <div className="shell-rise overflow-hidden rounded-xl border border-gold/40 bg-panel/90 shadow-xl shadow-black/30 backdrop-blur" style={{ animationDelay: '60ms' }}>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3" style={{ background: `linear-gradient(90deg, ${meta.teamColor}33, transparent 70%)` }}>
        <div
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-xs font-black text-white ring-1 ring-black/40"
          style={{ background: `linear-gradient(135deg, ${meta.teamColor}, ${meta.teamColor}88)` }}
        >
          {meta.teamTag.slice(0, 4)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-bold">{meta.teamName}</div>
          <div className="text-xs text-mute">经理 {meta.managerName} · 生涯 TI{meta.startTi} → TI{meta.endTi}</div>
        </div>
        {meta.gameOver && <span className="rounded bg-panel-3 px-2 py-0.5 text-[11px] text-mute">已结束</span>}
      </div>
      <div className="grid grid-cols-3 gap-2 px-4 py-3 text-center">
        <div>
          <div className="text-[10px] text-faint">赛季</div>
          <div className="text-sm font-semibold">TI{meta.ti} · {roundText(meta.round, meta.totalRounds)}</div>
        </div>
        <div>
          <div className="text-[10px] text-faint">荣誉</div>
          <div className="text-sm font-semibold tabular">{meta.honor}</div>
        </div>
        <div>
          <div className="text-[10px] text-faint">金币</div>
          <div className={cx('text-sm font-semibold tabular', meta.gold < 0 ? 'text-bad' : 'text-gold')}>{formatGold(meta.gold)}</div>
        </div>
      </div>
      <div className="px-4 pb-4">
        <Button variant="primary" size="lg" className="w-full" onClick={onContinue} disabled={busy}>
          {busy ? '正在读取…' : '继续游戏 ▶'}
        </Button>
        <div className="mt-2 text-center text-[11px] text-faint">上次保存：{timeAgo(meta.savedAt)}</div>
      </div>
    </div>
  );
}

export default function MainMenu() {
  const setScreen = useGameStore((s) => s.setScreen);
  const continueGame = useGameStore((s) => s.continueGame);
  const importJson = useGameStore((s) => s.importJson);
  const progress = useGameStore((s) => s.progress);
  const busy = useGameStore((s) => s.busy);
  const refreshProgress = useGameStore((s) => s.refreshProgress);
  const openLobby = useGameStore((s) => s.mpOpenLobby);
  const [rulesOpen, setRulesOpen] = useState(false);
  // 新建会覆盖当前进度：在按钮旁就近确认
  const confirmNew = useConfirmPopover<HTMLDivElement>();
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const session = getSession();
  const tis = safe(() => availableStartTis(), [] as number[]);

  useEffect(() => refreshProgress(), [refreshProgress]);

  const startNew = () => {
    if (progress && !progress.gameOver) confirmNew.ask();
    else setScreen('newgame');
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      importJson(text);
    } catch (err) {
      useGameStore.getState().toast(`读取文件失败：${(err as Error).message}`, false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <style>{MENU_CSS}</style>

      {/* ---------- 背景 ---------- */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute -left-[15%] -top-[25%] h-[75vh] w-[75vh] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(194,60,42,0.38), transparent 65%)', animation: 'shell-drift-a 22s ease-in-out infinite alternate' }}
        />
        <div
          className="absolute -bottom-[30%] -right-[10%] h-[80vh] w-[80vh] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(229,178,77,0.18), transparent 65%)', animation: 'shell-drift-b 26s ease-in-out infinite alternate' }}
        />
        {/* 斜向河道光带 */}
        <div
          className="absolute left-1/2 top-1/2 h-[180vh] w-40 -translate-x-1/2 -translate-y-1/2 rotate-[-38deg] blur-3xl"
          style={{ background: 'linear-gradient(180deg, transparent, rgba(78,161,255,0.12), transparent)', animation: 'shell-river 9s ease-in-out infinite' }}
        />
        {/* 网格纹理 */}
        <div
          className="absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage: 'linear-gradient(#e7eaf1 1px, transparent 1px), linear-gradient(90deg, #e7eaf1 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
          }}
        />
        <Embers />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-bg/90" />
      </div>

      {/* ---------- 内容 ---------- */}
      <div className="relative z-10 flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        {/* 窄屏单列也用 minmax(0,1fr)：截断显示的长说明不会按自身宽度把列撑出屏幕 */}
        <div className="grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] items-center gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* 标题 */}
          <div className="shell-rise text-center lg:text-left">
            <div className="mb-5 flex justify-center lg:justify-start">
              <MinimapEmblem />
            </div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.55em] text-gold/80">Esports Manager Simulation</div>
            <h1 className="mt-2 select-none leading-none">
              <span className="shell-title-grad block text-7xl font-black italic tracking-[0.12em] md:text-8xl">刀塔</span>
              <span className="mt-1 inline-flex items-center gap-3">
                <span className="text-5xl font-black tracking-[0.25em] text-ink md:text-6xl">经理</span>
                <span className="hidden h-[3px] w-24 rounded bg-gradient-to-r from-gold to-transparent md:block" />
              </span>
            </h1>
            <p className="mx-auto mt-5 max-w-md text-sm leading-relaxed text-mute lg:mx-0">
              接管真实豪门俱乐部，亦或白手起家打造护国之翼。训练、转会、新秀、BP 博弈、文字直播——
              <span className="text-ink">让你的战队捧起不朽盾！</span>
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2 text-[11px] lg:justify-start">
              {['真实历届阵容', '版本按回合更新', '每回合随机事件', '无厘头趣事', '队长模式 BP'].map((t) => (
                <span key={t} className="rounded-full border border-line bg-panel/70 px-2.5 py-1 text-mute backdrop-blur">
                  {t}
                </span>
              ))}
            </div>
          </div>

          {/* 入口：继续 / 新建 */}
          <div className="mx-auto w-full max-w-sm space-y-3">
            <div className="shell-rise flex items-center justify-between rounded-lg border border-line bg-panel/70 px-3 py-2 text-xs backdrop-blur">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-good" />
                <span className="text-ink">{session.name}</span>
                <span className="text-faint">匿名会话</span>
              </span>
              <span className="text-faint" title="登录同步即将推出；当前进度保存在本浏览器">本地保存</span>
            </div>
            {progress ? (
              <ProgressCard meta={progress} onContinue={() => void continueGame()} busy={busy} />
            ) : (
              <div className="shell-rise rounded-xl border border-line bg-panel/70 px-4 py-4 text-center text-sm text-mute backdrop-blur" style={{ animationDelay: '60ms' }}>
                当前会话还没有游戏进度
              </div>
            )}
            <div ref={confirmNew.anchorRef}>
              <MenuButton
                icon="✦"
                label="新建游戏"
                primary={!progress}
                desc={
                  progress && !progress.gameOver
                    ? '会覆盖当前会话的进度'
                    : tis.length
                      ? `可选起点 TI${tis[0]}${tis.length > 1 ? ` – TI${tis[tis.length - 1]}` : ''}`
                      : '阵容数据加载中 / 暂无阵容数据'
                }
                onClick={startNew}
                delay={150}
              />
            </div>
            <ConfirmPopover
              open={confirmNew.open}
              anchorRef={confirmNew.anchorRef}
              spec={{
                title: '新建游戏',
                danger: true,
                confirmLabel: '确定新建',
                message: (
                  <>
                    当前会话已有进度（<span className="text-ink">{progress?.teamName}</span> · TI{progress?.ti}），新游戏会
                    <span className="text-bad">覆盖</span>这份进度。如需保留，请先继续游戏并在「存档」中导出存档文件。
                  </>
                ),
              }}
              onConfirm={() => {
                confirmNew.close();
                setScreen('newgame');
              }}
              onCancel={confirmNew.close}
            />
            <MenuButton
              icon="⚔"
              label="多人对战"
              desc="与朋友在线或在局域网同场竞技"
              onClick={openLobby}
              delay={185}
            />
            <div className="grid grid-cols-2 gap-2.5">
              <MenuButton
                icon="⇪"
                label={importing ? '导入中…' : '导入存档'}
                disabled={importing}
                onClick={() => fileRef.current?.click()}
                delay={220}
              />
              <MenuButton icon="?" label="玩法说明" onClick={() => setRulesOpen(true)} delay={260} />
            </div>
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
            {importing && (
              <div className="flex items-center gap-2 px-1 text-xs text-mute">
                <Spinner /> 正在读取存档文件…
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="relative z-10 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 bg-bg/60 px-6 py-2.5 text-[11px] text-faint backdrop-blur">
        {/* 版本号即「更新说明」入口（与游戏内顶栏的版本芯片打开同一个面板；有未读新版本时带红点） */}
        <span>
          <ChangelogButton variant="footer" /> · 粉丝自制的 Dota 2 电竞经理模拟游戏，与 Valve Corporation 无关
        </span>
        <span>历届阵容与赛事基于公开资料整理，部分未来赛季为推演数据</span>
      </footer>

      {/* ---------- 玩法说明 ---------- */}
      <Modal
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        title="玩法说明"
        width="max-w-4xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRulesOpen(false)}>
              关闭
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setRulesOpen(false);
                setScreen('newgame');
              }}
            >
              开始新游戏 ▶
            </Button>
          </>
        }
      >
        <ShellRules />
      </Modal>
    </div>
  );
}

// ============================================================================
// 多人对战（局域网）通用小组件：连接状态、复制按钮、输入框样式、玩家状态点等
// ============================================================================
import { useEffect, useState, type ReactNode } from 'react';
import type { NetState } from '../../store/net';
import { useGameStore } from '../../store/gameStore';
import type { MpMode, RoomSettings } from '../../shared/protocol';
import { Button, cx } from './common';
import { DIFFICULTY_LABEL } from './ShellKit';

/** 输入框样式（与新游戏向导一致） */
export const mpInputBase =
  'rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-gold/60 focus:bg-panel-3 disabled:cursor-not-allowed disabled:opacity-50';
export const mpInputCls = cx('w-full', mpInputBase);

/** 俱乐部主色候选 */
export const MP_SWATCHES = ['#c23c2a', '#e5b24d', '#3d8bfd', '#4cc38a', '#a970ff', '#ff9f1a', '#ff4d6d', '#22c3c3', '#e7eaf1', '#8a5a2b', '#5b6bff', '#2f2f3a'];

export const MP_MODE_LABEL: Record<MpMode, string> = { build: '各自组建战队', existing: '选择已有战队' };

/** 玩法规则说明 */
export const MP_MODE_RULE: Record<MpMode, string> = {
  build: '每位玩家填写俱乐部名称、简称、赛区与颜色，以新俱乐部身份开局（与单机新建俱乐部规则相同，相对公平）。',
  existing:
    '每位玩家从起始 TI 的真实战队中挑选一支（不可重复）。被选中战队的现役选手属性全部重置为组建战队时的水平，只保留选手的姓名、ID 与天赋；俱乐部荣誉与资金同样重置为新俱乐部标准，保证公平。',
};

/** 房间设置摘要：TI3 → TI16 · 普通 · 各自组建战队 */
export function settingsSummary(s: RoomSettings | undefined | null): string {
  if (!s) return '';
  return `TI${s.startTi} → TI${s.endTi} · ${DIFFICULTY_LABEL[s.difficulty] ?? s.difficulty} · ${MP_MODE_LABEL[s.mode] ?? s.mode}`;
}

/** 复制到剪贴板（局域网 http 页面没有 navigator.clipboard 时降级为 execCommand） */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = '复制', title, size = 'xs' }: { text: string; label?: ReactNode; title?: string; size?: 'xs' | 'sm' }) {
  const toast = useGameStore((s) => s.toast);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Button
      size={size}
      variant="ghost"
      title={title ?? `复制：${text}`}
      onClick={() =>
        void copyText(text).then((ok) => {
          if (ok) setDone(true);
          else toast(`复制失败，请手动复制：${text}`, false);
        })
      }
    >
      {done ? '✓ 已复制' : label}
    </Button>
  );
}

/** 在线 / 离线圆点 */
export function OnlineDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      className={cx('inline-block h-2 w-2 shrink-0 rounded-full', online ? 'bg-good shadow-[0_0_6px_rgba(76,195,138,0.7)]' : 'bg-faint', className)}
      title={online ? '在线' : '离线'}
    />
  );
}

/** 每秒刷新一次（倒计时显示用） */
export function useTicker(active: boolean, ms = 1000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return n;
}

/** 连接状态文字 */
export function netStatusText(net: NetState): { text: string; tone: 'good' | 'gold' | 'bad' | 'mute' } {
  switch (net.status) {
    case 'open':
      return { text: '已连接', tone: 'good' };
    case 'connecting':
      return { text: '正在连接…', tone: 'gold' };
    case 'reconnecting': {
      const secs = net.retryAt ? Math.max(0, Math.ceil((net.retryAt - Date.now()) / 1000)) : 0;
      return { text: secs > 0 ? `连接中断，${secs} 秒后第 ${net.attempt} 次重连…` : `正在第 ${net.attempt} 次重连…`, tone: 'bad' };
    }
    case 'closed':
      return { text: '未连接', tone: 'mute' };
    default:
      return { text: '未连接', tone: 'mute' };
  }
}

/** 连接状态徽标 */
export function ConnBadge({ net, className }: { net: NetState; className?: string }) {
  useTicker(net.status === 'reconnecting');
  const s = netStatusText(net);
  const dot = s.tone === 'good' ? 'bg-good' : s.tone === 'gold' ? 'bg-gold animate-pulse' : s.tone === 'bad' ? 'bg-bad animate-pulse' : 'bg-faint';
  const text = s.tone === 'good' ? 'text-good' : s.tone === 'gold' ? 'text-gold' : s.tone === 'bad' ? 'text-bad' : 'text-mute';
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs', className)} title={net.error ?? undefined}>
      <span className={cx('h-2 w-2 shrink-0 rounded-full', dot)} />
      <span className={text}>{s.text}</span>
    </span>
  );
}

/** 迷你字段标题 */
export function MpField({ label, hint, error, children }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-mute">{label}</div>
      {children}
      {error ? <div className="mt-1 text-[11px] text-bad">{error}</div> : hint ? <div className="mt-1 text-[11px] text-faint">{hint}</div> : null}
    </label>
  );
}

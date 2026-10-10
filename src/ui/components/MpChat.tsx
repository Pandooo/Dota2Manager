// ============================================================================
// 多人房间聊天：消息列表 + 输入框（房间页内嵌；游戏中由顶栏按钮弹出）
// ============================================================================
import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { Button, cx } from './common';
import { mpInputBase } from './MpKit';

const MAX_LEN = 200;

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function MpChat({ className, height = 'h-64', autoFocus }: { className?: string; height?: string; autoFocus?: boolean }) {
  const chat = useGameStore((s) => s.mp.chat);
  const myName = useGameStore((s) => s.mp.playerName);
  const connected = useGameStore((s) => s.mp.net.status === 'open');
  const send = useGameStore((s) => s.mpSend);
  const markRead = useGameStore((s) => s.mpMarkChatRead);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // 打开 / 有新消息时标为已读并滚到底部
  useEffect(() => {
    markRead();
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, markRead]);

  const submit = () => {
    const t = text.trim().slice(0, MAX_LEN);
    if (!t) return;
    if (send({ t: 'chat', text: t })) setText('');
  };

  return (
    <div className={cx('flex flex-col', className)}>
      <div ref={listRef} className={cx('min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 text-sm', height)}>
        {chat.length === 0 ? (
          <div className="py-6 text-center text-xs text-faint">还没有消息，打个招呼吧</div>
        ) : (
          chat.map((m) => {
            const mine = m.from === myName;
            return (
              <div key={m.id} className="leading-snug">
                <span className={cx('mr-1.5 text-xs font-semibold', mine ? 'text-gold' : 'text-info')}>{m.from}</span>
                <span className="mr-1.5 text-[10px] tabular text-faint">{timeOf(m.at)}</span>
                <span className="whitespace-pre-wrap break-words text-ink/90">{m.text}</span>
              </div>
            );
          })
        )}
      </div>
      <div className="flex gap-2 border-t border-line p-2">
        <input
          className={cx(mpInputBase, 'min-w-0 flex-1 py-1.5 text-xs')}
          value={text}
          maxLength={MAX_LEN}
          autoFocus={autoFocus}
          disabled={!connected}
          placeholder={connected ? '输入消息，回车发送' : '未连接'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button size="sm" variant="secondary" onClick={submit} disabled={!connected || !text.trim()}>
          发送
        </Button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { getSaveStatus, getSession, onSaveStatus, saveProgressNow, type SaveStatus } from '../../store/session';
import { Button, cx } from '../components/common';
import { downloadText, saveFileName } from '../components/ShellKit';

function statusText(s: SaveStatus): string {
  if (s.state === 'saving') return '正在保存…';
  if (s.state === 'error') return '保存失败（浏览器存储不可用），建议导出存档文件';
  if (s.state === 'saved' && s.at) return `已自动保存 · ${new Date(s.at).toLocaleTimeString('zh-CN', { hour12: false })}`;
  return '进度会在每次操作后自动保存';
}

export function useSaveStatus(): SaveStatus {
  const [s, setS] = useState<SaveStatus>(getSaveStatus());
  useEffect(() => onSaveStatus(setS), []);
  return s;
}

/** 会话与存档：进度自动保存到当前会话；可导出/导入存档文件、返回主菜单 */
export default function SaveMenu({ onDone }: { onDone: () => void }) {
  const exportJson = useGameStore((s) => s.exportJson);
  const importJson = useGameStore((s) => s.importJson);
  const quit = useGameStore((s) => s.quitToMenu);
  const status = useSaveStatus();
  const session = getSession();
  const fileRef = useRef<HTMLInputElement>(null);

  // 与生涯总结的「导出存档」同一写法：链接挂到页面上再点击、延迟释放（立即释放会让 iOS Safari 取消下载），文件名带战队简称与时间
  const download = () => {
    const { game, toast } = useGameStore.getState();
    const json = exportJson();
    if (!json || !game) {
      toast('导出失败：没有进行中的游戏', false);
      return;
    }
    downloadText(json, saveFileName(game.teams[game.settings.playerTeamId]?.tag));
    toast('存档已导出');
  };

  const saveNow = () => {
    const g = useGameStore.getState().game;
    if (g) void saveProgressNow(g).then((ok) => useGameStore.getState().toast(ok ? '已保存到当前会话' : '保存失败', ok));
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (importJson(await file.text())) onDone();
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-panel-2 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold">{session.name}</div>
            <div className="text-xs text-mute">匿名会话 · 进度保存在本浏览器（登录同步功能即将推出）</div>
          </div>
          <span className="rounded bg-panel-3 px-2 py-0.5 text-[11px] text-faint">ID {session.id.slice(0, 8)}</span>
        </div>
        <div className={cx('mt-2 text-xs', status.state === 'error' ? 'text-bad' : status.state === 'saved' ? 'text-good' : 'text-mute')}>
          ● {statusText(status)}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={saveNow}>立即保存</Button>
        <Button onClick={download}>导出存档文件</Button>
        <Button onClick={() => fileRef.current?.click()}>导入存档文件</Button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
      </div>
      <div className="border-t border-line pt-3">
        <Button variant="danger" onClick={() => { onDone(); quit(); }}>
          返回主菜单（进度已保存）
        </Button>
      </div>
    </div>
  );
}

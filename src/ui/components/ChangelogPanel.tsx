// 更新说明：顶栏右上角的版本芯片（有未读新版本时带红点）→ 点击打开面板，按版本倒序列出每次更新的内容，
// 当前版本默认展开、旧版本折叠可展开；标有 New 的条目在游戏内对应入口旁也有徽标。
// 入口有两处，打开的是同一个面板：游戏内顶栏的芯片（variant="chip"，< sm 显示为「更新」），主菜单页脚的版本号（variant="footer"）。
// 手机（< sm）顶栏放不下芯片：改为导航抽屉底部的「更新说明」一行（TopBar 渲染 ChangelogModal），有未读时 ☰ 带蓝点。
// 「标为已读」把最新版本记为已读：红点与全部 New 徽标一起消失。打开面板不自动算已读（理由见 src/ui/changelog.ts 文件头）。
// 数据与状态见 src/ui/changelog.ts；状态按浏览器存 localStorage，不进存档、不经 call()。
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { APP_VERSION, CHANGELOG, LATEST_VERSION, changelogStore, featureIsNew, featureOf, hasUnread, versionIsNew, type ChangelogVersion } from '../changelog';
import { Button, Modal, cx } from './common';
import { NewBadgeMark, useChangelogState } from './NewBadge';

export default function ChangelogButton({ variant = 'chip', className }: { variant?: 'chip' | 'footer'; className?: string }) {
  const state = useChangelogState();
  const unread = hasUnread(state.seen);
  const [open, setOpen] = useState(false);
  const title = unread ? `更新说明：v${APP_VERSION} 有新内容（点击查看）` : `更新说明：当前 v${APP_VERSION}（点击查看各版本更新内容）`;
  const dot = unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-dota" aria-hidden />;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={unread ? `更新说明（v${APP_VERSION}，有未读）` : `更新说明（v${APP_VERSION}）`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cx(
          variant === 'footer'
            ? // 主菜单页脚：与页脚文字同字号，悬停变金色并出现下划线
              'inline-flex cursor-pointer items-center gap-1 rounded underline-offset-2 transition-colors hover:text-gold hover:underline'
            : 'inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1 py-1 text-[11px] leading-4 tabular transition-colors sm:px-1.5',
          variant === 'chip' &&
            (open ? 'border-gold/50 text-gold' : unread ? 'border-transparent text-ink hover:bg-panel-2' : 'border-transparent text-faint hover:bg-panel-2 hover:text-mute'),
          variant === 'footer' && (unread ? 'text-mute' : 'text-faint'),
          className,
        )}
      >
        {dot}
        {variant === 'chip' ? (
          <>
            {/* 窄屏显示「更新」二字（比版本号短，也更好懂）；≥ sm 显示版本号 */}
            <span className="hidden font-mono sm:inline">v{APP_VERSION}</span>
            <span className="sm:hidden">更新</span>
          </>
        ) : (
          <>v{APP_VERSION}</>
        )}
      </button>
      {/* 弹窗 portal 到 body：header 的 backdrop-filter 会成为 fixed 定位的包含块 */}
      {open && createPortal(<ChangelogModal onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/** 更新说明面板（Modal）。顶栏 / 主菜单的按钮自带；手机导航抽屉里的入口由 TopBar 直接打开（抽屉收起后按钮已卸载，面板不能挂在按钮里） */
export function ChangelogModal({ onClose }: { onClose: () => void }) {
  const state = useChangelogState();
  const unread = hasUnread(state.seen);
  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex flex-wrap items-center gap-2">
          更新说明
          <span className="font-mono text-xs font-normal text-mute">v{APP_VERSION}</span>
        </span>
      }
      width="max-w-lg"
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={!unread}
            title={unread ? `把 v${LATEST_VERSION} 记为已读：右上角的红点与游戏内全部 New 徽标不再显示` : '没有未读的更新'}
            onClick={() => changelogStore.markAllRead()}
          >
            标为已读
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <p className="mb-3 text-xs leading-relaxed text-mute">
        按版本倒序列出每次更新的内容。标有 <NewBadgeMark /> 的条目在游戏内对应入口旁也有徽标，点击 / 看过该入口后消失；「标为已读」一次清掉全部。
        {APP_VERSION !== LATEST_VERSION && <span className="block text-gold">当前程序版本 v{APP_VERSION} 尚未写入更新说明。</span>}
      </p>
      <div className="space-y-2">
        {CHANGELOG.map((v, i) => (
          <VersionBlock key={v.version} v={v} current={i === 0} defaultOpen={i === 0} isNew={versionIsNew(v.version, state.seen)} />
        ))}
      </div>
    </Modal>
  );
}

function VersionBlock({ v, current, defaultOpen, isNew }: { v: ChangelogVersion; current: boolean; defaultOpen: boolean; isNew: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const state = useChangelogState();
  return (
    <section className={cx('rounded-lg border', current ? 'border-gold/30 bg-panel-2/60' : 'border-line bg-panel-2/30')}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-panel-2/80"
        title={open ? '收起' : '展开'}
      >
        <span className="w-3 shrink-0 text-xs text-faint">{open ? '▾' : '▸'}</span>
        <span className="font-mono text-sm font-semibold text-ink">v{v.version}</span>
        <span className="text-xs text-faint tabular">{v.date}</span>
        {current && <span className="rounded border border-gold/40 bg-gold/10 px-1.5 text-[10px] leading-4 text-gold">当前版本</span>}
        {isNew && <span className="ml-auto flex items-center gap-1 text-[11px] text-dota-2"><span className="h-1.5 w-1.5 rounded-full bg-dota" aria-hidden />未读</span>}
        {!isNew && !open && <span className="ml-auto text-[11px] text-faint">{v.items.length} 条</span>}
      </button>
      {open && (
        <ul className="space-y-1.5 border-t border-line/60 px-3 py-2.5">
          {v.items.map((it, j) => {
            const f = it.feature ? featureOf(it.feature) : undefined;
            return (
              <li key={j} className="flex gap-2 text-sm leading-relaxed text-ink">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden />
                <span className="min-w-0">
                  {it.text}
                  {f && (
                    <span className="mt-0.5 block text-xs text-mute">
                      {it.feature && featureIsNew(it.feature, state) && <NewBadgeMark className="mr-1.5" />}
                      入口：{f.label}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// 「New」徽标：新功能入口旁的小号金色描边标签（数据与显示规则见 src/ui/changelog.ts）。
// 接入方式（尽量不改页面逻辑）：
//   <Button onClick=…>挂牌出售 <NewBadge feature="listing" /></Button>      // 默认 dismissOn="click"：点击徽标所在的父元素（按钮 / 标签）后消失
//   <h3>选手奖金分成 <NewBadge feature="prizeShare" dismissOn="view" /></h3>  // 非可点击入口：在屏幕上看到约 1 秒即算「找到了」，离开页面后不再显示
//   const { show, dismiss } = useNewFeature('listing');                         // 需要自定义时机时
//   <button className="relative …">♪ <NewBadge feature="bgm" narrow="corner" /></button>  // 窄屏（< sm）改为父元素右上角的角标，不占行内宽度（顶栏这类寸土寸金的地方）
// 新增一个带徽标的功能：见 docs/UI.md「更新说明与 New 徽标」的接入步骤（FEATURES 加一条 + 放 <NewBadge>）。
// 「更新说明」里的「标为已读」会一次清掉全部徽标。状态按浏览器存 localStorage，不进存档。
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { changelogStore, featureIsNew, featureOf, type ChangelogState, type FeatureKey } from '../changelog';
import { cx } from './common';

/** 更新说明 / 徽标的持久化状态（任何改动都会重渲染） */
export function useChangelogState(): ChangelogState {
  return useSyncExternalStore(changelogStore.subscribe, changelogStore.getSnapshot, changelogStore.getSnapshot);
}

/** 某功能是否应显示 New 徽标，以及关闭它的回调 */
export function useNewFeature(key: FeatureKey): { show: boolean; dismiss: () => void } {
  const state = useChangelogState();
  const dismiss = useCallback(() => changelogStore.dismiss(key), [key]);
  return { show: featureIsNew(key, state), dismiss };
}

/** 在屏幕上连续可见多久算「看过」 */
const VIEW_MS = 1200;

/** 徽标外观（面板里的静态示例也用它） */
export function NewBadgeMark({ className, title }: { className?: string; title?: string }) {
  return (
    <span
      title={title}
      aria-label="新功能"
      className={cx(
        // 深色底 + 金色描边：放在金色按钮（如「挂牌出售」）里也能看清
        'inline-flex shrink-0 items-center rounded border border-gold/70 bg-panel px-1 align-middle text-[9px] font-bold leading-[14px] tracking-wide text-gold',
        className,
      )}
    >
      New
    </span>
  );
}

export default function NewBadge({
  feature,
  dismissOn = 'click',
  narrow = 'inline',
  className,
}: {
  feature: FeatureKey;
  /** click：点击徽标的父元素后消失（默认）；view：在屏幕上看到约 1 秒并离开后消失；none：只由「标为已读」或 useNewFeature().dismiss 控制 */
  dismissOn?: 'click' | 'view' | 'none';
  /** 窄屏（< sm）时的摆放：inline（默认，与 ≥ sm 相同）；corner：贴在父元素右上角、不占行内宽度（父元素需 relative） */
  narrow?: 'inline' | 'corner';
  className?: string;
}) {
  const { show, dismiss } = useNewFeature(feature);
  const ref = useRef<HTMLSpanElement>(null);

  // click：监听父元素（按钮 / 标签）的点击
  useEffect(() => {
    if (!show || dismissOn !== 'click') return;
    const el = ref.current?.parentElement;
    if (!el) return;
    el.addEventListener('click', dismiss);
    return () => el.removeEventListener('click', dismiss);
  }, [show, dismissOn, dismiss]);

  // view：连续可见 VIEW_MS 后记为「看过」，离开（卸载 / 关闭页面）时关闭徽标。
  // 不在看到的当下就关闭：同一功能在别处的徽标会立刻消失，而当前这枚也会在玩家眼前闪没；StrictMode 的开发期双重挂载不会计时。
  useEffect(() => {
    if (!show || dismissOn !== 'view') return;
    const el = ref.current;
    if (!el) return;
    let viewed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const start = () => {
      if (viewed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        viewed = true;
      }, VIEW_MS);
    };
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const onHide = () => {
      if (viewed) dismiss();
    };
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) (e.isIntersecting ? start : stop)();
      });
      io.observe(el);
    } else {
      start();
    }
    window.addEventListener('pagehide', onHide);
    return () => {
      stop();
      io?.disconnect();
      window.removeEventListener('pagehide', onHide);
      onHide();
    };
  }, [show, dismissOn, dismiss]);

  if (!show) return null;
  const f = featureOf(feature);
  const title = `新功能（v${f?.version ?? ''}）：${f?.label ?? feature}。${
    dismissOn === 'click' ? '点击该入口后不再显示' : '看过后不再显示'
  }；也可在右上角「更新说明」中标为已读。`;
  return (
    <span
      ref={ref}
      className={cx(
        'inline-flex align-middle',
        narrow === 'corner' && 'absolute -right-1.5 -top-2 z-10 sm:static sm:z-auto',
      )}
    >
      <NewBadgeMark className={className} title={title} />
    </span>
  );
}

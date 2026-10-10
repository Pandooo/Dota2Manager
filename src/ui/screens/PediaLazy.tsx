// DotaPedia 中心页的按需加载入口：百科页面（约 100 KB）单独成块，第一次打开时才下载，主包保持在分包上限以内。
// 弹窗里的「DotaPedia ›」入口与词条导航（PediaKit / PediaNav）很小，仍在主包中。
import { Suspense, lazy } from 'react';

const PediaHub = lazy(() => import('./PediaHub'));

export default function PediaView() {
  return (
    <Suspense fallback={<div className="py-16 text-center text-sm text-mute">正在载入 DotaPedia…</div>}>
      <PediaHub />
    </Suspense>
  );
}

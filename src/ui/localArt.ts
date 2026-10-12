// ============================================================================
// 本地美术覆盖（第十波 #4 / #7）：用户可在 git 忽略的 public/local/ 中放入自己的图片
// - public/local/logos/{战队 id}.png|svg|webp：队标（覆盖界面生成的风格化队徽；可用「{战队 id}.{简称}」为某个品牌时期单独指定）
// - public/local/aegis.png|svg|webp：冠军盾（覆盖 TI 转场与顶栏的原创矢量冠军盾）
// 文件列表由 Vite 在开发服务器启动 / 构建时用 import.meta.glob 枚举（只取文件名，不导入内容），运行时不做任何探测请求：
// 没有放文件就完全不会发请求，也不会在控制台留下 404。新增文件后重新运行 npm run dev / npm run build（或 npm run mp）即可。
// 仓库只提交 public/local/README.txt（使用说明）；真实队标与官方冠军盾图片属于商标 / 版权美术，不得提交。
// ============================================================================
import { localLogoKeys } from './emblem';

// 只用到键（文件路径）：值是懒加载函数，从不调用
const LOGO_FILES = import.meta.glob('/public/local/logos/*.{png,svg,webp,PNG,SVG,WEBP}', { query: '?url', import: 'default' });
const AEGIS_FILES = import.meta.glob('/public/local/aegis.{png,svg,webp,PNG,SVG,WEBP}', { query: '?url', import: 'default' });

/** 扩展名优先级（同名多个文件时）：svg > webp > png */
const EXT_RANK: Record<string, number> = { svg: 0, webp: 1, png: 2 };

function publicUrl(path: string): string {
  // '/public/local/logos/og.png' → '<BASE_URL>local/logos/og.png'（public/ 下的文件按原路径托管在站点根目录）
  const rel = path.replace(/^\/?public\//, '');
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  return base + rel.split('/').map(encodeURIComponent).join('/');
}

function buildLogoIndex(): Map<string, string> {
  const best = new Map<string, { url: string; rank: number }>();
  for (const path of Object.keys(LOGO_FILES)) {
    const file = path.split('/').pop() ?? '';
    const m = /^(.+)\.([a-z]+)$/i.exec(file);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const rank = EXT_RANK[m[2].toLowerCase()] ?? 9;
    const cur = best.get(key);
    if (!cur || rank < cur.rank) best.set(key, { url: publicUrl(path), rank });
  }
  return new Map([...best].map(([k, v]) => [k, v.url]));
}

const LOGO_INDEX = buildLogoIndex();

/** 是否放了任何本地队标（没有时界面无需解析战队 id） */
export const HAS_LOCAL_LOGOS = LOGO_INDEX.size > 0;

/** 战队的本地队标地址：先找「{id}.{简称}」（某个品牌时期专用），再找「{id}」；没有返回 null */
export function localLogoUrl(teamId: string | null | undefined, tag?: string | null): string | null {
  if (!HAS_LOCAL_LOGOS) return null;
  for (const k of localLogoKeys(teamId, tag)) {
    const url = LOGO_INDEX.get(k);
    if (url) return url;
  }
  return null;
}

const AEGIS_URL: string | null = (() => {
  let best: { url: string; rank: number } | null = null;
  for (const path of Object.keys(AEGIS_FILES)) {
    const ext = (/\.([a-z]+)$/i.exec(path)?.[1] ?? '').toLowerCase();
    const rank = EXT_RANK[ext] ?? 9;
    if (!best || rank < best.rank) best = { url: publicUrl(path), rank };
  }
  return best?.url ?? null;
})();

/** 本地冠军盾图片地址（没有返回 null） */
export function localAegisUrl(): string | null {
  return AEGIS_URL;
}

// 图片损坏 / 加载失败：记下地址，之后回退到生成的图案，不再重复请求
const failed = new Set<string>();

export function markLocalArtFailed(url: string): void {
  failed.add(url);
}

export function isLocalArtFailed(url: string | null | undefined): boolean {
  return !!url && failed.has(url);
}

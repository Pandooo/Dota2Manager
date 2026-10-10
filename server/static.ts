// ============================================================================
// 静态文件服务：托管 vite build 产物（dist/），SPA 回退到 index.html。
// - 只处理 GET/HEAD；路径穿越（..、编码的 ..、空字节）一律 404；
// - 带哈希的 /assets/* 长缓存，index.html 不缓存；
// - 文本类资源按 Accept-Encoding 返回 gzip（内存缓存，按 mtime 失效）。
// ============================================================================
import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const COMPRESSIBLE = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.map', '.txt', '.svg', '.webmanifest']);
const GZIP_MIN = 1024;
const GZIP_CACHE_MAX = 64 * 1024 * 1024;

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface StaticHandler {
  (req: IncomingMessage, res: ServerResponse): void;
  /** dist 目录是否有 index.html */
  readonly hasIndex: () => boolean;
}

const NOT_BUILT_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>刀塔经理 · 服务器</title>
<style>body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#111418;color:#e6e6e6;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:560px;padding:24px}code{background:#22272e;padding:2px 6px;border-radius:4px}</style></head>
<body><main><h1>刀塔经理 · 局域网服务器运行中</h1><p>尚未找到前端构建产物（dist/index.html）。</p><p>请在房主电脑上运行 <code>npm run mp</code>（先构建前端再启动服务器），或先执行 <code>npm run build</code> 后重新启动 <code>npm run server</code>。</p></main></body></html>`;

/** 把 URL 路径解析为 root 内的绝对路径；非法路径返回 null */
export function resolveSafePath(root: string, urlPath: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (p.includes('\0') || p.includes('\\')) return null;
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) return null;
  const abs = resolve(root, `.${normalize(`/${p}`)}`);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
  return abs;
}

function fileStat(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

export function createStaticHandler(rootDir: string): StaticHandler {
  const root = resolve(rootDir);
  const indexPath = join(root, 'index.html');
  const gzCache = new Map<string, { mtimeMs: number; buf: Buffer }>();
  let gzBytes = 0;

  const send = async (req: IncomingMessage, res: ServerResponse, path: string, st: { size: number; mtimeMs: number }, isIndex: boolean) => {
    const ext = extname(path).toLowerCase();
    const headers: Record<string, string | number> = {
      'Content-Type': mimeOf(path),
      'X-Content-Type-Options': 'nosniff',
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    };
    const rel = path.slice(root.length).split(sep).join('/');
    headers['Cache-Control'] = isIndex || ext === '.html'
      ? 'no-cache'
      : rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
    const accept = String(req.headers['accept-encoding'] ?? '');
    if (COMPRESSIBLE.has(ext) && st.size >= GZIP_MIN && /\bgzip\b/.test(accept)) {
      let hit = gzCache.get(path);
      if (!hit || hit.mtimeMs !== st.mtimeMs) {
        const raw = await readFile(path);
        const buf = gzipSync(raw, { level: 6 });
        if (hit) gzBytes -= hit.buf.length;
        hit = { mtimeMs: st.mtimeMs, buf };
        if (gzBytes + buf.length <= GZIP_CACHE_MAX) {
          gzCache.set(path, hit);
          gzBytes += buf.length;
        }
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = hit.buf.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : hit.buf);
      return;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };

  const handler = ((req: IncomingMessage, res: ServerResponse) => {
    const fail = (code: number, text: string) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      res.end(text);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return fail(405, '不支持的请求方法');
    }
    const url = req.url ?? '/';
    const path = resolveSafePath(root, url);
    if (!path) return fail(404, '未找到');
    const run = async () => {
      const st = fileStat(path);
      if (st) return send(req, res, path, st, path === indexPath);
      // SPA 回退：无扩展名的路径（或明确请求 HTML）返回 index.html；带扩展名的静态资源缺失 → 404
      const pathname = url.split('?')[0];
      const wantsHtml = !extname(pathname) || String(req.headers.accept ?? '').includes('text/html');
      if (!wantsHtml) return fail(404, '未找到');
      const ist = fileStat(indexPath);
      if (ist) return send(req, res, indexPath, ist, true);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : NOT_BUILT_HTML);
    };
    run().catch(() => fail(500, '服务器内部错误'));
  }) as StaticHandler;
  Object.defineProperty(handler, 'hasIndex', { value: () => !!fileStat(indexPath) });
  return handler;
}

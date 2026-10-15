// 网络地址工具：本机局域网地址（启动时打印，并在 welcome 中发给局域网内的客户端）；
// 来源地址是否为内网（只有回环 / 私有网段的连接才会收到局域网地址，公网来的连接一律不发）；
// 公网模式下发给客户端的错误文字过滤（不暴露路径、调用栈等内部细节）。
import type { IncomingHttpHeaders } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';

/** 本机局域网 IPv4 地址（非 internal；私有网段优先） */
export function lanAddresses(): string[] {
  const out: string[] = [];
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const addr of ifs[name] ?? []) {
      const fam = addr.family as string | number;
      if ((fam !== 'IPv4' && fam !== 4) || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue; // 链路本地（无 DHCP）
      if (/^198\.1[89]\./.test(addr.address)) continue; // 198.18.0.0/15：代理/加速器的虚拟网卡（TUN fake-ip），局域网内不可达
      if (!out.includes(addr.address)) out.push(addr.address);
    }
  }
  const rank = (ip: string) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * 网页地址 http://host:port；80 端口不写端口号（浏览器地址栏也是这样显示的，如 http://1.2.3.4）。
 * IPv6 地址加方括号。
 */
export function httpOrigin(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return port === 80 ? `http://${h}` : `http://${h}:${port}`;
}

/** 局域网访问地址（http://ip:port；80 端口为 http://ip） */
export function lanUrls(port: number): string[] {
  return lanAddresses().map((ip) => httpOrigin(ip, port));
}

// ---------------------------------------------------------------------------
// 内网来源判断
// ---------------------------------------------------------------------------
function ipv4Octets(ip: string): number[] | null {
  if (!isIPv4(ip)) return null;
  return ip.split('.').map(Number);
}

function privateV4(o: number[]): boolean {
  const [a, b] = o;
  return a === 127 // 127.0.0.0/8 回环
    || a === 10 // 10.0.0.0/8
    || (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12
    || (a === 192 && b === 168) // 192.168.0.0/16
    || (a === 169 && b === 254); // 169.254.0.0/16 链路本地
}

/** IPv6 → 8 个 16 位分组（支持 :: 缩写与末尾内嵌 IPv4 写法）；无效返回 null */
function ipv6Groups(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let s = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    s = `${s.slice(0, s.length - v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const double = s.indexOf('::');
  const head = double >= 0 ? s.slice(0, double) : s;
  const tail = double >= 0 ? s.slice(double + 2) : null;
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  if (fill < 0) return null;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * 是否为回环 / 私有 / 链路本地地址：127/8、10/8、172.16/12、192.168/16、169.254/16、::1、fc00::/7、fe80::/10，
 * 以及上述 IPv4 的 IPv4 映射写法（::ffff:a.b.c.d / ::ffff:7f00:1）。可带方括号、端口与 IPv6 区域标识（%en0）。
 */
export function isPrivateAddress(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let ip = String(raw).trim();
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end < 0) return false;
    ip = ip.slice(1, end);
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const v4 = ipv4Octets(ip);
  if (v4) return privateV4(v4);
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return privateV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]); // IPv4 映射
  }
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80; // fc00::/7、fe80::/10
}

/** 去掉方括号、端口与 IPv6 区域标识后的地址文本 */
function bareAddress(raw: string): string {
  let ip = String(raw).trim();
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end < 0) return '';
    ip = ip.slice(1, end);
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  const zone = ip.indexOf('%');
  return zone >= 0 ? ip.slice(0, zone) : ip;
}

/**
 * 是否为回环地址：127.0.0.0/8、::1，以及 IPv4 映射写法（::ffff:127.x.x.x / ::ffff:7f00:1）。
 * 可带方括号、端口与 IPv6 区域标识。只认回环，不含局域网私有网段（局域网内其他电脑不算「服务器本机」）。
 */
export function isLoopbackAddress(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const ip = bareAddress(raw);
  const v4 = ipv4Octets(ip);
  if (v4) return v4[0] === 127;
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  return g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && g[6] >> 8 === 127; // ::ffff:127.x.x.x
}

/**
 * 请求是否来自服务器本机（GET /api/status 只回答本机，2026-10-15 用户决策）：套接字的对端地址必须是回环地址。
 * 转发头（X-Forwarded-For 等）不能让请求变成「本机」——只会让它变成「非本机」：请求头里声明了任何非回环的转发来源时
 * （本机反向代理转发的外部请求），一律按外部请求处理。直接对外监听时伪造的转发头没有任何作用（套接字地址就不是回环）。
 */
export function isLoopbackRequest(remoteAddress: string | null | undefined, headers: IncomingHttpHeaders = {}): boolean {
  if (!isLoopbackAddress(remoteAddress)) return false;
  return forwardedAddresses(headers).every((a) => isLoopbackAddress(a));
}

/** 请求头中声明的转发来源地址（X-Forwarded-For / X-Real-IP / Forwarded: for=） */
function forwardedAddresses(headers: IncomingHttpHeaders): string[] {
  const out: string[] = [];
  const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);
  for (const v of list(headers['x-forwarded-for'])) out.push(...v.split(','));
  for (const v of list(headers['x-real-ip'])) out.push(v);
  for (const v of list(headers.forwarded)) {
    for (const m of v.matchAll(/for=("?)([^;,"]*)\1/gi)) out.push(m[2]);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 连接是否来自内网：套接字的对端地址必须是回环 / 私有地址，并且请求头里声明的每一个转发来源（如果有）也都是。
 * 只看请求头会被伪造（公网客户端自己写 X-Forwarded-For: 127.0.0.1），只看套接字则在本机反向代理后面时
 * 所有连接都像是回环——两者同时满足才算内网；无法识别的转发来源一律按公网处理。
 */
export function isPrivateOrigin(remoteAddress: string | null | undefined, headers: IncomingHttpHeaders = {}): boolean {
  if (!isPrivateAddress(remoteAddress)) return false;
  return forwardedAddresses(headers).every((a) => isPrivateAddress(a));
}

/**
 * 连接的来源地址（按地址限流 / 限制建房用）：默认取套接字地址（直接对外监听时转发头可被客户端伪造）；
 * trustProxy（服务器在本机反向代理后面）时取 X-Forwarded-For 的第一个地址。IPv4 映射写法（::ffff:a.b.c.d）还原为 IPv4。
 */
export function clientAddress(remoteAddress: string | null | undefined, headers: IncomingHttpHeaders = {}, trustProxy = false): string {
  let ip = String(remoteAddress ?? '').trim();
  if (trustProxy) {
    const xff = headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first && (isIPv4(first) || isIPv6(first))) ip = first;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

// ---------------------------------------------------------------------------
// 公网模式下发给客户端的错误文字
// ---------------------------------------------------------------------------
/** 发给客户端的通用错误文字（公网模式下替换含内部细节的错误） */
export const GENERIC_SERVER_ERROR = '服务器内部错误，请稍后再试';

/**
 * 公网模式：错误信息只在「明显是给玩家看的中文提示」时原样发给客户端；含文件路径、调用栈、系统错误码、
 * URL、多行或不含中文（多为程序内部异常，如 TypeError）的一律替换为通用文字。完整信息只写服务器日志。
 */
export function publicSafeErrorText(message: string): string {
  const text = String(message ?? '').trim();
  if (!text || text.length > 200 || text.includes('\n')) return GENERIC_SERVER_ERROR;
  if (!/[一-鿿]/.test(text)) return GENERIC_SERVER_ERROR;
  if (/(^|[\s'"(（:：=])(?:[A-Za-z]:)?[\\/][^\s'"()（）]*[\\/]/.test(text)) return GENERIC_SERVER_ERROR; // 文件路径
  if (/\bE[A-Z]{3,}:|\bERR_[A-Z_]+\b/.test(text)) return GENERIC_SERVER_ERROR; // ENOENT: / EACCES: / ERR_xxx 等系统错误码
  if (/\bat\s+\S+\s+\(|\bnode:|\bfile:|https?:\/\/|\.(?:ts|js|mjs|cjs|json)\b/i.test(text)) return GENERIC_SERVER_ERROR; // 调用栈 / 内部模块 / URL / 源文件名
  return text;
}

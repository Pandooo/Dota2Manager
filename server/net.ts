// 局域网地址：本机非内部 IPv4（启动时打印，并在 welcome 中发给客户端）
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

/** 局域网访问地址（http://ip:port） */
export function lanUrls(port: number): string[] {
  return lanAddresses().map((ip) => `http://${ip}:${port}`);
}

// ============================================================================
// 刀塔经理 · 多人服务器（命令行入口；局域网或公网）
// 用法：npm run server [-- --port 8686] [--data ./server-data] [--host 0.0.0.0] [--dist ./dist] [--name 房主的电脑]
//                      [--keep-finished-hours 2] [--keep-idle-days 14] [--public] [--trust-proxy] [--stats-interval-min 10]
//       npm run mp   （先 vite build 前端，再启动服务器）
// 局域网：朋友在浏览器打开启动时打印的局域网地址即可加入；公网（--public）：不打印、不下发任何内网地址。
// WebSocket 路径为 /ws；在线统计见 GET /api/status（只回答服务器本机的请求）。
// ============================================================================
import { resolve } from 'node:path';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { DEFAULT_SERVER_PORT, WS_PATH } from '../src/shared/protocol';
import { startServer, type RunningServer } from './app';
import { DEFAULT_FINISHED_ROOM_TTL_MS, DEFAULT_IDLE_ROOM_TTL_MS } from './rooms';
import { DEFAULT_STATS_LOG_INTERVAL_MS } from './stats';

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

const HELP = `刀塔经理 · 多人服务器（局域网 / 公网）

用法：npm run server -- [选项]
  --port <端口>     监听端口（默认 ${DEFAULT_SERVER_PORT}，也可用环境变量 PORT）
  --host <地址>     监听地址（默认 0.0.0.0，局域网内可访问）
  --data <目录>     房间存档目录（默认 ./server-data）
  --dist <目录>     前端构建产物目录（默认 <项目>/dist）
  --name <名称>     服务器名称（默认「刀塔经理服务器」）
  --keep-finished-hours <小时>
                    已结束的对局在所有人离开后保留多久（默认 ${DEFAULT_FINISHED_ROOM_TTL_MS / 3_600_000}，期间可回房间查看结算）
  --keep-idle-days <天>
                    进行中的对局连续多久无人在线后删除（默认 ${DEFAULT_IDLE_ROOM_TTL_MS / 86_400_000}；只计服务器运行时间，0 = 永不删除）
  --public          公网模式（也可用环境变量 D2M_PUBLIC=1）：不向客户端发送、也不在启动信息中列出任何内网地址，
                    发给客户端的错误信息不含内部细节；部署到公网服务器时使用
  --trust-proxy     服务器在本机反向代理（nginx 等）后面时使用（也可用环境变量 D2M_TRUST_PROXY=1）：按 X-Forwarded-For
                    识别来源地址。直接对外监听时不要加（转发头可被客户端伪造）
                    同一公网来源地址的限制：同时最多 16 个连接、每分钟新建 60 个、等待中的房间 3 个、每小时开局 6 局；
                    房间数满时会清理连续 1 小时无人在线的进行中对局（从未推进过的优先）
  --stats-interval-min <分钟>
                    在线统计日志间隔（默认 ${DEFAULT_STATS_LOG_INTERVAL_MS / 60_000}，只在人数有变化时输出；0 = 不输出）。
                    详细统计（只允许服务器本机访问）：curl -s http://127.0.0.1:<端口>/api/status；每日汇总在 <存档目录>/stats/
  --no-save         不保存房间与统计（测试用）
  --help            显示帮助`;

/** 非负数参数（缺省返回 undefined；无效时退出） */
function numberArg(args: Record<string, string | true>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    console.error(`参数 --${key} 无效：${String(v)}（需为非负数）`);
    process.exit(1);
  }
  return n;
}

/** 开关类环境变量：1 / true / yes / on */
function envFlag(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|on)$/i.test(v.trim());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(HELP);
    return;
  }
  const portArg = typeof args.port === 'string' ? args.port : process.env.PORT;
  const port = portArg !== undefined ? Number(portArg) : DEFAULT_SERVER_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`端口无效：${portArg}`);
    process.exit(1);
  }
  const dataDir = args['no-save'] ? null : resolve(typeof args.data === 'string' ? args.data : 'server-data');
  const keepFinishedHours = numberArg(args, 'keep-finished-hours');
  const keepIdleDays = numberArg(args, 'keep-idle-days');
  const statsMin = numberArg(args, 'stats-interval-min');
  const publicMode = !!args.public || envFlag(process.env.D2M_PUBLIC);
  const trustProxy = !!args['trust-proxy'] || envFlag(process.env.D2M_TRUST_PROXY);
  const tis = registerNodeRosterLoader();
  if (!tis.length) console.warn('警告：没有找到真实阵容数据（src/data/rosters），只能使用「各自组建战队」玩法');

  let server: RunningServer;
  try {
    server = await startServer({
      port,
      host: typeof args.host === 'string' ? args.host : undefined,
      dataDir,
      distDir: typeof args.dist === 'string' ? resolve(args.dist) : undefined,
      serverName: typeof args.name === 'string' ? args.name : undefined,
      finishedRoomTtlMs: keepFinishedHours !== undefined ? keepFinishedHours * 3_600_000 : undefined,
      idleRoomTtlMs: keepIdleDays !== undefined ? keepIdleDays * 86_400_000 : undefined,
      publicMode,
      trustProxy,
      statsLogIntervalMs: statsMin !== undefined ? statsMin * 60_000 : undefined,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') console.error(`端口 ${port} 已被占用：可能服务器已经在运行，或换一个端口：npm run server -- --port ${port + 1}`);
    else if (e.code === 'EACCES') console.error(`没有权限监听端口 ${port}，请换一个大于 1024 的端口`);
    else console.error(`服务器启动失败：${e.message}`);
    process.exit(1);
  }

  const statsUrl = `http://127.0.0.1:${server.port}/api/status`;
  const lines = publicMode
    ? [
      '',
      '  刀塔经理 · 多人服务器已启动（公网模式）',
      '',
      `  本机访问：   ${server.url}`,
      '  内网地址：   （公网模式下不显示，也不会发给客户端）',
      '',
      `  WebSocket：  ${WS_PATH}    房间存档：${dataDir ?? '（不保存）'}`,
      `  在线统计（只允许本机访问）：curl -s ${statsUrl}`,
      `  让朋友在浏览器打开服务器的公网地址或域名（端口 ${server.port}），在入口页选择「多人对战」即可加入。`,
      '',
    ]
    : [
      '',
      '  刀塔经理 · 局域网多人服务器已启动',
      '',
      `  本机访问：   ${server.url}`,
      ...(server.lanUrls.length
        ? server.lanUrls.map((u, i) => `  ${i === 0 ? '局域网访问：' : '            '} ${u}`)
        : [typeof args.host === 'string' && args.host !== '0.0.0.0'
          ? `  局域网访问： （只监听 ${args.host}，局域网内的朋友无法访问；去掉 --host 参数即可）`
          : '  局域网访问： （未检测到局域网 IPv4 地址，请检查网络连接）']),
      '',
      `  WebSocket：  ${WS_PATH}    房间存档：${dataDir ?? '（不保存）'}`,
      `  在线统计（只允许本机访问）：curl -s ${statsUrl}`,
      `  让朋友在浏览器打开上面的局域网地址，在入口页选择「多人对战」即可加入。按 Ctrl+C 停止（进度会自动保存）。`,
      '  部署到公网时请加 --public（不向客户端发送内网地址）。',
      '',
    ];
  console.log(lines.join('\n'));

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    const n = server.flushSync();
    console.log(`\n收到 ${signal}，已保存 ${n} 个房间，正在关闭…`);
    const force = setTimeout(() => process.exit(0), 2000);
    force.unref();
    server.close().then(() => process.exit(0), () => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  // 任何未捕获的异常都只记录，不让服务器崩溃（房间状态仍在内存中，并会继续定期保存）
  process.on('uncaughtException', (err) => console.error('[未捕获异常]', err));
  process.on('unhandledRejection', (err) => console.error('[未处理的 Promise 拒绝]', err));
}

void main();

// ============================================================================
// 刀塔经理 · 局域网多人服务器（命令行入口）
// 用法：npm run server [-- --port 8686] [--data ./server-data] [--host 0.0.0.0] [--dist ./dist] [--name 房主的电脑]
//                      [--keep-finished-hours 2] [--keep-idle-days 14]
//       npm run mp   （先 vite build 前端，再启动服务器）
// 朋友在浏览器打开启动时打印的局域网地址即可加入；WebSocket 路径为 /ws。
// ============================================================================
import { resolve } from 'node:path';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { DEFAULT_SERVER_PORT, WS_PATH } from '../src/shared/protocol';
import { startServer, type RunningServer } from './app';
import { DEFAULT_FINISHED_ROOM_TTL_MS, DEFAULT_IDLE_ROOM_TTL_MS } from './rooms';

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

const HELP = `刀塔经理 · 局域网多人服务器

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
  --no-save         不保存房间（测试用）
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
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') console.error(`端口 ${port} 已被占用：可能服务器已经在运行，或换一个端口：npm run server -- --port ${port + 1}`);
    else if (e.code === 'EACCES') console.error(`没有权限监听端口 ${port}，请换一个大于 1024 的端口`);
    else console.error(`服务器启动失败：${e.message}`);
    process.exit(1);
  }

  const lines = [
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
    `  让朋友在浏览器打开上面的局域网地址，在入口页选择「多人对战」即可加入。按 Ctrl+C 停止（进度会自动保存）。`,
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

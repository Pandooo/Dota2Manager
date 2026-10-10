# AGENTS.md · AI 编码助手协作指南

本文件写给在本仓库工作的 AI 编码助手（以及人类协作者）。动手前请先读完，并阅读 `docs/` 下的相关文档。

## 1. 项目概览

「刀塔经理」是浏览器中运行的 Dota 2 俱乐部经营模拟（单机 + 局域网多人）。

| 目录 | 内容 |
|---|---|
| `src/engine/` | 纯 TypeScript 模拟引擎（无 React/DOM 依赖，可在 Node 运行） |
| `src/data/` | 静态数据：`tis.json`、`rosters/ti{n}.json`、`patches.json`、`heroes.json`、`tournaments/season{n}.json`、`legacyClubs.json`、由脚本生成的 `playerIndex.json` / `trajectories.json` / `coachIndex.json` |
| `src/store/` | Zustand 状态（`gameStore.ts`）、匿名会话存档（`session.ts`，IndexedDB）、联机客户端（`net.ts`） |
| `src/ui/` | React 19 + Tailwind v4 页面与组件（全中文界面） |
| `src/shared/protocol.ts` | 多人 WebSocket 协议与 RPC 白名单（服务器与客户端共用） |
| `server/` | 局域网权威服务器（Node + `ws`） |
| `scripts/` | 无头模拟、数据构建 / 校验、端到端测试 |
| `tests/` | Vitest 单元测试 |

文档（事实来源）：
- `docs/DESIGN.md`：玩法与数值设计。改动机制时同步更新。
- `docs/ROADMAP.md`：用户需求与迭代记录（含「约束」一节）。完成一项需求后标记 ✅ 并写明状态。
- `docs/UI.md`：界面规范。
- `docs/MULTIPLAYER.md`：多人设计（座位上下文切换、协议、服务器）。

## 2. 必须遵守的规则

### 引擎
- **确定性**：随机数只能通过 `rngOf(state)`（或独立的 `seededRng` / 哈希流）取得，引擎逻辑中禁止 `Math.random()` / `Date.now()` / 无参 `new Date()`。纯统计、展示类的随机（如 KDA 归属）应使用独立的种子流，不得改变比赛结果或主随机序列。
- 引擎**原地修改** `GameState`，函数签名为 `(state, ...args)`；玩家操作返回 `OpResult { ok, message }`，用户错误给出中文提示而不是抛异常。
- 可调数值一律放在 `src/engine/config.ts` 的 `CONFIG` 中，业务代码中不写魔法数字。
- 性能：一个赛季要模拟数千场 AI 比赛，热路径避免对全部选手的 O(n²) 扫描；16 个赛季的无头模拟应在数秒内完成。
- 存档体积：不保存逐局明细，统计以汇总形式保存；新增持久化数据需评估存档增长。

### 多人兼容
- 「玩家私有」状态必须能被座位上下文切换（`src/engine/seat.ts` 的交换列表）。新增此类顶层字段时要加入交换列表；更推荐把状态挂在 `Player` / `Team` 对象上。
- 判断「是否人类战队」用 `team.isPlayer` / `isHumanTeam`，不要假设只有一个人类战队。
- 新增的玩家操作要加入 `src/shared/protocol.ts` 的 `RPC_WHITELIST`，并确认能经 `callAsSeat` 执行。

### 界面
- 读状态用 `useGame()`；**修改游戏状态只能通过 `call('引擎函数名', ...参数)`**（`useCall()` / `useCallSilent()`），禁止在组件中直接修改 `game` 对象。多步逻辑放到 `src/engine/uiActions.ts` 新建具名引擎函数。
- 二次确认使用 `src/ui/components/ConfirmPopover.tsx` 的 `ConfirmButton`（按钮旁气泡），不要用 Modal 做是 / 否确认；尽量少用弹窗，优先在总览中展开卡片。
- 按钮禁用时用 `title` 说明原因；全中文文案；遵循 `src/index.css` 的主题色。

### 用户约束（来自 `docs/ROADMAP.md`「约束」）
- **不要自行编写搞笑 / 玩梗内容**。`src/engine/funEvents.ts` 的 `FUN_EVENTS` 只放用户提供的梗；新闻与事件文案保持平实。
- `config.ts` 中标注【用户指定】的数值（新秀等级分布、在队时长倍数上限等）不得在平衡调整中修改。
- 任何外部网络请求（检索资料等）都不得携带用户的个人信息（邮箱等），使用通用 User-Agent。

## 3. 验证（改完必须全部通过）

```bash
npx tsc -p tsconfig.app.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npx vitest run
npx tsx scripts/validate-data.ts
npx tsx scripts/simulate.ts --ti 9 --seasons 3 --seed 3
npx tsx scripts/smoke-match.ts 9
npx tsx scripts/simulate-mp.ts --mode both
npx tsx scripts/mp-e2e.ts
npx vite build --outDir <临时目录>
```

- 测试时构建到临时目录（`--outDir`），**不要覆盖项目的 `dist/`**（多人服务器会托管它）。
- 浏览器测试请用独立的源（例如 `xxx.localhost` 或其他端口的 `vite preview`），避免读写用户在 `localhost:5173` 上的存档。
- 调整数值时用 `scripts/simulate.ts`（`--runs`、`--team`）与 `scripts/simulate-mp.ts` 做多种子、多起点的对照，并在 `docs/DESIGN.md` 中记录结论。

## 4. 数据维护

- 修改 `src/data/rosters/ti*.json` 后运行：`npm run data:index`（真实新秀索引）、`npx tsx scripts/build-trajectories.ts`（真实生涯轨迹）、`npx tsx scripts/build-coach-index.ts`（教练索引），再运行 `npm run data:validate`。
- 选手 id 为跨届一致的规范 slug（最知名 ID 的小写字母数字，如 `miracle`、`n0tail`）；同一人在各届文件中的 id、出生年份、国籍必须一致。
- 英雄 id 以 `src/data/heroes.json` 为准。

## 5. 提交

- 提交信息使用简洁的中文或英文，说明改了什么、为什么。
- 不要提交 `node_modules/`、`dist/`、`server-data/`（多人房间存档）等本地产物（见 `.gitignore`）。

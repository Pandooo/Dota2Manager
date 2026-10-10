# 刀塔经理 · Dota2 Manager

> 接管真实豪门俱乐部，亦或白手起家打造护国之翼。训练、转会、新秀、BP 博弈、文字直播——让你的战队捧起不朽盾！

一款在浏览器中运行的 Dota 2 电竞俱乐部经营模拟游戏（灵感来自《足球经理》）。你扮演俱乐部经理，从 TI1（2011）到 TI16（2027）之间任选起止届次，组建战队征战每年的巡回赛，以夺得 The International 冠军为目标。支持单机与局域网多人对战。

**版本：v0.1**

---

## 特色

- **真实历届阵容**：TI1–TI15 共 15 届的真实战队与选手数据（参考 Liquipedia 整理），可接管当年的真实俱乐部或新建俱乐部；真实选手会沿着各自的真实生涯轨迹成长，未来出道的真实新秀会在对应赛季进入选秀。
- **完整的经营循环**：赛季日历（休赛回合 / 赛事回合 / TI 预选 / TI 正赛）、训练与训练赛、NBA 式新秀选秀、自由市场与转会、挂牌出售、教练、奖金分成、隐藏的预期薪资与多维归属感、荣誉系统（荣誉跌破 0 即解散）。
- **比赛模拟**：队长模式 BP（可手动或自动）→ 大老师胜率 → 结合选手数值的随机胜负 → 中文文字直播；也可一键快速模拟。
- **动态世界**：按真实发布日期逐回合生效的 Dota 2 版本更新、赛季前大型转会潮、跨赛季状态起伏与年龄衰退、随机事件（签证、伤病、丑闻、假赛……）、刀塔周报与世界动态新闻。
- **懒人模式**：底部「下一回合」可自动处理本回合的比赛、阵容与待决事件，一路点到底也能玩完一个赛季。
- **DotaPedia 百科**：仿 Liquipedia 的战队页与选手页、KDA 等历史数据、各类排行榜，以及实时的「历史地位」评估。
- **生涯总结**：游戏结束时按成就生成《文明》式结算，与历史真实俱乐部对照排名。
- **局域网多人对战**：房主启动服务器，朋友用浏览器加入房间；共享回合、操作按到达顺序实时结算（例如抢签同一名自由选手先到先得）。

## 快速开始

需要 Node.js 20+（开发时使用 Node 22–25 验证）。

```bash
npm install
```

### 单机

```bash
npm run dev
```

浏览器打开终端里显示的地址（默认 http://localhost:5173）。进度自动保存在当前浏览器（匿名会话，IndexedDB），可在游戏内导出 / 导入存档文件。

### 局域网多人

房主在项目目录运行（会先构建前端，再在 8686 端口启动服务器）：

```bash
npm run mp
```

终端会打印本机的局域网地址，朋友在同一局域网内用浏览器打开该地址即可进入大厅。详细说明见 [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md)。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（单机） |
| `npm run build` | 类型检查 + 生产构建（输出 `dist/`） |
| `npm run mp` | 构建并启动局域网多人服务器 |
| `npm run server` | 仅启动多人服务器（需已构建 `dist/`） |
| `npm test` | 运行全部单元测试（Vitest） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run sim -- --ti 9 --seasons 3 --seed 1` | 无头模拟整局游戏（平衡调试，支持 `--team <战队id>`、`--runs N`、`--quiet`） |
| `npx tsx scripts/smoke-match.ts 9` | 手动比赛流程冒烟测试 |
| `npx tsx scripts/simulate-mp.ts --mode both` | 无头多人对局模拟 |
| `npm run mp:e2e` | 多人端到端测试（真实服务器 + 多个客户端） |
| `npm run data:validate` | 校验 `src/data` 中的数据 |
| `npm run data:index` | 由各届阵容重建真实新秀索引 `playerIndex.json` |

## 技术栈与结构

- **引擎**：纯 TypeScript，确定性模拟（存档内保存随机种子），可在浏览器与 Node 中运行。
- **界面**：React 19 + Tailwind CSS v4 + Zustand，全中文。
- **多人**：Node + `ws` 的权威服务器，复用同一套引擎。

```
src/
  engine/   模拟引擎（赛季流程、比赛与 BP、成长、经济、市场、选秀、事件、新闻、多人座位……）
  data/     静态数据（TI 信息、各届阵容、版本、英雄、赛事、历史俱乐部……）
  store/    状态管理、会话存档、联机客户端
  ui/       页面与组件
  shared/   服务器与客户端共享的联机协议
server/     局域网多人服务器
scripts/    无头模拟、数据构建与校验、端到端测试
tests/      单元测试
docs/       设计文档
```

## 文档

- [docs/DESIGN.md](docs/DESIGN.md)：玩法与数值设计（唯一事实来源）
- [docs/ROADMAP.md](docs/ROADMAP.md)：按用户反馈推进的迭代记录
- [docs/UI.md](docs/UI.md)：界面开发规范
- [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md)：局域网多人设计与使用说明
- [AGENTS.md](AGENTS.md)：AI 编码助手协作指南

## 数据来源与声明

- 历届 TI、战队、选手、赛事与版本信息参考 [Liquipedia Dota 2](https://liquipedia.net/dota2/)（内容采用 [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) 许可）及公开资料整理，选手能力数值为游戏化设定，并非真实评价；未来赛季（如 TI16）为推演数据。
- 本项目为粉丝自制的非商业作品，与 Valve Corporation 无关。Dota 2、The International 及相关名称和标志为 Valve Corporation 的商标。

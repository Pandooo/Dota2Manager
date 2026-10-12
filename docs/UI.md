# UI 开发规范

## 技术约定
- React 19 + Tailwind v4（主题 token 见 `src/index.css` 的 `@theme`：`bg panel panel-2 panel-3 line ink mute faint dota dota-2 gold radiant dire good bad info tier-*`）。
- 通用组件统一从 `src/ui/components/common.tsx` 引入：`Button Card PageHeader EmptyState Stat Badge TierBadge PosBadge RegionBadge StatBar AttrRow Gold Delta PlayerLink TeamLink TeamTag Tabs Modal Hint cx`。**不要重复造轮子**，确需新的通用组件时在自己负责的文件内实现。
- 状态：
  - 读：`const game = useGame()`（任何引擎操作后自动重渲染）。
  - 写：`const call = useCall(); call('someOp', ...args)`（引擎函数名 + 除 state 外的参数，类型由引擎签名推导）。单机在本地执行并自动存档；多人模式作为白名单 RPC（`src/shared/protocol.ts` RPC_WHITELIST）发给服务器。返回 `Promise`，需要结果时 `.then(res => …)`；返回 `OpResult` 时自动 toast 提示；成功时不提示用 `useCallSilent()`。
  - 需要多步逻辑的修改在 `src/engine/uiActions.ts` 新增具名引擎函数（并加入 RPC_WHITELIST），不要在 UI 回调里拼装；`act()` 只保留给单机专用的本地操作（多人模式下会被拒绝）。
  - 导航：`useGameStore(s => s.setView)('squad')`；选手详情 `openPlayer(id)`；战队详情 `openTeam(id)`。
  - **禁止在组件里直接修改 game 对象**，一切修改必须经 `call()` 调用引擎函数（`src/engine/index.ts` 导出）。
- 派生数据在渲染时现算即可（数据量不大）；大列表（>200 行）用分页或筛选。
- 全中文界面；数字用 `tabular` 类对齐；金额用 `<Gold value={...}/>` 或 `formatGold`。
- 每个页面顶部用 `<PageHeader title subtitle actions/>`，内容用 `<Card>` 分区，网格布局 `grid gap-4 lg:grid-cols-…`。
- 交互反馈：按钮 disabled 时给出 `title` 说明原因（如"转会窗口已锁定"、"金币不足"）。
- 视觉：暗色、Dota 风格（暗红 dota + 金色 gold 点缀），信息密度高但层次清晰，参考 Football Manager 的数据面板感。

## 关键体验
- **少弹窗、一键推进**（用户反馈 2026-10-10：「减少弹窗……最懒人的玩法就是可以直接一直点下方的『下一回合』按钮」）：游戏内除游戏结束的生涯总结外不再弹出 Modal；回合信息进总览卡片，操作进底部操作栏，二次确认用按钮旁的气泡。新增界面遵守同样的规则：**不要**为本回合事务、结算或确认新开 Modal（Modal 只用于选手 / 战队详情、系列赛详情、报价表单、存档管理、玩法说明这类内容面板，以及多人「离开对局」这种多选项对话框）。
- **回合推进 = 底部操作栏（`src/ui/layout/ActionBar.tsx`）中间的主按钮**，永远是「开始赛季 / 下一回合 / TI 结算」（多人为「准备进入下一回合（n/m）/ 取消准备」）。
  - **懒人推进（默认开启）**：左侧「自动处理」开关 = `store.lazyAdvance`（按浏览器记在 localStorage `d2m:lazyAdvance`，不进存档）。开启时主按钮不被阻塞挡住，点击 = `advance()` → 引擎 `advance(state, { auto: true })`：先由 `src/engine/autoRound.ts` 的 `autoHandleRound` 按保守默认处理本回合的阻塞（待决事件按 `events.defaultDecisionChoice`；首发不合法时自动排阵、可出场不足 5 人时招募负担得起的临时替补，招不起则弃权；本方本回合剩余比赛快速模拟），再推进回合。主按钮小字显示 `previewAutoActions` 的预览（如「⚡ 自动：快速模拟 7 场比赛 · 默认处理 1 个事件」，预览不修改状态）；推进后用 toast 摘要结果，完整记录见消息中心「本回合自动处理」。未用完的训练本来就会在回合结束时按当前焦点自动完成。所以一直点主按钮就能打完整个赛季（TI 转场约 3 秒后自动结束）。多人模式下同一开关让「准备」变为自动准备（协议 `setRoundReady` 的 `auto`，服务器 `multi.setSeatReady(..., { auto: true })` 先自动处理再准备；等待对手时保持「取消自动准备」）。
  - 关闭自动处理时与以前一致：有阻塞时主按钮禁用，小字为「需先处理：…」，并点亮解决阻塞的第一个情境操作。
  - 推进后停留在当前页面（比赛页除外：推进后回到总览）。在比赛页且比赛进行中时操作栏不渲染（比赛页自带 `MatchDock` 底栏）；比赛页停留在结算时只保留主要操作。
- **底栏情境操作**（主按钮两侧，紧凑、不切换页面；`CtxAction` 列表，按回合状态生成）：
  - 休赛 / 观赛回合：`⚔ 训练（剩余次数）`+ 焦点切换气泡、`加练 · 价格`、`训练赛 ▴`（推荐对手气泡，直接约练；本回合已约过的对手显示为禁用的「本回合已约过」）、`训练详情`（展开总览训练卡片）；
  - 赛事回合：`快速模拟本场 vs 对手`、`快速模拟整项赛事`（就近确认）、`进入比赛 · 手动 BP`、`赛事详情`（展开总览赛事卡片）；首发不合法时 `自动排阵`；可出场不足 5 人时 `补齐首发（临时替补）` / `弃权本场`（就近确认）；比赛进行中为 `继续比赛 ▶`；
  - 有阻塞推进的待决事件时：`! 待决事件 n` 徽标，点开气泡直接选择（默认选项标「默认」）。
  - 布局：≥1280px 一行显示；更窄时次要操作收进「更多 ▴」。`BarRow` 按实际宽度测量，某一栏放不下时按 `demote` / `compact` 顺序逐步换成紧凑写法或收进「更多」，不会压住主按钮。新增按钮时给出 `demote` / `compact`；按钮上的绝对定位装饰（如红点）不能超出所在栏，否则测量会误判为放不下。
- **总览内嵌卡片（不弹窗）**：训练（`TrainingModal.tsx` 的 `TrainingCard`）与赛事（`TournamentModal.tsx` 的 `TournamentCard`）是总览「本回合」中可原地展开 / 收起的卡片。展开状态 = `store.trainingOpen / tournamentOpen`；任何页面调用 `setTrainingOpen(true) / setTournamentOpen(true)` 都会回到总览、展开并滚动到卡片（`store.cardFocus`）。赛事回合开始时赛事卡片自动展开（本方仍有比赛要打，`store.syncTournamentCard` + `TourModalLogic`），回合内由玩家决定；卡片内：进入比赛 → 比赛页（BP → 大老师胜率 → 文字直播 → 赛果）→ 返回总览，卡片自动显示下一场；也可「快速模拟本场 / 本赛事」。只有查看完整分组与对阵图时才进入「赛事 › 赛事中心」。
- **回合通知**（`PopupHost.tsx`）：`game.popups`（赛事结算、赛季总结、版本更新、新秀选秀结果、消息）不再弹窗——总览顶部为「通知」卡片（`NoticesCard`，最新在前、点击原处展开、「全部已读」= `callSilent('dismissPopups', n)`），其他页面在左下角（侧栏底部）显示徽标（`NoticeBadge`，点击回总览）。只有游戏结束（生涯总结）界面仍逐条弹窗（默认导出 `PopupHost`）。
- **二次确认**：一律用按钮旁的确认气泡（`src/ui/components/ConfirmPopover.tsx`），不用 Modal、不用 `window.confirm`：
  - 按钮直接写 `<ConfirmButton confirm={{ title?, message, confirmLabel?, danger? }} onConfirm={() => call(...)}>…</ConfirmButton>`（`confirm` 为 null 时直接执行，适合「只有某些情况才需确认」，如没有现任教练时签约教练不确认、替换才确认）；非按钮触发元素用 `useConfirmPopover()` + `<ConfirmPopover>`。
  - 气泡优先出现在按钮上方，「确定」按钮落在原按钮附近，减少鼠标移动；Enter 确定，Esc / 点击外部取消；危险操作（解约、弃权、踢人）用 `danger`。
  - 底栏「更多」菜单里的确认项用 `MenuConfirm`（确认后收起菜单）。
- **TI 转场**（第八波，`src/ui/components/TiTransition.tsx` + 纯函数 `src/ui/tiTheme.ts`）：进入 TI 正赛回合播放全屏转场（不朽之盾升起 → 发光 → 消失，约 3.2 秒，点击 / 空格跳过，减少动态效果时只淡入淡出）；TI 预选回合为顶部横幅（回合开始即出现；回合通知是总览内的卡片，不再挡住它）；TI 正赛回合顶栏 / 底栏点缀该届主题色（`tis.json` 的 `theme`）。由 store 的 `syncTiIntro` 在任何状态变化后检查，每个存档 × 座位 × 届次只触发一次（「已看过」记在 localStorage `d2m:tiIntroSeen`）；页面在后台时等回到页面再播放。只读，不修改游戏状态，多人模式下每个座位的客户端各自触发。
  - 冠军盾（第十波 #7）：`AegisSvg` 为重新绘制的**原创**矢量图（圆盾 · 24 瓣扇贝雕纹盾缘 · 铆钉与叶纹 · 四道棱脊与卷草纹 · 中央凸台 + 八角刻面主宝石），银灰金属底按该届主题着色；不得描摹或加入官方冠军盾图片。`AegisArt` = 本地覆盖图片优先（见下「本地美术覆盖」），否则 `AegisSvg`。
  - 顶栏徽记 `TiAegisBadge`（TI 预选与 TI 正赛回合）：单机在顶栏绝对居中（≥ lg 显示），多人排在玩家条之前；主题色光晕；点击在下方展开小气泡（portal 到 body，点击外部 / Esc 收起）：「The International {年份}」、城市与主题、当前阶段、本队参赛情况。
- **队徽**（第十波 #4，`src/ui/components/TeamEmblem.tsx` + 纯函数 `src/ui/emblem.ts`）：`TeamTag` 的色块换成按「简称 + 品牌配色」确定性生成的原创风格化队徽（外形 / 装饰纹由简称哈希决定，首字母取自简称，辅色取 `branding.json` 的 `color2` 或由主色推导；默认尺寸 1.3em 随文字缩放）。换品牌（简称 / 配色变化）后自然换成新队徽。战队名旁的色块同样换成 `TeamEmblem`（赛事对阵 / 赛程的 `TourShared.TeamName`（待定席位仍为灰色色块）、总览积分榜、转会市场三处战队单元格、BP 顺序、新秀选秀、世界动态战队标签、战队弹窗标题、DotaPedia 战队页标题 28px、新游戏确认页 48px、多人新建俱乐部预览 48px）；赛区 / 图表配色与新闻滚动条的小圆点不属于队徽，保持色块。新增展示战队的地方优先用 `TeamTag` / `TeamEmblem`，不要再写纯色块。真实队标属于商标，不得加入仓库。`TeamTag` 新增可选 `teamId`（用于本地队标）；未传时只有放了本地队标才按「简称 + 主色」在当前存档里反查 id（每个状态版本建一次索引）。DotaPedia 战队信息框的「品牌沿革」行 = `TeamBrandHistoryRow`（本局无品牌变化时不显示）。
- **背景音乐**（第十波 #6，`src/ui/components/MusicControl.tsx` + 播放器 `src/ui/audio/bgm.ts`）：顶栏「荣誉」右侧的音符按钮（非游戏界面没有顶栏，固定在角落：主菜单与生涯总结在右上角；新游戏 / 大厅 / 房间的右上角有返回按钮或玩家名，改在右下角，面板向上展开），点击在按钮下方（放不下时上方）展开小面板（portal 到 body，点击外部 / Esc 收起）：开关、音量滑块、音源（内置原创氛围音乐 / 本地文件）、选择 / 更换 / 移除本地文件（移除用确认气泡）。设置按浏览器记在 localStorage `d2m:bgm`，本地文件存在 IndexedDB，不进存档、不经 `call()`。不得加入任何 Valve 音频。
- **破产倒计时**（第十波 #1）：资金为负（或连续为负的计数尚未清零）时，总览「待处理」标题行常驻红色「资金为负：再持续 N 回合将破产」（不展开也可见），展开后第一行显示负债 / 上限，负债已超上限时另起一行警告；数据来自引擎只读查询 `bankruptcyStatus`。
- **开局资金与奖金分成的展示**（2026-10-10）：新游戏向导（难度说明、新建俱乐部预览与「开局配置」）、多人房间「我的战队」的新建俱乐部预览都从引擎读取：启动资金 = `estimateNewClubStart(startTi, difficulty)`（内部即 `newClubStartingFunds`，与开局为同一函数，预览 = 实际；「约为初始阵容 N 回合的工资」按其 `wagePerRound` 计算：各等级取战力区间中点的标准工资，与实际初始 5 人工资的多种子均值相差约 1%，不含赛季初选秀的新秀）、难度说明里的新俱乐部启动资金 = `newClubStartingFunds(startTi, d)`、真实俱乐部资金（战队卡片与确认页）= `seedTeamStartingFunds(seedTeam, startTi, difficulty)`、多人「选择已有战队」的公平规则旁显示重置后的启动资金、默认分成 = `CONFIG.prizeShare.initial`；不要在界面写死金额、回合数或比例（2026-10-10 开局资金锚定后更新）。财务页「选手奖金分成」卡片的说明随中性点（`CONFIG.prizeShare.loyalty.norm`，等于下限时不再写「低于则下降」）与奖金折算窗口（`CONFIG.prizeShare.salary.windowRounds`）生成。
- **待决策事件**（`game.pendingDecisions`）在消息中心置顶显示，阻塞推进的事件同时出现在底栏「待决事件」气泡里；选项按钮调用 `call('resolveDecision', id, choiceId)`。开启自动处理时不处理也能推进（按默认选项）。
- **DotaPedia 百科**（侧栏「DotaPedia」，中心页键 `pedia`，标签 `pediaHome | pediaTeams | pediaPlayers | pediaTours | pediaHeroes | pediaSynergies`（羁绊图鉴，第十波 #5：未解锁只显示提示，解锁后显示成员现状与激活战队；阵容页顶部的羁绊条与战队词条的「羁绊」章节用 `src/ui/components/SynergyKit.tsx`，「羁绊图鉴 ›」= `setView('pediaSynergies')`）；`src/ui/screens/PediaLazy.tsx` 按需加载 `PediaHub` 及各标签页）：只读，数据全部来自 `engine/pedia.ts` 的纯查询（在渲染时调用，按 `version` 记忆）。
  - 词条导航（`src/ui/components/PediaNav.ts`）：`openPedia(kind, id)` 打开战队 / 选手 / 赛事 / 英雄词条（id = null 为列表），会关闭选手 / 战队弹窗并记下来源，`pediaBack()` 逐级返回（可回到百科外的页面）；每个标签记住选中的词条，再次点击当前标签回到该类列表（`pediaTabReselect`，经 `HubShell onReselect`），换局（`game.id` 变化）自动清空。纯 UI 状态，不进存档。每个词条包在 `PediaEntryGuard`（词条级错误边界，带「返回列表」）里，出错的词条不会把整个标签卡死。
  - 百科内的战队名 / 选手 ID / 赛事 / 英雄一律用 `PediaKit` 的 `PTeam / PPlayer / PTour / PHero` 链接到词条；选手 / 战队弹窗底部有「DotaPedia ›」入口（`PediaEntryButton`，生涯总结界面不显示，多人模式本座位出局后同样不显示）。
  - 逐局个人 K / D / A 不存储（用户反馈 2026-10-10），系列赛详情（`TourSeriesModal`）每局只显示 BP、时长、比分与 MVP；个人数据只在百科的聚合（生涯 / 分赛季 / 英雄 / 单局纪录）中出现。
  - 历史地位的「单算本局 / 单算开局前（现实）」是各自单独计分，传奇值按合并后的成就重新计分，不是两者之和——展示分项时要这样标注，不要写成可相加的样子。
  - 词条页布局仿 Liquipedia：左侧章节（`PSection`）+ 右侧信息框（`Infobox / InfoRow / InfoHead`）与目录（`PediaToc`），≥1024px 双栏；小图表用 `PediaCharts`（按容器实际宽度绘制的内联 SVG，悬停有提示）。
  - 战队词条「使命」章节（第十波 #3，`src/ui/screens/PediaTeamMission.tsx`，数据 `engine/missions.ts` 的 `clubMissionView`，只读）：只对真实俱乐部显示（虚构 / 程序化战队不出现该章节与目录项）——目标「重组 TI{n} 巅峰阵容」、状态（进行中 / 已集齐 / 使命完成 / 不适用）、k/5 进度条、五名成员的巅峰位置与现在在哪（已在队 / 其他战队 / 玩家战队 / 自由身 / 已退役 / 禁赛 / 尚未出道，战队可点击）、首次集齐与集齐后夺冠的赛季。
    该届真实 TI 尚未到来时不显示现实成绩（不剧透）；玩家执教的真实俱乐部只展示巅峰阵容并注明不设 AI 使命。信息框「成立」一行（`TeamFoundedRow`，第十波 #2）显示本局中途成立的俱乐部的成立赛季。

## 本地美术覆盖（`public/local/`，第十波 #4 / #7）
真实队标与官方冠军盾图片属于商标 / 版权美术，**不得提交到仓库**；界面默认使用原创生成的队徽与矢量冠军盾。用户可在本机放入自己的图片覆盖显示（目录被 `.gitignore` 忽略，只提交 `public/local/README.txt` 使用说明）：
- `public/local/logos/{战队 id}.png|svg|webp`：队标；`{战队 id}.{简称}`（简称去标点、小写，如 `lgd-gaming.psglgd.png`）可为某个品牌时期单独指定，优先于 `{战队 id}`。
- `public/local/aegis.png|svg|webp`：冠军盾（TI 转场、预选横幅、顶栏徽记）。
- 实现（`src/ui/localArt.ts`）：文件列表由 `import.meta.glob` 在开发服务器启动 / 构建时枚举（只取文件名，从不导入内容），运行时不做探测请求——没有文件就不发请求、控制台没有 404；放入或删除文件后重新运行 `npm run dev` / `npm run mp`。图片加载失败时记下地址并回退到生成图案，不再重复请求。

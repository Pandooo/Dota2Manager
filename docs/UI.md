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
- **位置**（第十三波）：显示选手位置时用 `<PosBadge pos={p.position} alt={p.altPositions} />`（有副位置时附「可5」小字，`full` 时为「4号位 游走辅助（可打5号位）」，
  副位置较多时在徽章内换行；放进单行截断的单元格时给单元格去掉截断，如 PlayerModal 的 `Info wrap`）；与「5号位 保姆辅助」并排的副位置文字用 `altPositionsText`（阿拉伯数字，
  不要和「四号位」混用；新闻正文沿用中文数字「转型为五号位」）。选手打某个首发位置的适配一律用引擎的 `roleFit / roleFitFactor / ROLE_FIT_LABEL`（本位置 / 副位置 / 四五号位互换 /
  非本位置），颜色与小标签用 `SquadShared` 的 `ROLE_FIT_TONE / ROLE_FIT_TEXT / RoleFitChip / roleFitTitle`——不要再写 `p.position !== slot` 或直接引用 `offRoleFactor`。
  按位置筛选选手时用 `playsNaturally`（含副位置），同时显示的评分用打该位置的 `playerRating(p, pos)`（如转会求购）。
  真实生涯位置调整 / 旧存档修正对人类玩家战队除了新闻还会在总览「通知」放一条 `message` 提示（引擎负责，界面无需额外处理）。
- 每个页面顶部用 `<PageHeader title subtitle actions/>`，内容用 `<Card>` 分区，网格布局 `grid gap-4 lg:grid-cols-…`。
  窄屏单列的网格写成 `grid grid-cols-[minmax(0,1fr)] … lg:grid-cols-…`：不写列定义时隐式列按内容最小宽度撑开，卡片里的宽表格（即使包在 `overflow-x-auto` 里）会把整列连同卡片右上角的按钮撑出屏幕
  （手机上主区只有约 200px）。`Card` 标题行可换行：标题至少保留 8rem，操作按钮放不下时换到下一行；`Banner` 的操作按钮同样会换到正文下方（2026-10-14 审查）。
- **中文排版**：JSX 里一句中文不要在标点之后换行——换行会变成一个空格（「均匀抽 1 张， 新秀…」）。长句写在同一行，或放进模板字符串；拉丁文与中文之间留一个空格（「Minor 退赛扣 12 荣誉」），负数用「−」。
- 交互反馈：按钮 disabled 时给出 `title` 说明原因（如"转会窗口已锁定"、"金币不足"）。
- 视觉：暗色、Dota 风格（暗红 dota + 金色 gold 点缀），信息密度高但层次清晰，参考 Football Manager 的数据面板感。

## 关键体验
- **少弹窗、一键推进**（用户反馈 2026-10-10：「减少弹窗……最懒人的玩法就是可以直接一直点下方的『下一回合』按钮」）：游戏内除游戏结束的生涯总结外不再弹出 Modal；回合信息进总览卡片，操作进底部操作栏，二次确认用按钮旁的气泡。新增界面遵守同样的规则：**不要**为本回合事务、结算或确认新开 Modal（Modal 只用于选手 / 战队详情、系列赛详情、报价表单、存档管理、玩法说明这类内容面板，以及多人「离开对局」这种多选项对话框）。
- **回合推进 = 底部操作栏（`src/ui/layout/ActionBar.tsx`）中间的主按钮**，永远是「开始赛季 / 下一回合 / TI 结算」（多人为「准备进入下一回合（n/m）/ 取消准备」）。
  - **懒人推进（默认开启）**：左侧「自动处理」开关 = `store.lazyAdvance`（按浏览器记在 localStorage `d2m:lazyAdvance`，不进存档）。开启时主按钮不被阻塞挡住，点击 = `advance()` → 引擎 `advance(state, { auto: true })`：先由 `src/engine/autoRound.ts` 的 `autoHandleRound` 按保守默认处理本回合的阻塞（待决事件按 `events.defaultDecisionChoice`；转会窗口内正式阵容缺位置或不足 5 人时签下负担得起的自由选手（v0.3，见 DESIGN.md 3.4.2）；首发不合法时自动排阵、可出场不足 5 人时招募负担得起的临时替补，招不起则弃权；本方本回合剩余比赛快速模拟），再推进回合。主按钮小字显示 `previewAutoActions` 的预览（如「⚡ 自动：快速模拟 7 场比赛 · 默认处理 1 个事件」，预览不修改状态；完整内容在按钮的悬停提示）；计划自动签人时右侧提示「⚡ 将自动签下 X（五号位），签字费 …」（多人客户端无法预知婉拒，加注「婉拒则顺延」），签不到人时小字写明原因（如「缺五号位：入不敷出：…」）；预览按状态版本缓存（有待决事件时会在状态副本上推演一遍）；推进后用 toast 摘要结果，完整记录见消息中心「本回合自动处理」。未用完的训练本来就会在回合结束时按当前焦点自动完成。所以一直点主按钮就能打完整个赛季（TI 转场约 3 秒后自动结束）。多人模式下同一开关让「准备」变为自动准备（协议 `setRoundReady` 的 `auto`，服务器 `multi.setSeatReady(..., { auto: true })` 先自动处理再准备；等待对手时保持「取消自动准备」）。
  - 关闭自动处理时与以前一致：有阻塞时主按钮禁用，小字为「需先处理：…」，并点亮解决阻塞的第一个情境操作。
  - 推进后停留在当前页面（比赛页除外：推进后回到总览）。在比赛页且比赛进行中时操作栏不渲染（比赛页自带 `MatchDock` 底栏）；比赛页停留在结算时只保留主要操作。
- **底栏情境操作**（主按钮两侧，紧凑、不切换页面；`CtxAction` 列表，按回合状态生成）：
  - 休赛 / 观赛回合：`⚔ 训练（剩余次数）`+ 焦点切换气泡、`加练 · 价格`、`训练赛 ▴`（推荐对手气泡，直接约练；本回合已约过的对手显示为禁用的「本回合已约过」）、`训练详情`（展开总览训练卡片）；
  - 赛事回合：`快速模拟本场 vs 对手`、`快速模拟整项赛事`（就近确认）、`进入比赛 · 手动 BP`、`赛事详情`（展开总览赛事卡片）；首发不合法时 `自动排阵`；可出场不足 5 人时 `补齐首发（临时替补）` / `弃权本场`（就近确认）；比赛进行中为 `继续比赛 ▶`；
  - 有阻塞推进的待决事件时：`! 待决事件 n` 徽标，点开气泡直接选择（默认选项标「默认」）。
  - 布局：≥1280px 一行显示；更窄时次要操作收进「更多 ▴」。`BarRow` 按实际宽度测量，某一栏放不下时按 `demote` / `compact` 顺序逐步换成紧凑写法或收进「更多」，不会压住主按钮。新增按钮时给出 `demote` / `compact`；按钮上的绝对定位装饰（如红点）不能超出所在栏，否则测量会误判为放不下。
- **总览内嵌卡片（不弹窗）**：训练（`TrainingModal.tsx` 的 `TrainingCard`）与赛事（`TournamentModal.tsx` 的 `TournamentCard`）是总览「本回合」中可原地展开 / 收起的卡片。展开状态 = `store.trainingOpen / tournamentOpen`；任何页面调用 `setTrainingOpen(true) / setTournamentOpen(true)` 都会回到总览、展开并滚动到卡片（`store.cardFocus`）。赛事回合开始时赛事卡片自动展开（本方仍有比赛要打，`store.syncTournamentCard` + `TourModalLogic`），回合内由玩家决定；卡片内：进入比赛 → 比赛页（BP → 大老师胜率 → 文字直播 → 赛果）→ 返回总览，卡片自动显示下一场；也可「快速模拟本场 / 本赛事」。只有查看完整分组与对阵图时才进入「赛事 › 赛事中心」。
- **回合通知**（`PopupHost.tsx`）：`game.popups`（赛事结算、赛季总结、版本更新、新秀选秀结果（只在选秀开启或旧存档出现，按需加载）、消息）不再弹窗——总览顶部为「通知」卡片（`NoticesCard`，最新在前、点击原处展开、「全部已读」= `callSilent('dismissPopups', n)`），其他页面在左下角（侧栏底部）显示徽标（`NoticeBadge`，点击回总览）。只有游戏结束（生涯总结）界面仍逐条弹窗（默认导出 `PopupHost`）。
- **转会报价弹窗**（`src/ui/components/MarketBidModal.tsx`，选手交易 2026-10-14）：默认纯现金（`bidForPlayer`）；「加入本队选手抵价」区块勾选本队正式队员后改为 `call('tradeForPlayer', 目标, 现金, 抵价 id[])`。
  估值、说明、拒收原因、对方可接收人数、总额与接受概率一律来自引擎只读函数 `tradeValuation`（候选逐人单独估值）/ `tradeQuote`（已选组合 + 现金，与实际成交同一函数），界面不复算系数；
  不能抵价的候选禁用并用 `title` 说明；有抵价选手时现金滑块下限为 0；对方因阵容超员要放走的替补（`tradeQuote().releases`）写在合计框下与确认气泡里；
  提交交易用 `ConfirmButton`（送出选手不可撤销）。谈判结果（本回合已拒绝的总额 / 选手婉拒）记在 `MarketKit` 的模块级 Map 中，
  记录后要手动触发一次重渲染（store 的 `version++` 发生在 `call` 的 Promise 回调之前）。
  入口有两个且行为一致：转会市场 → 转会求购的「报价」，以及选手详情弹窗（`PlayerModal` 的 `BidActions`）的「报价求购…」。后者在弹窗里再开弹窗，
  须用 `createPortal(…, document.body)` 挂载（弹窗容器的 `fade-up` 动画带 transform，fixed 子元素会被限制在容器内）。
- **弹窗叠放**：`Modal` 维护打开顺序，Esc 只关闭最上层的一个；点击遮罩只关闭被点的那一层（portal 里的事件沿 React 树冒泡到外层弹窗面板时被其 `stopPropagation` 挡住）。
- **二次确认**：一律用按钮旁的确认气泡（`src/ui/components/ConfirmPopover.tsx`），不用 Modal、不用 `window.confirm`：
  - 按钮直接写 `<ConfirmButton confirm={{ title?, message, confirmLabel?, danger? }} onConfirm={() => call(...)}>…</ConfirmButton>`（`confirm` 为 null 时直接执行，适合「只有某些情况才需确认」，如没有现任教练时签约教练不确认、替换才确认）；非按钮触发元素用 `useConfirmPopover()` + `<ConfirmPopover>`。
  - 气泡优先出现在按钮上方，「确定」按钮落在原按钮附近，减少鼠标移动；Enter 确定，Esc / 点击外部取消；危险操作（解约、弃权、踢人）用 `danger`。
  - 底栏「更多」菜单里的确认项用 `MenuConfirm`（确认后收起菜单）。
- **TI 转场**（第八波，`src/ui/components/TiTransition.tsx` + 纯函数 `src/ui/tiTheme.ts`）：进入 TI 正赛回合播放全屏转场（不朽之盾升起 → 发光 → 消失，约 3.2 秒，点击 / 空格跳过，减少动态效果时只淡入淡出）；TI 预选回合为顶部横幅（回合开始即出现；回合通知是总览内的卡片，不再挡住它）；TI 正赛回合顶栏 / 底栏点缀该届主题色（`tis.json` 的 `theme`）。由 store 的 `syncTiIntro` 在任何状态变化后检查，每个存档 × 座位 × 届次只触发一次（「已看过」记在 localStorage `d2m:tiIntroSeen`）；页面在后台时等回到页面再播放。只读，不修改游戏状态，多人模式下每个座位的客户端各自触发。
  - 冠军盾（第十波 #7）：`AegisSvg` 为重新绘制的**原创**矢量图（圆盾 · 24 瓣扇贝雕纹盾缘 · 铆钉与叶纹 · 四道棱脊与卷草纹 · 中央凸台 + 八角刻面主宝石），银灰金属底按该届主题着色；不得描摹或加入官方冠军盾图片。`AegisArt` = 本地覆盖图片优先（见下「本地美术覆盖」），否则 `AegisSvg`。
  - 顶栏徽记 `TiAegisBadge`（TI 预选与 TI 正赛回合）：单机在顶栏绝对居中（≥ lg 显示），多人排在玩家条之前；主题色光晕；点击在下方展开小气泡（portal 到 body，点击外部 / Esc 收起）：「The International {年份}」、城市与主题、当前阶段、本队参赛情况。
- **队徽**（第十波 #4，`src/ui/components/TeamEmblem.tsx` + 纯函数 `src/ui/emblem.ts`）：`TeamTag` 的色块换成按「简称 + 品牌配色」确定性生成的原创风格化队徽（外形 / 装饰纹由简称哈希决定，首字母取自简称，辅色取 `branding.json` 的 `color2` 或由主色推导；默认尺寸 1.3em 随文字缩放）。换品牌（简称 / 配色变化）后自然换成新队徽。战队名旁的色块同样换成 `TeamEmblem`（赛事对阵 / 赛程的 `TourShared.TeamName`（待定席位仍为灰色色块）、总览积分榜、转会市场三处战队单元格、BP 顺序、新秀选秀、世界动态战队标签、战队弹窗标题、DotaPedia 战队页标题 28px、新游戏确认页 48px、多人新建俱乐部预览 48px）；赛区 / 图表配色与新闻滚动条的小圆点不属于队徽，保持色块。新增展示战队的地方优先用 `TeamTag` / `TeamEmblem`，不要再写纯色块。真实队标属于商标，不得加入仓库。`TeamTag` 新增可选 `teamId`（用于本地队标）；未传时只有放了本地队标才按「简称 + 主色」在当前存档里反查 id（每个状态版本建一次索引）。DotaPedia 战队信息框的「品牌沿革」行 = `TeamBrandHistoryRow`（本局无品牌变化时不显示）。
- **背景音乐**（第十波 #6，`src/ui/components/MusicControl.tsx` + 播放器 `src/ui/audio/bgm.ts`）：顶栏「荣誉」右侧的音符按钮（非游戏界面没有顶栏，固定在角落：主菜单与生涯总结在右上角；新游戏 / 大厅 / 房间的右上角有返回按钮或玩家名，改在右下角，面板向上展开），点击在按钮下方（放不下时上方）展开小面板（portal 到 body，点击外部 / Esc 收起）：开关、音量滑块、音源（内置原创氛围音乐 / 本地文件）、选择 / 更换 / 移除本地文件（移除用确认气泡）。设置按浏览器记在 localStorage `d2m:bgm`，本地文件存在 IndexedDB，不进存档、不经 `call()`。不得加入任何 Valve 音频。
- **更新说明与 New 徽标**（2026-10-14，`src/ui/components/ChangelogPanel.tsx` + `NewBadge.tsx`，数据与纯函数 `src/ui/changelog.ts`）：两个入口打开同一个面板——游戏内顶栏右上角（音乐按钮左侧，单机 / 多人同一位置）的版本芯片 `<ChangelogButton />`（≥ sm 显示 `v{APP_VERSION}`，< sm 显示「更新」二字），以及主菜单页脚的版本号 `<ChangelogButton variant="footer" />`（与页脚文字同字号，悬停变金色）。版本号由 `vite.config.ts` 的 `define` 注入 package.json 的 `version`（全局 `__APP_VERSION__`，声明在 `src/vite-env.d.ts`），代码里只读 `changelog.ts` 的 `APP_VERSION`，不要写死版本号。有未读新版本时两个入口都带红点；点击打开 Modal「更新说明」（`max-w-lg`，属于内容面板，不是本回合事务）：按版本倒序列出 `CHANGELOG`（版本、日期、条目），当前版本置顶展开、旧版本折叠可展开，带 `feature` 的条目附「入口：…」。底部「标为已读」把最新版本记为已读（`d2m:changelog:seen`），红点与全部 New 徽标一起消失。**打开面板不自动算已读**：徽标的作用是引导玩家在界面里找到新功能，一打开面板就全部消失徽标就没有意义；红点则提醒玩家还没确认过这个版本。
  - `NewBadge`：小号金色描边、深色底的「New」（放在金色按钮里也能看清）。放在入口元素**内部**，默认 `dismissOn="click"`——点击徽标的父元素（按钮 / 标签）后消失，适合按钮、`HubShell` 标签的 `badge`；非可点击入口用 `dismissOn="view"`——在屏幕上连续可见约 1 秒算「看过」，离开页面 / 关闭弹窗后不再显示（卡片标题、章节标题、表头、详情行标签）；自定义时机用 `useNewFeature(key)` 的 `{ show, dismiss }`。顶栏这类放不下的地方加 `narrow="corner"`：< sm 时改为父元素右上角的角标、不占行内宽度（父元素需 `relative`，如顶栏音乐按钮）。显示条件 = 功能所属版本高于已读版本且 key 不在 `d2m:newbadge:dismissed` 中（纯函数 `featureIsNew`）。当前接入：v0.3.0——转会报价弹窗「加入本队选手抵价」（`trade`，`dismissOn="none"`，展开 / 收起抵价列表时经 `useNewFeature` 关闭）、总览「赛事报名」卡片标题（`seasonEntry`，同样在展开 / 收起卡片时关闭）、阵容页统计格「荣誉势头」（`momentum`，`view`；`Stat` 标签是大写样式，徽标加 `normal-case`）、「转会 › 新秀抽卡」标签（`gacha`，与原有的状态徽标并列）、「DotaPedia › 名人堂」标签（`hallOfFame`）、多人大厅「服务器」卡片的在线人数行（`onlineStats`，`view`，经 `ServerStatsLine` 的 `badge`）；v0.2.1 / v0.2——阵容页「位置」表头与选手详情「位置」行（`altPositions`）、选手详情「挂牌出售」与阵容页「批量挂牌」（`listing`）、DotaPedia「羁绊图鉴」标签（`synergies`）、战队词条「使命」章节（`missions`）、顶栏音乐按钮（`bgm`）、财务「选手奖金分成」卡片（`prizeShare`）。
  - **给新功能加 New 徽标（接入步骤）**：
    1. 在 `src/ui/changelog.ts` 的 `FEATURES` **顶部**加一条 `{ key: 'myFeature', version: '0.3.0', label: '俱乐部 › 财务的「某某」' }`：`key` 为稳定的英文标识（发布后不要改名，localStorage 记录的就是它）；`version` = 该功能首次发布的版本；`label` = 面向玩家的入口位置说明（面板里显示为「入口：…」）。`FeatureKey` 类型由 `FEATURES` 自动推导，`<NewBadge feature>` 写错 key 时 `tsc` 会报错。
    2. 在 `CHANGELOG` 中该版本的条目里引用它：`{ text: '……', feature: 'myFeature' }`。该版本条目还不存在时按发版约定一并添加（AGENTS.md「提交」：版本条目加在 `CHANGELOG` 顶部，最新版本必须等于 package.json 的 `version`）。
    3. 在入口元素内部放徽标：`<Button …>某某 <NewBadge feature="myFeature" /></Button>`；非可点击入口 `<h3>某某 <NewBadge feature="myFeature" dismissOn="view" /></h3>`；顶栏等窄处再加 `narrow="corner"`（父元素 `relative`）。
    4. 运行 `npx vitest run tests/changelog.test.ts`：校验 key 唯一、功能版本存在于更新说明、每个功能都被所属版本的条目引用、条目引用的功能版本一致。
    不需要改其他文件：面板、红点、已读、徽标消失逻辑都是通用的。
  - 状态按浏览器存 localStorage（读写都 try/catch，其他标签页的改动经 `storage` 事件同步），不进存档、不经 `call()`，多人模式每个客户端各自记录。发版约定见 AGENTS.md「提交」；`tests/changelog.test.ts` 校验数据合法性与「最新版本 = package.json version」。
- **顶栏的窄屏布局**（`src/ui/layout/TopBar.tsx`，375px 起不溢出）：俱乐部按钮（「回到总览」）`shrink-0`，不被挤压；< sm 时隐藏 D2 标志（简称 + 队徽即按钮）；俱乐部全名单机 ≥ sm、多人 ≥ xl 才显示，过长时截断（完整名称在悬停提示里）。右侧金币 / 荣誉 / 版本芯片 / 音乐 / 存档不换行，< sm 时间距收紧、版本芯片显示「更新」、音乐按钮的 New 徽标改为角标。多人 < lg（1024px）时玩家条与「聊天 / 离开」移到顶栏第二行（玩家条横向滚动），第一行与单机相同；聊天面板按顶栏实际高度贴在其下方。第一行的 `overflow-x-auto`（隐藏滚动条）只是兜底：超长简称 + 320px 这类极端情况下该行横向滚动，而不是撑破页面。新增顶栏项时在 375px（单机与多人）下量一遍：`header` 内各行的 `scrollWidth` 应等于 `clientWidth`。
- **赛季中报名 / 退赛与补充邀请**（第十四波，`src/ui/components/TourEntry.tsx` + `EntryPlanCard.tsx`）：
  - 报名状态标签与按钮统一由 `entryControls` 生成（赛程页回合表、赛事中心头部、总览「赛事报名」卡片共用）。「婉拒 / 取消报名」读取引擎只读查询 `withdrawPenaltyOf(game, id)`：
    要扣荣誉时按钮文字带扣分（如「婉拒 −20」），点击弹出就近确认气泡（`ConfirmButton`，写明扣分、原因与「当前荣誉 → 扣后」），确定按钮为「婉拒（荣誉 −20）」；
    同一回合内反悔 / 赛季初调整等不扣荣誉时直接执行（`confirm = null`），悬停说明原因；扣分后荣誉会跌破 0 时按钮禁用，`title` 说明原因。
    扣分的确认气泡、成功提示与「重新接受 / 重新报名」按钮的说明都写明「重新接受不会退还已扣的荣誉」。
    补充邀请的标签为「补充邀请·已接受 / 已婉拒」（悬停写明收到的回合）；在受邀名单里、但同回合已有别的安排而未参加的邀请（多为自动让出的）标为「同回合冲突·未参加」（悬停写明冲突的赛事），不写「已婉拒」。
  - 总览「赛事报名」卡片（`EntryPlanCard`，位于「待处理」之后）：标题行汇总本赛季未开赛的常规赛事「参赛 N（受邀 a · 自行报名 b）· 可报名 c」，
    「可报名」只计现在真能报名 / 重新接受的（`entryControls().canEnter`：同回合已有安排而按钮禁用的不算），默认收起；
    本回合收到补充邀请时自动展开、金色描边并提示「本回合内婉拒不扣荣誉」。展开后可切换「我的安排 / 全部未开赛」，每行 = 回合 · 赛事（点击进入赛事中心）· 等级 · 状态标签 · 操作按钮；
    未解锁的赛事显示原因（荣誉不足 / 赛区不符）。规则说明由 `CONFIG.honor.withdraw*` 与 `CONFIG.tournament.lateInvite` 生成，不在界面写死数值。
  - 补充邀请同时进总览「通知」（`message`，引擎推送）与新闻「【补充邀请】…」（多人模式座位私有）。
- **荣誉势头**（第十四波，`src/ui/components/MomentumBadge.tsx`，数据 `engine/momentum.ts` 的只读查询 `teamMomentumView`）：标签强势 / 向好 / 平稳 / 走低 / 低迷（绿 / 灰 / 红），
  悬停为同比（上季初 → 本季初荣誉、赛季状态均值平移）与环比（战队评分乘子）的说明。阵容页统计格「荣誉」「荣誉势头」（`md` 起 4 列）、战队详情标题行、总览俱乐部卡片「战队评分」角标。
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

- **新秀抽卡**（2026-10-14 取代选秀；「转会 › 新秀抽卡」，`src/ui/screens/Gacha.tsx`（`TransferHub` 按需加载，不进主包），只读 `gachaView / gachaLog / gachaPullBlock / gachaDiscardBlock / gachaHistory`）：
  顶部四格（卡池剩余 / 价格 / SSR 保底进度 / 本赛季已抽）；「抽卡」卡片右上角为单抽 / 十连的 `ConfirmButton`（按钮文字带价格，禁用时 `title` 为 `gachaPullBlock` 的原因：窗口锁定 / 金币不足 / 已超编；
  阵容人数不禁用十连——总是抽满，抽完会超过绝对上限时确认气泡用红字写明「抽完后阵容 15/12 人，超编 3 人：抽完后需在本回合内退回 12 人……」（`gachaOverCapAfter`；
  开启自动处理时另写明「按下一回合会自动退回本回合抽到的新秀中评分最低的 N 名（不论等级）」），按钮 `title` 同样注明），
  超编时页面顶部为红色横幅「超编 N 人」（`rosterOverCapNotice`：本回合内放弃新秀或解约，退回 12 人后才能进入下一回合；开启自动处理时说明按下一回合会先自动退回评分最低的新秀；按钮「去阵容页解约」；
  与推进阻塞同口径，只在转会窗口开放时显示——锁定期（旧选秀 / 旧存档超过 12 人）改为显示常规上限的蓝色提示）；
  超编是推进阻塞（`roster_over_cap`）：总览「待处理」第一行红色项（收起时标题行也显示）、底栏情境按钮「处理超编 · N 人」（打开抽卡页；放不下时先换成「超编 N 人」，再收进「更多」：
  `compact` 1.8 / `demote` 2.7），懒人模式下底栏提示改为「超编 N 人：将自动退回新秀 …（返还 …）」；
  卡片内是本回合的结果（`ResultTile`：等级大徽章 + 等级配色、真实 / 请神徽章 `GachaKindBadge`（请神显示原型 ID）、退回按钮——同一回合内可退回，返还比例取 CONFIG）；
  退回的确认文案由 `src/ui/components/gachaDiscard.tsx` 的 `gachaDiscardConfirm` 生成，抽卡页与选手详情共用（「退回 / 保留」）。
  「卡池构成」表（各等级 真实 / 请神 / 虚构 / 剩余 / 下一抽概率 / 本季入池（真/请/虚）——入池张数，不是已抽出的张数）与剩余真实新秀、请神原型（有 DotaPedia 词条的可点击打开，
  没有词条的 DotA1 传奇只显示文字，与名人堂页一致）；第 1 回合后真实新秀已离池时注明「之后只有请神与虚构新秀」；本赛季抽卡记录；规则（概率与数值全部取自 CONFIG，不要写死；
  含工资上限、转售冷却、真实新秀只在赛季初可抽、AI 资金不足时可能不抽）；往届汇总。从总览 / 侧栏直接进入本页时同样清掉「新秀抽卡」标签的 New 徽标。
  转售冷却期内的新秀：选手详情「挂牌出售」按钮禁用（`title` 为 `gachaResaleLockText`，写明还差几个转会回合），阵容页批量挂牌跳过并在按钮说明里列出；报价弹窗的抵价说明写明按签字费估值。
  真实出道新秀的「签下 / 放弃」是普通的待决事件（`kind: 'rookie_home'`，标签「真实新秀」），在消息中心与底栏「待决事件」里处理。
  卡种配色：真实新秀用金色（`bg-gold/15 text-gold`），请神用紫色（`#7a4fb5` / `#c39cff`），与等级色区分。选手详情：标题行有「TI{n} 抽卡 · 等级」「请神 · 原型」小标签，
  本回合抽到的新秀在「经理操作」里显示「退回新秀」（代替解约）。总览「赛季初 · 备战期」的入口按钮与「待处理」的「本回合抽到的新秀」、侧栏「转会」的「新秀」徽标都跳到这里（`setView('gacha')`）。
  「新秀选秀」标签只在 `CONFIG.draft.enabled` 或旧存档有选秀记录时显示（`RookieDraft` 页按需加载）。
- **DotaPedia · 名人堂**（标签键 `pediaHall`，`src/ui/screens/PediaHallOfFame.tsx`，数据 `hallOfFameRows`）：成员表（来源徽章：「DotA1 时代」金色 /「TI{n} · 真实数据补录」蓝色（开局补录，2026-10-15）/「TI{n} 本局入堂」、
  位置、赛区、出道 / 巅峰等级、能否作为请神原型、在役请神新秀人数（点击展开名单）、本局状态），按来源排序（DotA1 → 补录 → 本局），
  筛选（全部 / DotA1 时代 / 真实数据补录 / 本局入堂 / 可请神 / 有在役请神新秀，文字取 `HOF_SOURCE_LABEL`）+ 搜索 + 分页；统计格「名人堂成员」副标题分三类计数。没有 DotaPedia 词条的成员（如 2009）只显示文字。
  表头「生涯巅峰」与选手页的「名人堂登记：出道 X · 生涯巅峰 Y」是名人堂登记的口径（真实选手按真实历史、只取开局届 / 入选届及之前，在役时随本局等级更新），与信息框中本局的「天梯等级 · 巅峰」不同，悬停说明；
  选手页信息框「名人堂」行与「名人堂与请神」章节的来源文字同样取 `HOF_SOURCE_LABEL`（DotA1 时代 / TI{n} · 真实数据补录 / TI{n} 本局入堂）；统计格的副标题过长时缩写，完整说明在 `title`。
  不在本局选手中的真实选手（如 TI9 起的 BurNIng）词条用真实选手索引 / 名人堂登记的显示 ID、国籍、出生年份（`pediaPlayerPage` 的 `birthYear`）。
  选手词条有「名人堂与请神」章节与信息框的「抽卡出身 / 请神原型 / 名人堂」行（`pediaPlayerPage` 的 `gacha / summon / hallOfFame`）。
- **报价弹窗的接受概率**（`MarketBidModal`）：交易模式下只有对方拒收抵价选手 / 已拒绝此价位时显示 0%；只是现金不够（或对方负担不起抵价选手工资，可调整现金解决）时仍按总额估算，
  阻塞原因另在横幅里说明。纯现金报价金币不足时，横幅提示「可展开下方「加入本队选手抵价」，用本队选手抵价减少现金」。
- **多人大厅 / 房间顶栏的窄屏**（375px）：大厅的「‹ 主菜单」、标题、连接状态 `shrink-0 whitespace-nowrap`，服务器名与「玩家」字样 < sm 隐藏；房间页「‹ 离开房间」< sm 为「‹ 离开」、
  房间码字距收窄（`tracking-[0.08em]`，≥ sm 0.25em）。公网服务器（`serverMode === 'public'`）不显示 `?as=` 多开测试提示。主菜单网格用 `minmax(0,1fr)` 列（截断的长说明不撑宽列）。

## 本地美术覆盖（`public/local/`，第十波 #4 / #7）
真实队标与官方冠军盾图片属于商标 / 版权美术，**不得提交到仓库**；界面默认使用原创生成的队徽与矢量冠军盾。用户可在本机放入自己的图片覆盖显示（目录被 `.gitignore` 忽略，只提交 `public/local/README.txt` 使用说明）：
- `public/local/logos/{战队 id}.png|svg|webp`：队标；`{战队 id}.{简称}`（简称去标点、小写，如 `lgd-gaming.psglgd.png`）可为某个品牌时期单独指定，优先于 `{战队 id}`。
- `public/local/aegis.png|svg|webp`：冠军盾（TI 转场、预选横幅、顶栏徽记）。
- 实现（`src/ui/localArt.ts`）：文件列表由 `import.meta.glob` 在开发服务器启动 / 构建时枚举（只取文件名，从不导入内容），运行时不做探测请求——没有文件就不发请求、控制台没有 404；放入或删除文件后重新运行 `npm run dev` / `npm run mp`。图片加载失败时记下地址并回退到生成图案，不再重复请求。

# UI 开发规范

## 技术约定
- React 19 + Tailwind v4（主题 token 见 `src/index.css` 的 `@theme`：`bg panel panel-2 panel-3 line ink mute faint dota dota-2 gold radiant dire good bad info tier-*`）。
- 通用组件统一从 `src/ui/components/common.tsx` 引入：`Button Card PageHeader EmptyState Stat Badge TierBadge PosBadge RegionBadge StatBar AttrRow Gold Delta PlayerLink TeamLink TeamTag Tabs Modal TableScroll Hint cx`（手机适配的约定见文末「手机适配」）。**不要重复造轮子**，确需新的通用组件时在自己负责的文件内实现。
- 状态：
  - 读：`const game = useGame()`（任何引擎操作后自动重渲染）。
  - 写：`const call = useCall(); call('someOp', ...args)`（引擎函数名 + 除 state 外的参数，类型由引擎签名推导）。单机在本地执行并自动存档；多人模式作为白名单 RPC（`src/shared/protocol.ts` RPC_WHITELIST）发给服务器。返回 `Promise`，需要结果时 `.then(res => …)`；返回 `OpResult` 时自动 toast 提示；成功时不提示用 `useCallSilent()`。
- **提示（toast）**（v0.4.1，用户要求）：单机 `ToastHost` 与多人 `MpToastHost` 都显示在顶栏下方（不遮挡底部操作栏）；界面上同时最多 `TOAST_MAX_VISIBLE`（2）条（操作提示 + 多人快讯合计，按出现顺序排列），新的一条出现时最早的一条提前渐隐（`.toast-out`，`TOAST_FADE_MS`），玩家点开全文留住的提示最后才让位。停留时长：成功 3.5 秒、失败 6 秒、快讯 6.5 秒；点按即渐隐关闭。
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
  - 布局：≥1280px 一行显示；更窄时次要操作收进「更多 ▴」。`BarRow` 按实际宽度测量，某一栏放不下时按 `demote` / `compact` 顺序逐步换成紧凑写法或收进「更多」，不会压住主按钮。新增按钮时给出 `demote` / `compact`（v0.4 起左侧每个操作都有 `demote`，测量总能收敛；收进「更多」时用 `menu` 写法，不要在「更多」里再嵌套第二个气泡）；按钮上的绝对定位装饰（如红点）不能超出所在栏，否则测量会误判为放不下。主按钮 `relative z-10`：万一两侧溢出也只会被主按钮盖住。
  - 手机（< 640px）不用 `BarRow`，改为 `PhoneBar` 三行布局；sm–lg 之间在操作行上方补一行提示。见下文「手机适配 · 底栏」。
- **总览内嵌卡片（不弹窗）**：训练（`TrainingModal.tsx` 的 `TrainingCard`）与赛事（`TournamentModal.tsx` 的 `TournamentCard`）是总览「本回合」中可原地展开 / 收起的卡片。展开状态 = `store.trainingOpen / tournamentOpen`；任何页面调用 `setTrainingOpen(true) / setTournamentOpen(true)` 都会回到总览、展开并滚动到卡片（`store.cardFocus`）。赛事回合开始时赛事卡片自动展开（本方仍有比赛要打，`store.syncTournamentCard` + `TourModalLogic`），回合内由玩家决定；卡片内：进入比赛 → 比赛页（BP → 大老师胜率 → 文字直播 → 赛果）→ 返回总览，卡片自动显示下一场；也可「快速模拟本场 / 本赛事」。只有查看完整分组与对阵图时才进入「赛事 › 赛事中心」。
- **回合通知**（`PopupHost.tsx`）：`game.popups`（赛事结算、赛季总结、版本更新、新秀选秀结果（只在选秀开启或旧存档出现，按需加载）、消息）不再弹窗——总览顶部为「通知」卡片（`NoticesCard`，最新在前、点击原处展开、「全部已读」= `callSilent('dismissPopups', n)`），其他页面在左下角（侧栏底部）显示徽标（`NoticeBadge`，点击回总览；< md 没有侧栏时不显示，改为顶栏 ☰ 上的蓝点与导航抽屉「总览」上的计数）。只有游戏结束（生涯总结）界面仍逐条弹窗（默认导出 `PopupHost`）。
- **转会报价弹窗**（`src/ui/components/MarketBidModal.tsx`，选手交易 2026-10-14）：默认纯现金（`bidForPlayer`）；「加入本队选手抵价」区块勾选本队正式队员后改为 `call('tradeForPlayer', 目标, 现金, 抵价 id[])`。
  估值、说明、拒收原因、对方可接收人数、总额与接受概率一律来自引擎只读函数 `tradeValuation`（候选逐人单独估值）/ `tradeQuote`（已选组合 + 现金，与实际成交同一函数），界面不复算系数；
  不能抵价的候选禁用并用 `title` 说明；有抵价选手时现金滑块下限为 0；对方因阵容超员要放走的替补（`tradeQuote().releases`）写在合计框下与确认气泡里；
  提交交易用 `ConfirmButton`（送出选手不可撤销）。谈判结果（本回合已拒绝的总额 / 选手婉拒）记在 `MarketKit` 的模块级 Map 中，
  记录后要手动触发一次重渲染（store 的 `version++` 发生在 `call` 的 Promise 回调之前）。
  入口有两个且行为一致：转会市场 → 转会求购的「报价」，以及选手详情弹窗（`PlayerModal` 的 `BidActions`）的「报价求购…」。后者在弹窗里再开弹窗，
  须用 `createPortal(…, document.body)` 挂载（弹窗容器的 `fade-up` 动画带 transform，fixed 子元素会被限制在容器内）。
- **弹窗叠放**：`Modal` 维护打开顺序，Esc 只关闭最上层的一个；点击遮罩只关闭被点的那一层：按下与抬起都落在遮罩本身上才关闭（`pointerdown` 记下是否按在遮罩上 + `click` 时 `target === currentTarget`），
  portal 里的嵌套弹窗冒泡上来的事件 target 不是外层遮罩，不会关闭外层；从面板里拖到遮罩上松开也不关闭。
- **二次确认**：一律用按钮旁的确认气泡（`src/ui/components/ConfirmPopover.tsx`），不用 Modal、不用 `window.confirm`：
  - 按钮直接写 `<ConfirmButton confirm={{ title?, message, confirmLabel?, danger? }} onConfirm={() => call(...)}>…</ConfirmButton>`（`confirm` 为 null 时直接执行，适合「只有某些情况才需确认」，如没有现任教练时签约教练不确认、替换才确认）；非按钮触发元素用 `useConfirmPopover()` + `<ConfirmPopover>`。
  - 气泡优先出现在按钮上方，「确定」按钮落在原按钮附近，减少鼠标移动；Enter 确定，Esc / 点击外部取消；危险操作（解约、弃权、踢人）用 `danger`。
  - 气泡**从不盖住触发按钮**（v0.4）：先在顶栏与底栏之间找上方 / 下方放得下的位置（`--chrome-top / --chrome-bottom`）；两栏之间放不下（横屏矮视口）时可以压住顶栏 / 底栏，
    放在空间较大的一侧并限制高度——标题与正文在气泡内滚动，「确定 / 取消」始终可见；两侧都不到 120px 时才在视口中居中。打开后 350ms 内点按「确定」无效（连点 / 幽灵点击不会直接花钱）。
    小三角指向按钮中心。`ConfirmButton` 的 `wrapClassName` 给外层锚点 span 加类名（手机上让按钮占满一行：`wrapClassName="max-sm:flex-1"` 或在网格单元里配 `className="w-full"`）。
  - 底栏「更多」菜单里的确认项用 `MenuConfirm`（确认后收起菜单）。
- **TI 转场**（第八波，`src/ui/components/TiTransition.tsx` + 纯函数 `src/ui/tiTheme.ts`）：进入 TI 正赛回合播放全屏转场（不朽之盾升起 → 发光 → 消失，约 3.2 秒，点击 / 空格跳过，减少动态效果时只淡入淡出）；TI 预选回合为顶部横幅（回合开始即出现；回合通知是总览内的卡片，不再挡住它）；TI 正赛回合顶栏 / 底栏点缀该届主题色（`tis.json` 的 `theme`）。由 store 的 `syncTiIntro` 在任何状态变化后检查，每个存档 × 座位 × 届次只触发一次（「已看过」记在 localStorage `d2m:tiIntroSeen`）；页面在后台时等回到页面再播放。只读，不修改游戏状态，多人模式下每个座位的客户端各自触发。
  - 冠军盾（第十波 #7）：`AegisSvg` 为重新绘制的**原创**矢量图（圆盾 · 24 瓣扇贝雕纹盾缘 · 铆钉与叶纹 · 四道棱脊与卷草纹 · 中央凸台 + 八角刻面主宝石），银灰金属底按该届主题着色；不得描摹或加入官方冠军盾图片。`AegisArt` = 本地覆盖图片优先（见下「本地美术覆盖」），否则 `AegisSvg`。
  - 顶栏徽记 `TiAegisBadge`（TI 预选与 TI 正赛回合）：单机在顶栏绝对居中（≥ lg 显示），多人排在玩家条之前；主题色光晕；点击在下方展开小气泡（portal 到 body，点击外部 / Esc 收起）：「The International {年份}」、城市与主题、当前阶段、本队参赛情况。
- **队徽**（第十波 #4，`src/ui/components/TeamEmblem.tsx` + 纯函数 `src/ui/emblem.ts`）：`TeamTag` 的色块换成按「简称 + 品牌配色」确定性生成的原创风格化队徽（外形 / 装饰纹由简称哈希决定，首字母取自简称，辅色取 `branding.json` 的 `color2` 或由主色推导；默认尺寸 1.3em 随文字缩放）。换品牌（简称 / 配色变化）后自然换成新队徽。战队名旁的色块同样换成 `TeamEmblem`（赛事对阵 / 赛程的 `TourShared.TeamName`（待定席位仍为灰色色块）、总览积分榜、转会市场三处战队单元格、BP 顺序、新秀选秀、世界动态战队标签、战队弹窗标题、DotaPedia 战队页标题 28px、新游戏确认页 48px、多人新建俱乐部预览 48px）；赛区 / 图表配色与新闻滚动条的小圆点不属于队徽，保持色块。新增展示战队的地方优先用 `TeamTag` / `TeamEmblem`，不要再写纯色块。真实队标属于商标，不得加入仓库。`TeamTag` 新增可选 `teamId`（用于本地队标）；未传时只有放了本地队标才按「简称 + 主色」在当前存档里反查 id（每个状态版本建一次索引）。DotaPedia 战队信息框的「品牌沿革」行 = `TeamBrandHistoryRow`（本局无品牌变化时不显示）。
- **背景音乐**（第十波 #6，`src/ui/components/MusicControl.tsx` + 播放器 `src/ui/audio/bgm.ts`）：顶栏「荣誉」右侧的音符按钮（非游戏界面没有顶栏，固定在角落：主菜单与生涯总结在右上角；新游戏 / 大厅 / 房间的右上角有返回按钮或玩家名，改在右下角，面板向上展开；手机上的生涯总结用 `floating="inline"` 放在横幅右上角、随页面滚走，不压住排行表），点击在按钮下方（放不下时上方）展开小面板（portal 到 body，点击外部 / Esc 收起）：开关、音量滑块、音源（内置原创氛围音乐 / 本地文件）、选择 / 更换 / 移除本地文件（移除用确认气泡）。设置按浏览器记在 localStorage `d2m:bgm`，本地文件存在 IndexedDB，不进存档、不经 `call()`。不得加入任何 Valve 音频。
- **更新说明与 New 徽标**（2026-10-14，`src/ui/components/ChangelogPanel.tsx` + `NewBadge.tsx`，数据与纯函数 `src/ui/changelog.ts`）：两个入口打开同一个面板——游戏内顶栏右上角（音乐按钮左侧，单机 / 多人同一位置）的版本芯片 `<ChangelogButton />`（≥ sm 显示 `v{APP_VERSION}`，< sm 显示「更新」二字），以及主菜单页脚的版本号 `<ChangelogButton variant="footer" />`（与页脚文字同字号，悬停变金色）。版本号由 `vite.config.ts` 的 `define` 注入 package.json 的 `version`（全局 `__APP_VERSION__`，声明在 `src/vite-env.d.ts`），代码里只读 `changelog.ts` 的 `APP_VERSION`，不要写死版本号。有未读新版本时两个入口都带红点；点击打开 Modal「更新说明」（`max-w-lg`，属于内容面板，不是本回合事务）：按版本倒序列出 `CHANGELOG`（版本、日期、条目），当前版本置顶展开、旧版本折叠可展开，带 `feature` 的条目附「入口：…」。底部「标为已读」把最新版本记为已读（`d2m:changelog:seen`），红点与全部 New 徽标一起消失。**打开面板不自动算已读**：徽标的作用是引导玩家在界面里找到新功能，一打开面板就全部消失徽标就没有意义；红点则提醒玩家还没确认过这个版本。
  - `NewBadge`：小号金色描边、深色底的「New」（放在金色按钮里也能看清）。放在入口元素**内部**，默认 `dismissOn="click"`——点击徽标的父元素（按钮 / 标签）后消失，适合按钮、`HubShell` 标签的 `badge`；非可点击入口用 `dismissOn="view"`——在屏幕上连续可见约 1 秒算「看过」，离开页面 / 关闭弹窗后不再显示（卡片标题、章节标题、表头、详情行标签）；自定义时机用 `useNewFeature(key)` 的 `{ show, dismiss }`。顶栏这类放不下的地方加 `narrow="corner"`：< sm 时改为父元素右上角的角标、不占行内宽度（父元素需 `relative`，如顶栏音乐按钮）。显示条件 = 功能所属版本高于已读版本且 key 不在 `d2m:newbadge:dismissed` 中（纯函数 `featureIsNew`）。当前接入：v0.3.0——转会报价弹窗「加入本队选手抵价」（`trade`，`dismissOn="none"`，展开 / 收起抵价列表时经 `useNewFeature` 关闭）、总览「赛事报名」卡片标题（`seasonEntry`，同样在展开 / 收起卡片时关闭）、阵容页统计格「荣誉势头」（`momentum`，`view`；`Stat` 标签是大写样式，徽标加 `normal-case`）、「转会 › 新秀抽卡」标签（`gacha`，与原有的状态徽标并列）、「DotaPedia › 名人堂」标签（`hallOfFame`）、多人大厅「服务器」卡片的在线人数行（`onlineStats`，`view`，经 `ServerStatsLine` 的 `badge`）；v0.2.1 / v0.2——阵容页「位置」表头与选手详情「位置」行（`altPositions`）、选手详情「挂牌出售」与阵容页「批量挂牌」（`listing`）、DotaPedia「羁绊图鉴」标签（`synergies`）、战队词条「使命」章节（`missions`）、顶栏音乐按钮（`bgm`）、财务「选手奖金分成」卡片（`prizeShare`）。v0.4.0 没有新增徽标：手机适配是全局改动（导航抽屉、底栏、弹窗、表格），没有单一入口可标，更新说明里按「手机适配 · …」分条写明。
  - **给新功能加 New 徽标（接入步骤）**：
    1. 在 `src/ui/changelog.ts` 的 `FEATURES` **顶部**加一条 `{ key: 'myFeature', version: '0.3.0', label: '俱乐部 › 财务的「某某」' }`：`key` 为稳定的英文标识（发布后不要改名，localStorage 记录的就是它）；`version` = 该功能首次发布的版本；`label` = 面向玩家的入口位置说明（面板里显示为「入口：…」）。`FeatureKey` 类型由 `FEATURES` 自动推导，`<NewBadge feature>` 写错 key 时 `tsc` 会报错。
    2. 在 `CHANGELOG` 中该版本的条目里引用它：`{ text: '……', feature: 'myFeature' }`。该版本条目还不存在时按发版约定一并添加（AGENTS.md「提交」：版本条目加在 `CHANGELOG` 顶部，最新版本必须等于 package.json 的 `version`）。
    3. 在入口元素内部放徽标：`<Button …>某某 <NewBadge feature="myFeature" /></Button>`；非可点击入口 `<h3>某某 <NewBadge feature="myFeature" dismissOn="view" /></h3>`；顶栏等窄处再加 `narrow="corner"`（父元素 `relative`）。
    4. 运行 `npx vitest run tests/changelog.test.ts`：校验 key 唯一、功能版本存在于更新说明、每个功能都被所属版本的条目引用、条目引用的功能版本一致。
    不需要改其他文件：面板、红点、已读、徽标消失逻辑都是通用的。
  - 状态按浏览器存 localStorage（读写都 try/catch，其他标签页的改动经 `storage` 事件同步），不进存档、不经 `call()`，多人模式每个客户端各自记录。发版约定见 AGENTS.md「提交」；`tests/changelog.test.ts` 校验数据合法性与「最新版本 = package.json version」。
- **顶栏的窄屏布局**（`src/ui/layout/TopBar.tsx`，375px 起不溢出）：俱乐部按钮（「回到总览」）`shrink-0`，不被挤压；< sm 时隐藏 D2 标志（简称 + 队徽即按钮）；俱乐部全名单机 ≥ sm、多人 ≥ xl 才显示，过长时截断（完整名称在悬停提示里）。右侧金币 / 荣誉 / 版本芯片 / 音乐 / 存档不换行，< sm 时间距收紧、音乐按钮的 New 徽标改为角标，版本芯片与「存档」收进导航抽屉底部（v0.4，见「手机适配 · 导航」）。多人 < lg（1024px）时玩家条与「聊天 / 离开」移到顶栏第二行（玩家条横向滚动），第一行与单机相同；聊天面板按顶栏实际高度贴在其下方。第一行的 `overflow-x-auto`（隐藏滚动条）只是兜底：超长简称 + 320px 这类极端情况下该行横向滚动，而不是撑破页面。新增顶栏项时在 375px（单机与多人）下量一遍：`header` 内各行的 `scrollWidth` 应等于 `clientWidth`。
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
  阵容人数不禁用十连——总是抽满，抽完会超过绝对上限时确认气泡用红字写明「抽完后阵容 15/12 人，超编 3 人：需在本回合内放弃本回合抽到的新秀或解约 3 人（降到 12 人以内）……」（`gachaOverCapAfter`；
  开启自动处理时另写明「按下一回合会自动退回本回合抽到的新秀中评分最低的 N 名（不论等级）」），按钮 `title` 同样注明），
  超编时页面顶部为红色横幅「超编 N 人」（`rosterOverCapNotice`：「超编 3 人：本回合内放弃新秀或解约 3 人（降到 12 人以内）后才能进入下一回合」——写明要退回几个人、降到多少，v0.4 起不再写成容易误读的「退回 12 人」；开启自动处理时说明按下一回合会先自动退回评分最低的新秀；按钮「去阵容页解约」；
  与推进阻塞同口径，只在转会窗口开放时显示——锁定期（旧选秀 / 旧存档超过 12 人）改为显示常规上限的蓝色提示）；
  超编是推进阻塞（`roster_over_cap`）：总览「待处理」第一行红色项（收起时标题行也显示）、底栏情境按钮「处理超编 · N 人」（打开抽卡页；已在抽卡页时经窗口事件 `GACHA_FOCUS_EVENT`（`gachaDiscard.tsx`）把「抽卡」卡片 / 页面顶部滚到眼前；放不下时先换成「退回 N 人」（手机操作条同样用这个带动词的写法），再收进「更多」：
  `compact` 1.8 / `demote` 2.7），懒人模式下底栏提示改为「超编 N 人：将自动退回新秀 …（返还 …）」；
  卡片内是本回合的结果（`ResultTile`：等级大徽章 + 等级配色、真实 / 请神徽章 `GachaKindBadge`（请神显示原型 ID）、退回按钮——同一回合内可退回，返还比例取 CONFIG）；
  退回的确认文案由 `src/ui/components/gachaDiscard.tsx` 的 `gachaDiscardConfirm` 生成，抽卡页与选手详情共用（「退回 / 保留」）。
  「卡池构成」表（各等级 真实 / 请神 / 虚构 / 剩余 / 下一抽概率 / 本季入池（真/请/虚）——入池张数，不是已抽出的张数）与剩余真实新秀、请神原型（有 DotaPedia 词条的可点击打开，
  没有词条的 DotA1 传奇只显示文字，与名人堂页一致）；第 1 回合后真实新秀已离池时注明「之后只有请神与虚构新秀」；本赛季抽卡记录；规则（概率与数值全部取自 CONFIG，不要写死；
  含工资上限、转售冷却、真实新秀只在赛季初可抽、AI 资金不足时可能不抽）；往届汇总。从总览 / 侧栏直接进入本页时同样清掉「新秀抽卡」标签的 New 徽标。
  手机（< sm）与横屏矮视口（max-height 480px）的顺序（v0.4）：标题 → 卡池关闭 / 超编横幅 → 「抽卡」卡片（单抽 / 十连为卡片内两个通栏大按钮，下方一行写卡池剩余、保底与资金）→ 四格（手机上只显示数字）→ 卡池 → 记录 → 规则 → 往届；
  抽卡成功后把「抽卡」卡片滚到顶部（超编横幅会把结果往下推）。手机上结果为两列紧凑卡片（等级 + 名字 + 卡种 / 位置 + 战力天赋 + 通栏「退回」；年龄、工资点名字看详情），
  超编横幅只留 `rosterOverCapNotice` 一句，处理方式收进「怎么处理」；剩余真实新秀 / 请神原型、规则全文收进 `PhoneFold`；卡池表「本季入池」列、记录表「价格」列手机上隐藏。桌面布局不变。
  转售冷却期内的新秀：选手详情「挂牌出售」按钮禁用（`title` 为 `gachaResaleLockText`，写明还差几个转会回合），阵容页批量挂牌跳过并在按钮说明里列出
  （`gachaResaleLockBrief`「入队 6 / 18 个转会回合（抽卡新秀）」）；报价弹窗的抵价说明写明按签字费估值。
  加盟门槛（v0.3.1，任何途径新加盟的选手随队满 `CONFIG.squadOps.listingMinTeamMatches` 场比赛**且**入队满 `listingMinTransferRounds` 个转会回合才能挂牌，优先于转售冷却）：
  选手详情「挂牌转会」面板顶部显示「加盟后挂牌门槛 · 比赛 N / 10 场 · 转会回合 M / 6」（两条 `StatBar` 并排，未满金色、已满绿色；只列出有记录的条件，说明文字也只写这些条件）与说明
  「新加盟的选手须随队满 10 场比赛（系列赛，不要求本人上场）且入队满 6 个转会回合（每个常规赛回合结束时计一次，赛季初与 TI 锁定期间不计）才能挂牌，还差 …；在此之前其他俱乐部也不会主动求购他」，
  「挂牌出售」禁用、`title` 为 `listingJoinLockTitle`「随队满 10 场且入队满 6 个转会回合后可挂牌（已随队 N 场、入队 M 个转会回合）」；
  仍在转售冷却中的本队抽卡新秀，进度条、说明、`title` 与批量挂牌跳过原因里的入队转会回合按冷却报（`listingJoinLock().gachaHold`：「转会回合 M / 18」、「本队抽卡得到的新秀须……入队满 18 个转会回合（抽卡新秀的转售冷却；……）」、
  「入队 M / 18 个转会回合（抽卡新秀）」），门槛满足后的冷却说明从同一个数继续倒数，不要在界面里另行拼「6 个转会回合」；
  阵容页批量挂牌逐人算跳过原因（已在挂牌中 / 加盟门槛 `listingJoinLockBrief`「随队 N / 10 场、入队 M / 6 个转会回合」/ 抽卡冷却），按钮 `title` 与确认气泡写「跳过 N 人：X（原因）」（只选了一名未满足加盟门槛的选手时按钮禁用，`title` 与选手详情相同）；
  确认后提交全部选中的选手，由引擎逐人复核，结果提示列出已挂牌的选手与「跳过 N 人：X 加盟后随队 N 场、入队 M 个转会回合，需随队满 10 场且入队满 6 个转会回合才能挂牌（还差 …）；……」。
  规则文字（选手详情挂牌规则、转会市场「我的挂牌」横幅、规则说明「转会与新秀抽卡」、抽卡页规则、报价弹窗的抵价说明）的场数与回合数都取自 CONFIG；
  报价弹窗与规则说明里抵价的「入队不满 N 个转会回合」用 `tradeHoldRoundsLabel('freeAgent' | 'gacha')`（持有期与入队门槛取较大值，与引擎的估值说明同一函数）；
  抽卡页规则与「真实新秀」事件的挂牌条件共用 `gachaListingRuleText`（「入队满 18 个转会回合（约一个赛季；其他新加盟选手为 6 个）且随队满 10 场比赛」）。
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
  手机（v0.4）：底部按钮行为「报价后余额」单独一行 + 「取消」与占满剩余宽度的提交按钮（文字不换行）；金额输入框 `inputMode="numeric"`；触屏上滑块、快捷价位、「展开 / 收起」、抵价勾选行加高；
  不能再勾选的抵价行在触屏上把原因（「一次最多 3 名选手抵价」等，桌面在悬停提示里）直接写在行内。
- **转会市场的手机布局**（v0.4，`Market.tsx` + `Market*.tsx`，共用件在 `MarketKit.tsx`；「转会市场」标签与「新秀抽卡」一样由 `TransferHub` 按需加载，市场各页约 55 kB 不进主包）：
  `useCompactList()`（手机竖屏 < sm 与横屏矮视口）时宽表格换成卡片列表，桌面 / 平板仍是表格：
  - `PhoneList` / `PhoneRow`（第一行：等级 + 名字 `PHONE_LINK` + 位置等徽章；下面是 `Facts` 的「标签 数值」行；右侧为 `size="sm"` 的操作按钮，`min-h-10 min-w-16`）；
    报价、挂牌这类行少、要做决定的卡片把「接受 / 拒绝」做成 `grid-cols-2` 的两个大按钮，「撤销挂牌」通栏。
  - 筛选：`PhoneFilters`（搜索框 + 「筛选（n）」开关，其余筛选项默认收起、展开为两列；下方 `SortSelect` 排序——卡片没有表头可点）。
  - 页面顶部五个数字格在手机上合成一块概要（金币 · 阵容 · 荣誉 · 工资 · 待处理报价，阵容超限的提醒写在下面）；临时替补的三格只放数字，说明合成格子下方一行。
  - 「我的挂牌」的规则横幅正文在手机上收进 `PhoneFold`（没有挂牌时默认展开）。`PhoneFold`：桌面原样显示，手机上为 `<details>`。
  - `Card` 的 `bodyClassName="p-0"` 实际不生效（`cx` 追加在 `p-4` 后，Tailwind 把 `.p-0` 排在 `.p-4` 前），桌面一直是 16px 内边距；市场与抽卡页用 `BODY_FLUSH`（`p-0 max-sm:p-0! short:p-0!`）
    只在手机 / 横屏矮视口真正贴边，桌面保持不变。`TableWrap` 带 `.table-scroll`（两侧被遮住的列有渐隐阴影）；`Banner` 在手机上操作按钮总是单独一行；`Field` 控件与分页按钮触屏上加高。
  - 消息中心的待决事件卡片（如「真实新秀」）在手机上正文超过 90 字时先收起为 4 行（「展开全文」），选项与说明直接可见。
- **多人大厅 / 房间顶栏的窄屏**（375px）：大厅的「‹ 主菜单」、标题、连接状态 `shrink-0 whitespace-nowrap`，服务器名与「玩家」字样 < sm 隐藏；房间页「‹ 离开房间」< sm 为「‹ 离开」、
  房间码字距收窄（`tracking-[0.08em]`，≥ sm 0.25em）。公网服务器（`serverMode === 'public'`）不显示 `?as=` 多开测试提示。主菜单网格用 `minmax(0,1fr)` 列（截断的长说明不撑宽列）。

## 手机适配（v0.4）

用户需求「优化游戏页面适合手机玩」。公共框架在 `src/index.css`（「手机适配」一节）、`src/ui/mobile.ts`（断点与钩子）、`src/ui/components/TouchTip.tsx`、
`common.tsx`（`Button` / `Modal` / `Tabs` / `TableScroll` / `useToastPlacement`）、`layout/`（`TopBar` / `SideNav` / `ActionBar` / `HubKit`）。各页面按下面的约定适配，桌面（≥ 1024px）外观不变。

- **断点**（与 Tailwind 默认一致，`mobile.ts` 的 `BREAKPOINT`）：
  - `< sm`（640px）= 手机布局：底栏三行（`PhoneBar`）、`Modal` 为底部抽屉、顶栏的「更新」芯片与「存档」收进导航抽屉。
  - `< md`（768px）= 没有侧栏：顶栏最左侧 ☰ 打开导航抽屉；`NoticeBadge` 不显示。横屏手机（`short` 且 < lg）同样没有侧栏（`useSideNav()`，见「导航」）。
  - `≥ lg`（1024px）= 桌面布局。`short` 自定义变体 = `@media (max-height: 480px)`（横屏手机）：顶栏 44px、底栏与侧栏行距收紧、sm–lg 的补充提示行隐藏。
  - 判断用 CSS 变体（`max-sm:` / `sm:` / `md:` / `short:` / `pointer-coarse:`）优先；需要换结构时用 `useIsPhone()` / `useMinWidth(px)` / `useCoarsePointer()`（同一查询共用一个 `MediaQueryList`，可以放心在每个按钮里调用）。
  - 窄屏单列网格一律写 `grid-cols-[minmax(0,1fr)]`（见「技术约定」）；`main` 在手机上的内边距为 `px-3 py-4`（≥ sm `px-6 py-5`），要「出血」到边缘的元素按同样的断点取负外边距（如 `MatchDock`：`-mx-3 sm:-mx-6`）。
- **视口与安全区**：`index.html` 设 `viewport-fit=cover`、`theme-color`、`apple-mobile-web-app-*`（状态栏 `black-translucent`）与 `manifest.webmanifest`（独立窗口、竖屏、深色底，图标见下）；不注册 Service Worker。
  - `#root` 高度 `100dvh`（随移动浏览器工具栏伸缩）；页面本身不滚动（`body` `overscroll-behavior: none`），滚动发生在 `main` 等容器里（`overscroll-contain`）。
  - 根容器 `pt-safe px-safe`（刘海 / 状态栏与横屏刘海）；**贴底的栏自己让出底部**：`ActionBar` 与 `MatchDock` 用 `pb-safe`（背景铺到 Home 横条下方）。新增贴底的 fixed 元素用 `env(safe-area-inset-bottom)` 或 `--chrome-bottom` 定位。工具类：`pt-safe` / `pb-safe` / `px-safe` / `no-scrollbar`（`index.css` 的 `@utility`）。
  - CSS 变量：`--chrome-top` = 顶栏底边到视口顶部（多人窄屏两行时约 106px），`--chrome-bottom` = 底栏（或比赛页 `MatchDock`）顶边到视口底部，都含安全区，由 `useChromeVar` 写在 `<html>` 上、卸载时移除。
    提示（`useToastPlacement`，所有宽度都在顶栏下方）、TI 预选横幅、底部抽屉、「查看生涯总结」浮动按钮据此避开两条栏；新增浮层同样用 `calc(var(--chrome-bottom, 0px) + 8px)` 之类的写法，不要写死 `top-16` / `bottom-24`。
  - 应用图标 `public/icons/`：由原创冠军盾矢量图（`TiTransition.tsx` 的 `AegisSvg`，默认主题）渲染（`icon-192/512.png` 为圆角深色底，`icon-maskable-*.png` 为满版底、盾在 60% 安全区内，`apple-touch-icon.png` 180px，`favicon-32.png` / `icon.svg` 为标签页图标）。不得换成 Valve 美术。
- **导航**（`layout/SideNav.tsx`）：< md 与横屏手机（矮视口 `short` 且 < lg）时 App 不渲染侧栏，顶栏最左侧为 ☰（`NavToggle`）。是否有侧栏一律用 `mobile.ts` 的 `useSideNav()`（App、TopBar 的 ☰、抽屉的自动收起共用；横屏手机只有约 390px 高，160px 的侧栏会把内容挤窄；≥ lg 的窗口再矮也保留侧栏）。点开为左侧抽屉（`NavDrawer`，portal 到 body，z-[55]）：与侧栏同一份入口、徽标与 `open()` 逻辑（`useNavModel`），
  每个入口下方直接写出说明（触屏没有悬停），顶部为俱乐部与「TI 赛季 · 回合」，底部为顶栏放不下的入口（单机「存档管理」、「更新说明」，由 TopBar 通过 `footer` 传入，`DrawerRow`）。
  导航后、点遮罩、Esc、出现侧栏（`useSideNav()` 变为 true）时收起。抽屉顶部的俱乐部全名与简称相同（如 OG）时只写一次。☰ 的提示点：有「需处理」徽标（待决事件、首发问题、报价、资金为负 / 荣誉告急）时为红色脉冲点，只有新通知（或手机上有未读的更新说明）时为蓝点。
  选择抽屉而不是底部标签栏：底部已有操作栏，再加一行标签会多占约 52px 高度，且与「下一回合」抢拇指区域。顶栏 < md 显示简写进度「5/18」「TI 预选」。
- **底栏**（`layout/ActionBar.tsx`）：
  - 手机 `PhoneBar`：第一行一行提示（`HintLine`：右侧提示，阻塞为红色；没有提示时为「回合类型 · 赛事 · 日期 · 距 TI」；点按展开全文，点在提示里的按钮上则执行按钮）；
    第二行情境操作条（非次要操作的 `compactEl ?? el`，`shrink-0`，横向滑动、隐藏滚动条）；第三行「自动」开关（竖排，与主按钮等高）+ 通栏主按钮（`h-12`，手机上用 `Main.short`，多人为「准备（1/2）」，动词放进小字）+「更多」（只放 `secondary` 操作，菜单项 `max-sm:py-3`）。
    主按钮被禁用时小字写原因。
  - 底栏的气泡（训练焦点、训练赛、待决事件、更多）在手机上是底栏上方的通栏抽屉（`BarPopover`，`--chrome-bottom` 定位，内容超高时滚动）；≥ sm 仍在按钮上方，宽度夹在视口内、高度不超过按钮上方空间。
    待决事件在手机上正文不截断，每个选项的说明直接写在选项下方。
  - 新增情境操作：给 `compactEl`（手机上用它）、`demote`、`menu`；不要依赖悬停说明传达必要信息。`compactEl` 的文字要带动词（如「退回 3 人」，不要只写「超编 3 人」）；点按后如果当前页面就是目标页、看不出变化，要让页面把相关内容滚到眼前。
- **弹窗**（`common.tsx` 的 `Modal`）：手机上为底部抽屉（贴底、全宽、顶部圆角、最高为视口减去状态栏，`sheet-up` 动画），标题栏固定、正文滚动（`overscroll-contain`），
  关闭按钮 40×40；底部按钮行可换行，并让出 Home 横条（`pb-[max(0.75rem,env(safe-area-inset-bottom))]`）。≥ sm 为居中面板，最高 `100dvh - 2rem`。宽度参数（`max-w-*`）照旧。
  确认气泡（`ConfirmPopover`）宽度不超过视口，触屏上「确定 / 取消」为常规尺寸按钮。所有「点外部关闭」一律监听 `pointerdown`（iOS Safari 点按非可点击元素不发 `mousedown`）。
- **提示（toast）**：`ToastHost` / `MpToastHost` 共用 `useToastPlacement` 与 `ToastCard`：默认在顶栏下方（`--chrome-top`）；手机游戏内在底栏上方，自下而上出现（不压住多人顶栏第二行的「聊天 / 离开 / 托管」）。
  层级 `z-[75]`：高于弹窗（z-50）与底栏的通栏抽屉（`BarPopover` z-[70]——手机上在训练赛抽屉里约练后，结果提示要在抽屉之上），低于确认气泡（z-[80]）。
  手机上超过 4 行的提示（如十连结果）先收起并写「点按展开全文」：第一次点按展开并留住（store 的 `holdToast`，改为 12 秒后消失），再点关闭；桌面不收起。
- **触控尺寸**：`Button` 在触屏（`pointer-coarse`）上的最小高度 xs 32px / sm 36px / md 40px（lg 本来约 44px）；顶栏按钮、音乐按钮至少 40px；底部抽屉的菜单项约 46px。
  自写的可点元素（`<button className=…>`）在触屏上同样保证至少 36–40px 高（`pointer-coarse:min-h-10`），相邻的危险操作之间留出间距。
- **触屏说明**（`components/TouchTip.tsx`）：触屏没有悬停，`title` 看不到。`Button` 在触屏上「`disabled` + 有 `title`」时改为 `aria-disabled` + 半透明（原生禁用的按钮收不到点击），
  点按时在按钮旁显示 `title`（禁用原因），不执行操作、不冒泡、不提交表单——所以 AGENTS.md「按钮禁用时用 `title` 说明原因」在手机上同样有效，**禁用的按钮请用 `Button`（或 `ConfirmButton`）而不是裸 `<button disabled>`**。
  其他只靠 `title` 说明的关键信息，或者直接写在界面上（如导航抽屉的入口说明、待决事件的选项说明），或者点按时调用 `showTouchTip(元素, 文字)`。「自动」开关在触屏上每次切换都会显示一句说明。
- **输入框**：触屏上 `input / select / textarea` 字号至少 16px（`index.css` 全局规则，iOS 聚焦时不再放大页面）；触屏不要 `autoFocus` 输入框（会立刻弹出软键盘，如多人聊天）。
- **悬停效果**：Tailwind v4 的 `hover:` 只在有悬停能力的设备生效；自写 CSS 的悬停规则放进 `@media (hover: hover)`（`.tbl` 行高亮、新闻滚动条悬停暂停）。
- **标签行**：`HubShell` 与 `Tabs` 在手机上不换行、横向滑动（隐藏滚动条），`HubShell` 的标题单独一行；新加的标签不需要额外处理。
- **表格**（`common.tsx` 的 `TableScroll`，样式 `index.css` 的 `.table-scroll` / `.tbl-cards`）：
  - 宽表格包在 `<TableScroll>` 里横向滑动，两侧有被遮住的列时显示渐隐阴影；`stickyFirst` 让第一列（选手 / 战队名）固定在左侧；`bg` 传卡片底色（默认 `panel`）。不要再用 `overflow-hidden` 包表格（右侧的列在手机上会被裁掉、滑不到）。
    长说明列给 `whiteSpace: normal` 与最小宽度，让它换行而不是把表撑得更宽。
  - 战队详情（`TeamModal`）的阵容与「近期战绩」表都在 `TableScroll` 里；近期战绩的赛事名在手机上换行（`max-sm:whitespace-normal!`、按钮 `text-left`），等级与名次列总在屏幕内，桌面仍单行截断。
  - 列多、行少的表（详情、对比）可以在手机上改成卡片：`<table className="tbl tbl-cards">`，每个 `td` 加 `data-label="列名"`（作为左侧小标题，不带 `data-label` 的单元格为卡片标题行）；≥ sm 仍是普通表格。
  - 行数很多、主要看两三列的表（排名、市场）优先在手机上隐藏次要列（`max-sm:hidden`）+ 点击行看详情，而不是横向滑很远。
  - 首列固定只在 < lg 开启：`<TableScroll stickyFirst={useStickyFirstCol()}>`（`SquadShared`）。桌面表格放得下，固定列的实色底与分隔线会让悬停高亮缺一格。
    要固定两列（勾选框 + 选手、名次 + 俱乐部）时在格子上写 `max-sm:sticky max-sm:left-… max-sm:bg-panel`（见 `Squad` 的 `STICKY_*`、`GameOver` 的排行榜），合计行不要用跨列的首格（固定后会盖住滑过来的列）。
  - `index.css` 的 `.tbl` 规则不在 `@layer` 里，优先于 Tailwind 工具类：要在单元格上改 `z-index` / `white-space`、在表格上改 `width` 时加 `!`（如表头固定格 `max-sm:z-[3]!`、
    说明列换行 `max-sm:whitespace-normal!`、按内容宽度排开 `max-sm:w-max!`——否则 `width: 100%` 会把各列压到最小宽度，标签折成多行）。
  - 名称列不是第一列（前面有「#」）时用 `PediaKit` 的 `STICKY_TH` / `STICKY_TD`（只在 < sm 生效）固定名称列，「#」列加 `PHONE_HIDE`，名次并入名称单元格（`sm:hidden` 的小号序号）；
    可排序的表在手机上另放 `PediaSortSelect`（下拉选排序项 + 升降序按钮，≥ sm 不显示），表头滑出屏幕也能排序（DotaPedia 战队 / 选手 / 英雄）。
  - 每行信息分散在七八列、按行阅读的表（DotaPedia 赛事列表、单局纪录、战队「赛事战绩」）在手机上换成两三行的列表（`sm:hidden` 的列表 + `hidden sm:block` 的表格）。
  - `Card` / `PSection` 的 `bodyClassName="p-0"`：桌面上默认的 `p-4` 一直覆盖它（保持不变）；手机上按原意去掉内边距（`max-sm:p-0`），表格卡片多出 32px 宽。
- **赛事与比赛页**（v0.4 match）：
  - 比赛页（`Match.tsx`）阶段切换（赛前 → BP → 直播 → 下一局 / 结算）时 `main` 回到顶部；横幅在手机上去掉队标方块与赛区文字，流程步骤只写当前步骤名，横屏矮视口隐藏步骤行。
  - `MatchDock`：< sm 两行（阶段 + 提示 / 附加按钮，次要按钮 + 通栏主按钮）；sm–lg 主按钮最小 240px、右栏至少容得下附加按钮（`minmax(min-content,1fr)`）；≥ lg 与桌面一致（主按钮 360px）；`short:` 收紧高度。
    主按钮换成另一个动作（`primary.key` 变化，如直播播完时「跳过直播」→「继续 · 第 N 局」）后 600ms 内不响应点按、半透明显示（`usePrimarySwapGuard`）：想跳过直播的一下恰好落在播完之后，不会直接进入下一局而错过赛果。
  - BP（`MatchDraft.tsx`）：< lg 用 `useMinWidth(1024)` 换成吸附在主区顶部的紧凑看板（`sticky -top-4 sm:-top-5`，抵消 `main` 的上内边距；`short:static`）+ 横向推荐条 + 不嵌套滚动的英雄池，BP 顺序（横向条）与完整禁选位放在最后。
    触屏（`useCoarsePointer`）为「点按选中 → 再点一次或点底栏按钮确认」：选中的英雄是比赛页的本地状态（按 BP 进度失效），底栏写明英雄简介（`heroBrief`）；鼠标仍为单击直接禁选。
    英雄池搜索：BP 前进一步（可用英雄减少）后搜索没有结果时自动清空（搜到的英雄被禁 / 选走后不必再点「清除筛选」）；仍有结果时保留。
  - 直播（`MatchLive.tsx`）：< lg 用 flex `order` 把记分板（附一行大老师胜率）与直播排在最前，直播框 `h-[min(440px,55dvh)]`，事件行在手机上分两行；触屏不显示「空格跳过」提示。
    直播框 < lg 为 `overscroll-auto`：滑到框的顶 / 底后继续滑动会滚动页面（它是「页面内的滚动框」规则的例外，所以不拦截滚动链）；≥ lg 仍为 `overscroll-contain`。
  - 横屏手机（`short` 且 < lg）：没有侧栏（☰ 抽屉）；比赛页标题行 `short:mb-2`、副标题隐藏（横幅已写 Bo 与局数）、横幅比分缩小、不显示队标方块，BP 看板与直播尽量留在第一屏（看板在 `short` 下仍不吸附：内容区只有约 290px 高）。
  - 只靠 `title` 说明的小元素：`MatchShared.tsx` 的 `tapTip(文字)`（展开到元素上：桌面为 `title`，触屏点按显示 `TouchTip`）；英雄头像传 `tip`（`<HeroAvatar tip />`）。
  - 报名按钮（`entryControls`）在触屏上 `xs` 自动放大为 `sm`；长规则说明在手机上收进 `<details>`「规则说明」；`Segmented` 触屏最小 36px、不折行。
  - 横屏手机（`short`）不显示左下角浮动通知徽标；< lg 的横屏手机没有侧栏，新通知数在 ☰ 的蓝点与导航抽屉「总览」上（≥ lg 的矮窗口写在侧栏「总览」上）。
  - 系列赛结算卡片顶部的赛事说明行在手机上字距收窄（`max-sm:tracking-[0.08em]`）。
- **页面上的做法**（俱乐部 / 战队 / 总览 / 主菜单 / 新游戏 / 生涯总结，v0.4）：
  - 主菜单与新游戏的内容区：内容可能比视口高的居中布局用 `flex-col` + 内容 `m-auto`（不要 `items-center` 居中滚动容器，顶部会被推到滚动起点之上）；横屏（`short`）主菜单标题与入口左右并排。
  - 新游戏向导：手机上顶栏一行（标志 + 步骤 + ✕），底栏为「第 n/3 步 · 未完成项」一行小字 +「返回 / 通栏主按钮」，右侧让出右下角浮动的音乐按钮；换步骤时回到顶部。
  - 阵容首发卡片在手机上压缩（选手名并入位置行、战力 / 天梯 / 年龄为一行小字）；训练赛表与推荐训练赛只留简称 / 倍数 / 费用 / 「约练」（≥ sm 仍为「约训练赛」）。
  - 只在悬停里的说明（待处理的首发问题与到期选手、训练卡片概况、选手潜力说明、通知摘要、账目说明）在手机上直接写出或换行显示全文。
  - inline-flex 按钮里不要用「文字 + 隐藏的文字」拼标签（拆开的文字之间会多出 `gap`，桌面宽度会变），写两套完整文字分别 `sm:hidden` / `hidden sm:inline`。
  - 链接按钮（`PlayerLink` / `TeamLink` 是 `<button>`，原子行内盒）放进要截断的窄格子时，把截断加在按钮本身：`className="block max-w-full truncate text-left"`；只在外层 span 上 `truncate` 时按钮会被硬裁掉、没有省略号（生涯总结「最佳选手」）。
  - 主菜单入口按钮在手机上 `max-sm:px-3 max-sm:gap-2.5`、标签 `truncate`，悬停才出现的「›」在触屏上不占位（`pointer-coarse:hidden`），两列的「导入存档 / 玩法说明」在 360px 下不折行；英文副标题 `whitespace-nowrap` 且手机上字距收窄。新游戏终点 TI 格子的「2027 · 推演」不折行。
  - 存档管理「导出存档文件」与生涯总结「导出存档」同一写法：`ShellKit` 的 `downloadText`（链接挂到页面上再点击、1 秒后释放 blob 地址——立即释放会让 iOS Safari 取消下载）+ `saveFileName(简称)`，成功后提示「存档已导出」。
- **页面内的滚动框**：手机 / 平板上不要在页面里再套 `max-h-* overflow-y-auto` 的滚动框（滑动会被它吞掉、页面滚不动）：只在桌面加（`lg:max-h-[460px] lg:overflow-y-auto`），
  窄屏改为先列前 N 行 +「显示全部」（历史地位榜、TI 冠军、选手榜、多人选队列表）。
- **DotaPedia 词条**：< lg 时信息框（`Infobox`）只显示醒目区域与 `summary` 要点行，其余收进「完整信息」；目录（`PediaToc`）是一行可横向滑动的章节标签。
  只放在 `title` 里的说明用 `tipOnTap(text)`（触屏点按时显示 TouchTip）；`PStat` 带 `title` 时自动如此。图表（`PediaCharts`）触屏点按柱子 / 数据点时在图下方显示该点的说明。
- **多人**：大厅 < lg 按「玩家 → 加入房间 → 房间列表 → 创建房间 → 服务器（地址设置默认收起）」排列，连接中断 / 已断开时「服务器」卡片（立即重连、错误原因）提到最前；
  大厅顶栏的连接状态在手机上用简写（`ConnBadge short`：「重连中 16 秒」「未连接」，完整的「连接中断，16 秒后第 7 次重连…」在服务器卡片里），玩家名不再被挤成一个字；
  房间列表的名称行可换行：放不下时「进行中 / 我的座位」等徽标换到下一行，房间名不被挤成「甲的…」；房间 < xl 玩家列表在最前、非房主的对局设置只显示一行摘要，
  「准备 / 开始游戏」固定在底部栏（右侧让出音乐按钮）。公网服务器的「手动地址」提示与占位为网页地址（`http://地址/`）或「地址:端口」（v0.4 公网服务器改用 80 端口，见 MULTIPLAYER.md「80 端口与旧地址」）；
  局域网仍提示 `192.168.1.5:8686`（不带协议头、不带端口的纯地址默认 8686，`http://地址/` 按 80）。游戏内聊天面板 z-[48]（弹窗之下），点外部 / Esc 关闭，「离开」先收起聊天；消息列表按高度固定、横屏时限高。
  手机上其他玩家的快讯只显示最新一条，带单独的 ✕（点快讯本身仍打开消息中心）。
- **新页面自查**（375×812、360×740、390×844、414×896，横屏 844×390；浏览器测试用独立的源）：`document.documentElement.scrollWidth` 等于视口宽度、`main.scrollWidth` 等于 `main.clientWidth`（不要靠 `overflow-x: hidden` 盖住问题，找出撑宽的元素），
  按钮至少 36px 高、拇指能点到，没有只靠悬停才能看到的必要信息，浮层不压住顶栏 / 底栏。

## 本地美术覆盖（`public/local/`，第十波 #4 / #7）
真实队标与官方冠军盾图片属于商标 / 版权美术，**不得提交到仓库**；界面默认使用原创生成的队徽与矢量冠军盾。用户可在本机放入自己的图片覆盖显示（目录被 `.gitignore` 忽略，只提交 `public/local/README.txt` 使用说明）：
- `public/local/logos/{战队 id}.png|svg|webp`：队标；`{战队 id}.{简称}`（简称去标点、小写，如 `lgd-gaming.psglgd.png`）可为某个品牌时期单独指定，优先于 `{战队 id}`。
- `public/local/aegis.png|svg|webp`：冠军盾（TI 转场、预选横幅、顶栏徽记）。
- 实现（`src/ui/localArt.ts`）：文件列表由 `import.meta.glob` 在开发服务器启动 / 构建时枚举（只取文件名，从不导入内容），运行时不做探测请求——没有文件就不发请求、控制台没有 404；放入或删除文件后重新运行 `npm run dev` / `npm run mp`。图片加载失败时记下地址并回退到生成图案，不再重复请求。

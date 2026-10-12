刀塔经理 · 本地美术覆盖（public/local/）
==========================================

真实战队的队标、官方「不朽之盾」冠军盾图片属于各自权利人的商标 / 版权美术，
不随本仓库分发。游戏默认显示：
  - 队标：按战队简称 + 品牌配色生成的原创风格化队徽；
  - 冠军盾：原创绘制的矢量冠军盾（TI 转场、TI 预选横幅、TI 回合顶栏徽记）。

如果你想在自己的电脑上看到别的图片，可以把图片放进本目录。
本目录除这份说明外全部被 git 忽略（见项目根目录的 .gitignore），不会被提交或上传。

1) 队标：public/local/logos/{战队 id}.png（也支持 .svg / .webp）
   - 战队 id 见 src/data/rosters/ti*.json 中各战队的 "id"，例如：
       public/local/logos/og.png
       public/local/logos/team-spirit.svg
       public/local/logos/lgd-gaming.webp
   - 同一俱乐部在不同品牌时期想用不同的图片时，可以命名为「{战队 id}.{简称}」，
     简称去掉标点并小写，优先于「{战队 id}」，例如 LGD 在 PSG.LGD 时期：
       public/local/logos/lgd-gaming.psglgd.png
     注意：同一组织在阵容数据里可能有多个 id（如 lgd-gaming / psg-lgd），
     游戏里用的是开局那一届阵容中的 id；赛季中途才成立的真实俱乐部用的是成立那一届阵容中的 id
     （对照表见 src/data/branding.json 与 src/data/clubIndex.json 的 teamIds）。
   - 玩家新建俱乐部的 id 形如 club-俱乐部名，偶尔成立的虚构新组织形如 org-组织名（可在导出的存档文件中查到）。
   - 建议使用正方形、透明背景的图片（显示尺寸约 16–48 像素）。

2) 冠军盾：public/local/aegis.png（也支持 .svg / .webp）
   - 建议正方形、透明背景，至少 256×256 像素。

放入或删除文件后需要重新启动 / 重新构建才会生效：
  - 单机开发：重新运行 npm run dev；
  - 局域网多人：重新运行 npm run mp（会重新构建 dist/，朋友的浏览器从你的电脑加载这些图片）。
图片列表在启动 / 构建时确定，游戏运行时不会探测不存在的文件（不会产生 404 请求）。
图片无法加载时自动回退为生成的队徽 / 原创冠军盾。

请只使用你有权使用的图片，不要把它们提交到公开仓库。

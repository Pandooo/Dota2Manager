// 「玩法说明」内容（主菜单弹窗使用）。数值从 CONFIG 读取，保持与引擎一致。
import type { ReactNode } from 'react';
import { CONFIG, formatGold } from '../../engine';
import { FUN_EVENTS, type FunEffects } from '../../engine/funEvents';
import { getPlayerIndex } from '../../data/index';
import { cx } from './common';
import { safe } from './ShellKit';

function Section({ icon, title, accent, children }: { icon: string; title: string; accent?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2/50 p-3.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={cx('grid h-6 w-6 place-items-center rounded text-xs font-black', accent ?? 'bg-dota/25 text-[#ff9b8a]')}>{icon}</span>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="space-y-1 text-[13px] leading-relaxed text-mute">{children}</div>
    </div>
  );
}

const B = ({ children }: { children: ReactNode }) => <b className="font-semibold text-ink">{children}</b>;

// ---------------------------------------------------------------------------
// 趣事表（funEvents.ts 的 FUN_EVENTS，由用户维护）→ 说明文字，表内容变化时自动同步
// ---------------------------------------------------------------------------
const sign = (v: number) => (v > 0 ? '+' : '');
const pctText = (v: number) => `${sign(v)}${Math.round(v * 100)}%`;
const roundsText = (r: number | null) => (r ? `${r} 回合` : '永久');

function effectsText(fx?: FunEffects): string {
  if (!fx) return '';
  const out: string[] = [];
  if (fx.gold) out.push(`资金 ${sign(fx.gold)}${formatGold(fx.gold)}`);
  if (fx.honor) out.push(`荣誉 ${sign(fx.honor)}${fx.honor}`);
  if (fx.teamPower) out.push(`全队战斗力 ${pctText(fx.teamPower.pct)}（${roundsText(fx.teamPower.rounds)}）`);
  if (fx.playerPower) out.push(`当事选手战斗力 ${pctText(fx.playerPower.pct)}（${roundsText(fx.playerPower.rounds)}）`);
  if (fx.teamLoyalty) out.push(`全队归属感 ${sign(fx.teamLoyalty)}${fx.teamLoyalty}`);
  if (fx.playerLoyalty) out.push(`当事选手归属感 ${sign(fx.playerLoyalty)}${fx.playerLoyalty}`);
  if (fx.playerInsight) out.push(`当事选手灵性 ${sign(fx.playerInsight)}${fx.playerInsight}`);
  if (fx.playerResilience) out.push(`当事选手韧性 ${sign(fx.playerResilience)}${fx.playerResilience}`);
  if (fx.playerMmr) out.push(`当事选手天梯 ${sign(fx.playerMmr)}${fx.playerMmr}`);
  return out.join('，');
}

function playerHandle(id: string): string {
  return safe(() => getPlayerIndex().find((e) => e.id === id)?.handle, undefined) ?? id;
}

/** 模板占位符（{player} {team}）替换为通用称呼 */
const fillTemplate = (t: string) => t.replace(/\{player\}/g, '某选手').replace(/\{team\}/g, '你的战队');

const FUN_SHOW_MAX = 6;

function FunEventList() {
  if (FUN_EVENTS.length === 0) return <p>当前趣事表为空。</p>;
  const shown = FUN_EVENTS.slice(0, FUN_SHOW_MAX);
  return (
    <ul className="space-y-0.5">
      {shown.map((e) => {
        const fx = effectsText(e.effects);
        return (
          <li key={e.id}>
            · 「<B>{fillTemplate(e.title)}</B>」
            {fx && <span>：{fx}</span>}
            {e.choices?.length ? <span>（带选项）</span> : null}
            {e.requirePlayerId && <span className="text-faint">（仅在 {playerHandle(e.requirePlayerId)} 效力于你的战队时触发）</span>}
          </li>
        );
      })}
      {FUN_EVENTS.length > shown.length && <li className="text-faint">…… 共 {FUN_EVENTS.length} 件</li>}
    </ul>
  );
}

export default function ShellRules() {
  const R = CONFIG.calendar.regularRounds;
  const th = CONFIG.ladder.thresholds;
  const lm = CONFIG.ladder.multipliers;
  const funPct = Math.round(CONFIG.events.funEventChancePerRound * 100);
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gold/30 bg-gradient-to-r from-gold/10 to-transparent px-4 py-3 text-sm leading-relaxed">
        你是一名 Dota 2 战队经理：选择从某一届 TI 开始，带领真实或自建的俱乐部征战若干赛季。
        <B>终极目标：至少捧起一次 TI 冠军奖杯。</B>
        但要小心——<span className="text-bad">俱乐部荣誉一旦跌破 0，战队就会解散，游戏提前结束。</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Section icon="◷" title="赛季与回合">
          <p>
            每个赛季以一届 TI 为终点。赛季分为：<B>赛季初</B>（新秀抽卡、报名赛事、转会）→ <B>{R} 个常规回合</B> →
            <B> TI 预选</B> → <B>TI 正赛</B> → 赛季结算（年龄增长、退役、合同到期）。
          </p>
          <p>常规回合要么是「赛事回合」（你报名的赛事在此进行），要么是「休赛回合」（训练、运营）。点击页面底部的主按钮（如「下一回合 ▶」）推进。</p>
        </Section>

        <Section icon="⚔" title="训练与成长" accent="bg-good/20 text-good">
          <p>
            <B>训练是成长的主要来源</B>（看天赋、花钱多）：每个休赛回合有 <B>{CONFIG.training.freePerRestRound} 次免费训练</B>，
            可花金币购买额外训练（每回合最多 {CONFIG.training.maxExtraPerRound} 次，同一回合内逐次加价），约强队打训练赛收益更高。
            一直训练的队员成长快得多，但每个休赛回合都加满训练要花掉一大笔钱。
          </p>
          <p>
            <B>比赛主要带来荣誉、金钱与韧性</B>：打得越久、名次越好、赛事越大，韧性涨得越多（TI 最多）；战力、天梯、灵性只有少量提升。
            只打比赛不训练，队员基本只靠每赛季初的自主成长。
          </p>
          <p>
            <B>天赋</B>决定每次训练收益的波动区间（天赋越高上限越高），也决定能被练到自身上限之上多少——练出来的提升大多会保留；
            年纪越大成长越慢，{CONFIG.aging.powerDeclineStartAge} 岁起战力开始衰退。教练能提升队员的天赋与韧性（每个休赛回合主要计一次，加练不会把天赋练上天）。
            未用完的训练次数会在回合结束时按当前焦点自动完成。
          </p>
        </Section>

        <Section icon="★" title="选手属性" accent="bg-tier-s/25 text-[#c9a6ff]">
          <p>
            <B>战斗力</B>是核心；<B>天梯等级</B> C/B/A/S/SS/SSR（B 级起依次为 {th.B}/{th.A}/{th.S}/{th.SS}/{th.SSR} 分）提供
            {' '}{lm.C.toFixed(2)}~{lm.SSR.toFixed(2)} 的倍数；
            <B>灵性</B>影响 BP，<B>韧性</B>越高受事件影响越小，<B>归属感</B>过低的选手可能申请离队或被挖走。
          </p>
          <p>
            选手打非本位置时评分打 {Math.round(CONFIG.team.offRoleFactor * 100)} 折；<B>副位置</B>（真实生涯中担任过的其他位置）只打
            {' '}{Math.round(CONFIG.team.altRoleFactor * 100)} 折，四号位与五号位互换打 {Math.round(CONFIG.team.supportSwapFactor * 100)} 折。
            真实选手的位置随真实生涯在新赛季调整（如 Miposhka 从 TI7 起打五号位）。
          </p>
        </Section>

        <Section icon="♛" title="荣誉" accent="bg-gold/20 text-gold">
          <p>
            荣誉主要靠比赛积累：每项赛事结束时，按 <B>赛前预期</B>、<B>同比</B>（上赛季同系列赛事）、<B>环比</B>（上一项赛事）与
            <B>名次奖励</B>结算，宿敌对决另有加减。不达预期也会扣分！
          </p>
          <p>
            赛前预期按「平均能打到的名次」衡量：热门战队不必每项都夺冠，打进前列即算达标；荣誉较低时单项赛事的扣分会相应减轻。
          </p>
          <p>荣誉越高：招募出高等级选手概率越大、赛事邀请越多、赞助越丰厚。</p>
        </Section>

        <Section icon="!" title="随机事件（每回合都可能发生）" accent="bg-dota/25 text-[#ff9b8a]">
          <p>
            <B>每个回合开始时</B>都会滚动随机事件，休赛回合、赛事回合、TI 预选与正赛期间都不例外：假赛风波、情感受挫、签证问题、丑闻、宿敌、
            欠薪，也有赞助、直播合约、状态火热等好事。
          </p>
          <p>
            玩家战队的负面事件概率整体下调（难度越高越多）；<B>TI 预选与 TI 正赛期间</B>负面事件大幅减少，且不会出现假赛禁赛、签证被拒等让选手缺阵的结果。
          </p>
          <p>带选项的事件会出现在「消息中心」置顶，<B>处理之前无法推进回合</B>。</p>
        </Section>

        <Section icon="☺" title="无厘头趣事" accent="bg-tier-ss/20 text-tier-ss">
          <p>
            <B>每个回合开始时</B>约有 {funPct}% 概率，从满足条件的趣事里抽一件发生，结果会出现在「消息中心」的事件新闻里；
            带选项的趣事需要先在消息中心做出选择。当前趣事：
          </p>
          <FunEventList />
        </Section>

        <Section icon="⚑" title="比赛与 BP" accent="bg-info/20 text-info">
          <p>
            每场系列赛的每一局都有 <B>队长模式 BP</B>（可手动或自动），BP 完成后给出「大老师胜率」，最终胜率由阵容与双方实力共同决定，
            随后是逐分钟的<B>文字直播</B>。不想看？随时可以快速模拟。
          </p>
        </Section>

        <Section icon="⟳" title="版本更新" accent="bg-tier-s/25 text-[#c9a6ff]">
          <p>
            Dota 2 版本按<B>真实发布日期</B>落在赛季中的具体回合，<B>在该回合开始前生效</B>——一个赛季里可能更新好几次（如 7.33 → 7.33b → 7.33c）。
          </p>
          <p>每次更新会永久调整各位置选手的战斗力/灵性倍数，并重排英雄强度。</p>
        </Section>

        <Section icon="¥" title="经济" accent="bg-good/20 text-good">
          <p>
            收入：奖金、出场费、出售选手、赞助等。支出：<B>每回合发放工资</B>、签约费、转会费、训练、临时替补。
            资金不足发不出工资会触发「欠薪」，荣誉和归属感双双下跌。
          </p>
          <p>
            <span className="text-bad">
              破产：资金连续 {CONFIG.bankruptcy.rounds} 个回合结算后仍为负，或负债超过 {CONFIG.bankruptcy.debtWageRounds} 个回合的工资，俱乐部破产，执教生涯提前结束
            </span>
            （多人模式下该玩家出局观战）。资金为负时总览「待处理」与新闻会给出倒计时。
          </p>
        </Section>

        <Section icon="⇄" title="转会与新秀抽卡" accent="bg-gold/20 text-gold">
          <p>
            转会窗口在赛季初与常规赛开放，<B>TI 预选与正赛期间锁定</B>。首发 5 人；常规阵容上限 {CONFIG.team.maxRoster} 人，
            超出后仍可签约、求购与抽卡，也不影响推进，但<B>每名签约选手的工资照付</B>，替补的归属感下降得更快（每多 1 人更快）。
            签约 / 求购的绝对上限为 {CONFIG.team.hardMaxRoster} 人；新秀抽卡（单抽 / 十连总是抽满）可以超出，但<B>超编时须在本回合内放弃新秀或解约，退回 {CONFIG.team.hardMaxRoster} 人后才能进入下一回合</B>。
          </p>
          <p>
            向 AI 战队求购时可以发起<B>选手交易</B>：现金 + 最多 {CONFIG.market.trade.maxPlayers} 名本队选手抵价，对方按「身价 × 系数」估值
            （缺该位置或能顶替首发时溢价，位置重叠、年龄偏大时折价，刚从自由市场签下的按签字费估值），现金与估值合计越高越容易放人；对方阵容超员时会放走替补腾位置。
          </p>
          <p>
            首发凑不齐 5 人（签证、伤病、禁赛、离队）时需招募<B>临时替补</B>，否则该场系列赛<span className="font-semibold text-bad">弃权判负</span>。
          </p>
          <p>
            每个赛季的新秀只能经由<B>新秀抽卡</B>进入联赛：赛季初建立一个所有战队共享的有限卡池（SSR 5% / SS 10% / S 10% / A 15% / B 30% / C 30%），
            卡分三类——<B>真实新秀</B>（能力与成长参照真实历史）、<B>请神新秀</B>（复制名人堂成员的出道能力与生涯走势）与虚构新秀。
            转会窗口开放期间随时单抽 / 十连（价格随年代变化），先到先得；AI 战队在第 1 回合开始前与赛季中期按资金自动抽卡。
            距上一张 SSR 第 {CONFIG.gacha.pityThreshold} 抽必出 SSR；抽到的新秀本回合内可退回（返还部分费用），入队满一个赛季前不能挂牌出售。真实新秀只在赛季初可抽：第 1 回合开始时没被抽走的真实新秀加盟其真实出道战队（出道战队是你的战队时由你决定签下或放弃）；TI 预选赛转会锁定时卡池关闭。名人堂收录 DotA1 时代传奇、开局之前真实历史中达到过 SS / SSR 的选手（开局时补录）与本局历届 SS / SSR 选手（DotaPedia › 名人堂）。
          </p>
        </Section>
      </div>
    </div>
  );
}

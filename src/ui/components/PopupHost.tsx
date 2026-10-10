// ============================================================================
// 回合通知（消费 game.popups：赛事结算 / 赛季总结 / 版本更新 / 新秀选秀结果 / 消息）——不再弹出阻塞式弹窗：
// - NoticesCard：总览顶部的「通知」卡片，最新在前、连续的版本更新合并为一条；每条点击在原处展开详情；
//   「全部已读」一次清空（callSilent('dismissPopups', n)），条目较多时较早的折叠起来并可单独清除（队列从最早的开始移除）。
// - NoticeBadge：在其他页面时左下角（侧栏底部）的小徽标（不阻塞操作、不遮挡页面内容），点击回到总览查看。
// - 默认导出 PopupHost：原来的逐条弹窗，只在游戏结束（生涯总结）界面使用——那里没有总览可以承载通知卡片。
// 多人模式下 popups 是每个座位私有的，各自的客户端只显示自己的通知。
// ============================================================================
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCallSilent, useGame, useGameStore, type ViewKey } from '../../store/gameStore';
import {
  CONFIG, POSITIONS, TOURNAMENT_TIER_LABEL, formatGold, formatRank, heroName,
  patchByVersion, playerTier, rookieDraftRecord,
  type GameState, type PatchInfo, type Popup, type TournamentSettlement, type TournamentTier,
} from '../../engine';
import { RookieDraftPopupBody } from '../screens/RookieDraft';
import { Badge, Button, Delta, EmptyState, Gold, Modal, PlayerLink, PosBadge, TierBadge, cx } from './common';
import { MiniTitle, TourTierBadge, roundLabel, safe, teamNameOf } from './ShellKit';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const fmtRankNum = (n: number) => (Number.isInteger(n) ? `第 ${n} 名` : `第 ${n.toFixed(1)} 名`);
const fmtTerm = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(3)}`;

function StatBox({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-lg border border-line bg-panel-2/60 px-3 py-2', className)}>
      <div className="text-[10px] tracking-wider text-faint">{label}</div>
      <div className="mt-0.5 text-base font-bold tabular">{children}</div>
    </div>
  );
}

function multCell(m: number) {
  const pct = (m - 1) * 100;
  const cls = pct > 0.05 ? 'text-good' : pct < -0.05 ? 'text-bad' : 'text-faint';
  return (
    <span className={cx('tabular', cls)}>
      ×{m.toFixed(3)}
      <span className="ml-1.5 text-[11px]">
        ({pct > 0 ? '+' : ''}
        {pct.toFixed(1)}%)
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 赛事结算
// ---------------------------------------------------------------------------
function SettlementBody({ game, tournamentId }: { game: GameState; tournamentId: string }) {
  const t = game.tournaments[tournamentId];
  const hist = (game.history?.tournaments ?? []).find((h) => h.tournamentId === tournamentId);
  const s: TournamentSettlement | undefined =
    t?.settlement ?? (game.history?.playerSettlements ?? []).find((x) => x.tournamentId === tournamentId);
  const name = t?.name ?? hist?.name ?? tournamentId;
  const tier: TournamentTier | undefined = t?.tier ?? hist?.tier;

  if (!s) return <EmptyState text={`「${name}」的结算数据缺失`} />;

  const champ = s.rankFrom === 1 && s.rankTo === 1;
  const podium = s.rankFrom <= 3;
  const h = s.honor;
  const base = h?.tierBase ?? 0;
  const contrib = (term: number) => Math.round(base * term);
  const championId = hist?.championId ?? t?.placements?.find((p) => p.rankFrom === 1)?.teamId;

  const rows: { label: string; desc: string; value: ReactNode; honor: ReactNode; strong?: boolean }[] = h
    ? [
        { label: '赛事等级基数', desc: `赛事等级决定荣誉变化幅度（TI ${CONFIG.honor.tierBase.ti} / Major ${CONFIG.honor.tierBase.major} / 顶级 ${CONFIG.honor.tierBase.premier} / Minor ${CONFIG.honor.tierBase.minor}）`, value: `×${base}`, honor: <span className="text-faint">—</span> },
        { label: '赛前预期名次', desc: '按参赛队「战力 + 荣誉」排名得出的预期', value: fmtRankNum(h.expected), honor: <span className="text-faint">—</span> },
        { label: '实际名次', desc: '名次区间取中点（如 5-6 名记为 5.5）', value: fmtRankNum(h.actual), honor: <span className="text-faint">—</span> },
        { label: '预期项', desc: `超出赛前预期加分、不达预期扣分（权重 ${CONFIG.honor.wExp}）`, value: fmtTerm(h.expTerm), honor: <Delta value={contrib(h.expTerm)} /> },
        { label: '同比项', desc: `对比上赛季同系列赛事的名次（权重 ${CONFIG.honor.wYoY}，未参加记 0）`, value: fmtTerm(h.yoyTerm), honor: <Delta value={contrib(h.yoyTerm)} /> },
        { label: '环比项', desc: `对比你上一项参加的赛事名次（权重 ${CONFIG.honor.wMoM}）`, value: fmtTerm(h.momTerm), honor: <Delta value={contrib(h.momTerm)} /> },
        { label: '名次奖励', desc: '冠军 / 亚军 / 四强的额外奖励', value: fmtTerm(h.placeBonus), honor: <Delta value={contrib(h.placeBonus)} /> },
        { label: '宿敌', desc: '本赛事中与宿敌交手的胜负加减（逐场结算）', value: <span className="text-faint">—</span>, honor: <Delta value={Math.round(h.beef)} /> },
      ]
    : [];

  // 成长重平衡：比赛主要提升韧性（战力 / 天梯 / 灵性只有少量），按韧性排序
  const growth = (s.playerGrowth ?? []).slice().sort((a, b) => (b.resilience ?? 0) - (a.resilience ?? 0) || b.power - a.power);

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div
        className={cx(
          'relative overflow-hidden rounded-xl border px-5 py-4',
          champ ? 'glow border-gold/70 bg-gradient-to-br from-gold/25 via-panel-2 to-panel' : podium ? 'border-gold/30 bg-gradient-to-br from-gold/10 to-panel' : 'border-line bg-panel-2/60',
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2" title={tier ? TOURNAMENT_TIER_LABEL[tier] : undefined}>
              {tier && <TourTierBadge tier={tier} />}
              <span className="text-xs text-mute">{s.teams} 支队伍</span>
            </div>
            <div className="mt-1 truncate text-lg font-bold">{name}</div>
            {championId && !champ && (
              <div className="mt-0.5 text-xs text-mute">
                冠军：<span className="text-ink">{teamNameOf(game, championId)}</span>
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-[10px] tracking-[0.3em] text-faint">最终名次</div>
            <div className={cx('text-4xl font-black italic', champ ? 'text-gold' : podium ? 'text-ink' : 'text-mute')}>
              {champ && <span className="mr-1 not-italic">♛</span>}
              {formatRank(s.rankFrom, s.rankTo)}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatBox label="奖金">
          <Gold value={s.prize} />
          {/* 第九波奖金分成：俱乐部实得 / 队员分得 */}
          {s.prize > 0 && typeof s.prizeClub === 'number' && typeof s.prizePlayers === 'number' && (
            <div
              className="mt-0.5 text-[10px] font-normal leading-tight text-mute"
              title={typeof s.prizeShare === 'number' ? `奖金分成 ${Math.round(s.prizeShare * 100)}% 给队员（可在「俱乐部 › 财务」调整）` : undefined}
            >
              俱乐部 <span className="text-gold">{formatGold(s.prizeClub)}</span> · 队员 {formatGold(s.prizePlayers)}
            </div>
          )}
        </StatBox>
        <StatBox label="出场费">
          <Gold value={s.appearanceFee} />
        </StatBox>
        <StatBox label="巡回赛积分">
          <span className={s.points ? 'text-info' : 'text-faint'}>{s.points ? `+${Math.round(s.points)}` : '0'}</span>
        </StatBox>
        <StatBox label="荣誉变化" className={h && h.total < 0 ? 'border-bad/40' : h && h.total > 0 ? 'border-good/40' : undefined}>
          <Delta value={Math.round(h?.total ?? 0)} />
        </StatBox>
      </div>

      {/* 荣誉明细 */}
      {h && (
        <div>
          <MiniTitle right={<span className="text-[11px] text-faint">荣誉 = 基数 × (预期项 + 同比项 + 环比项 + 名次奖励) + 宿敌</span>}>荣誉结算明细</MiniTitle>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="tbl">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>说明</th>
                  <th className="num">数值</th>
                  <th className="num">荣誉</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td className="font-medium">{r.label}</td>
                    <td className="text-xs text-mute" style={{ whiteSpace: 'normal', minWidth: 220 }}>
                      {r.desc}
                    </td>
                    <td className="num">{r.value}</td>
                    <td className="num">{r.honor}</td>
                  </tr>
                ))}
                <tr className="bg-panel-2/60">
                  <td className="font-bold">合计</td>
                  <td className="text-xs text-mute">四舍五入后计入俱乐部荣誉</td>
                  <td className="num" />
                  <td className="num text-base font-bold">
                    <Delta value={Math.round(h.total)} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 选手成长 */}
      <div>
        <MiniTitle right={<span className="text-[11px] text-faint">比赛主要磨炼韧性；战力 / 天梯 / 灵性的成长主要靠休赛回合训练</span>}>选手赛事成长</MiniTitle>
        {growth.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">本次赛事没有选手成长记录</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="tbl">
              <thead>
                <tr>
                  <th>选手</th>
                  <th className="num">韧性</th>
                  <th className="num">战斗力</th>
                  <th className="num">天梯分</th>
                  <th className="num">灵性</th>
                </tr>
              </thead>
              <tbody>
                {growth.map((g) => {
                  const p = game.players[g.playerId];
                  return (
                    <tr key={g.playerId}>
                      <td>
                        <span className="flex items-center gap-2">
                          {p && <PosBadge pos={p.position} />}
                          {p ? <PlayerLink player={p} /> : <span className="text-mute">{g.playerId}</span>}
                          {p && <TierBadge tier={playerTier(p)} />}
                        </span>
                      </td>
                      <td className="num">
                        <Delta value={g.resilience ?? 0} digits={2} />
                      </td>
                      <td className="num">
                        <Delta value={g.power} digits={2} />
                      </td>
                      <td className="num">
                        <Delta value={Math.round(g.mmr)} />
                      </td>
                      <td className="num">
                        <Delta value={g.insight} digits={2} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 赛季总结
// ---------------------------------------------------------------------------
function SeasonSummaryBody({ game, ti }: { game: GameState; ti: number }) {
  const s = (game.history?.seasons ?? []).find((x) => x.ti === ti);
  if (!s) return <EmptyState text={`TI${ti} 赛季总结数据缺失`} />;
  const me = game.settings.playerTeamId;
  const wonTi = s.tiChampionId === me;
  const goldDelta = s.goldEnd - s.goldStart;
  const titles = s.playerTitles ?? [];
  const retired = s.retired ?? [];
  const notes = s.notes ?? [];
  return (
    <div className="space-y-4">
      <div
        className={cx(
          'relative overflow-hidden rounded-xl border px-5 py-4',
          wonTi ? 'glow border-gold/70 bg-gradient-to-br from-gold/25 via-panel-2 to-panel' : 'border-line bg-gradient-to-br from-dota/15 via-panel-2 to-panel',
        )}
      >
        <div className="text-[10px] tracking-[0.35em] text-faint">SEASON REVIEW</div>
        <div className="mt-1 text-2xl font-black">
          TI{s.ti} 赛季 <span className="text-base font-medium text-mute">{s.year}</span>
        </div>
        <div className="mt-2 text-sm">
          TI 冠军：
          <span className={cx('font-bold', wonTi ? 'text-gold' : 'text-ink')}>{s.tiChampionId ? teamNameOf(game, s.tiChampionId) : '—'}</span>
          {wonTi && <span className="ml-2 text-gold">♛ 你做到了！</span>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatBox label="我的 TI 成绩">
          {s.playerTiRank ? (
            <span className={s.playerTiRank[0] === 1 ? 'text-gold' : undefined}>{formatRank(s.playerTiRank[0], s.playerTiRank[1])}</span>
          ) : (
            <span className="text-faint">未参加</span>
          )}
        </StatBox>
        <StatBox label="赛季积分排名">#{s.finalRank}</StatBox>
        <StatBox label="荣誉">
          <span className="text-sm text-mute">{Math.round(s.honorStart)}→</span>
          {Math.round(s.honorEnd)} <Delta value={Math.round(s.honorEnd - s.honorStart)} />
        </StatBox>
        <StatBox label="资金">
          <Gold value={s.goldEnd} />{' '}
          <span className={cx('text-xs', goldDelta >= 0 ? 'text-good' : 'text-bad')}>
            {goldDelta >= 0 ? '+' : ''}
            {formatGold(goldDelta)}
          </span>
        </StatBox>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <MiniTitle>本赛季冠军（{titles.length}）</MiniTitle>
          {titles.length === 0 ? (
            <div className="text-xs text-faint">本赛季未获得冠军</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {titles.map((n, i) => (
                <span key={`${n}-${i}`} className="rounded-md border border-gold/40 bg-gold/10 px-2 py-0.5 text-xs text-gold">
                  ♛ {n}
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <MiniTitle>退役选手（{retired.length}）</MiniTitle>
          {retired.length === 0 ? (
            <div className="text-xs text-faint">无人退役</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {retired.map((n, i) => (
                <span key={`${n}-${i}`} className="rounded bg-panel-3 px-1.5 py-0.5 text-xs text-mute">
                  {n}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {notes.length > 0 && (
        <div>
          <MiniTitle>赛季纪要</MiniTitle>
          <ul className="space-y-1 rounded-lg border border-line bg-panel-2/40 px-4 py-2.5 text-sm text-ink/90">
            {notes.map((n, i) => (
              <li key={i} className="whitespace-pre-line">
                · {n}
              </li>
            ))}
          </ul>
        </div>
      )}

      {game.season?.ti > ti && !game.gameOver && (
        <div className="rounded-lg border border-info/30 bg-info/10 px-4 py-2.5 text-xs text-info">
          TI{game.season.ti} 赛季已开始：新秀选秀已完成，赛季初可以报名赛事、处理选中的新秀与转会补强，准备好后点击「开始赛季 ▶」。
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 版本更新（连续多个版本合并展示）
// ---------------------------------------------------------------------------
function HeroChips({ ids, tone, label }: { ids?: string[]; tone: string; label: string }) {
  if (!ids || ids.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-[11px] text-faint">{label}</span>
      {ids.map((id) => (
        <span key={id} className={cx('rounded px-1.5 py-0.5 text-[11px]', tone)}>
          {safe(() => heroName(id), id)}
        </span>
      ))}
    </div>
  );
}

function PatchSection({ version }: { version: string }) {
  const p: PatchInfo | undefined = safe(() => patchByVersion(version), undefined);
  if (!p) {
    return (
      <div className="rounded-xl border border-line bg-panel-2/50 p-4">
        <div className="text-2xl font-black text-[#c9a6ff]">{version}</div>
        <div className="mt-1 text-sm text-mute">暂无该版本的详细数据。</div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-tier-s/30 bg-gradient-to-br from-tier-s/10 via-panel-2/60 to-panel p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-black tracking-tight text-[#c9a6ff]">{p.version}</span>
        <span className="text-xs text-mute">{p.date}</span>
        {p.major && <Badge className="bg-gold/20 text-gold">大版本</Badge>}
        {p.projected && <Badge className="bg-panel-3 text-mute">推演版本</Badge>}
      </div>
      <div className="mt-1 text-base font-semibold">{p.title}</div>
      {p.summary && <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-mute">{p.summary}</p>}

      <div className="mt-3 overflow-hidden rounded-lg border border-line">
        <table className="tbl">
          <thead>
            <tr>
              <th>位置</th>
              <th className="num">战斗力倍数</th>
              <th className="num">灵性倍数</th>
            </tr>
          </thead>
          <tbody>
            {POSITIONS.map((pos) => (
              <tr key={pos}>
                <td>
                  <PosBadge pos={pos} full />
                </td>
                <td className="num">{multCell(p.powerMult?.[pos] ?? 1)}</td>
                <td className="num">{multCell(p.insightMult?.[pos] ?? 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {((p.heroBuffs?.length ?? 0) > 0 || (p.heroNerfs?.length ?? 0) > 0 || (p.newHeroes?.length ?? 0) > 0) && (
        <div className="mt-3 space-y-1.5">
          <HeroChips ids={p.newHeroes} tone="bg-gold/15 text-gold border border-gold/30" label="新英雄" />
          <HeroChips ids={p.heroBuffs} tone="bg-good/15 text-good" label="加强" />
          <HeroChips ids={p.heroNerfs} tone="bg-bad/15 text-bad" label="削弱" />
        </div>
      )}
    </div>
  );
}

function PatchBody({ versions, game }: { versions: string[]; game: GameState }) {
  const ti = game.season?.ti ?? 0;
  // 版本按真实发布日期映射到具体回合（round.patchVersions），找不到时按当前回合展示
  const round = (game.season?.rounds ?? []).find((r) => versions.some((v) => (r.patchVersions ?? []).includes(v)));
  const roundIdx = round?.index ?? game.roundIndex;
  const range = round ? `${round.startDate} ~ ${round.endDate}` : game.currentDate;
  return (
    <div className="space-y-3">
      <div className="text-xs leading-relaxed text-mute">
        版本按发布日期落在 TI{ti} 赛季<b className="text-ink">「{roundLabel(game, ti, roundIdx)}」</b>
        {range ? <span className="text-faint">（{range}）</span> : null}
        ，在该回合开始前生效：倍数已<b className="text-ink">永久作用于所有选手对应位置的基础属性</b>，英雄强度表已按新版本重排。
        {versions.length > 1 && <span className="text-[#c9a6ff]"> 本次共 {versions.length} 个版本连续生效。</span>}
      </div>
      {versions.map((v) => (
        <PatchSection key={v} version={v} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 通知条目：连续的版本更新合并为一条；start/count 对应 game.popups 中的位置（队列从最早的开始移除）
// ---------------------------------------------------------------------------
interface NoticeGroup {
  /** 稳定键（同一条通知在新通知到达 / 较早通知被清除后保持不变） */
  key: string;
  start: number;
  count: number;
  first: Popup;
  /** 合并的版本号（仅版本更新） */
  versions: string[];
}

/** 把通知队列分组（最早 → 最新） */
export function groupNotices(popups: readonly Popup[]): NoticeGroup[] {
  const out: NoticeGroup[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < popups.length; ) {
    const first = popups[i];
    let count = 1;
    if (first?.kind === 'patch') while (i + count < popups.length && popups[i + count]?.kind === 'patch') count++;
    const versions = first?.kind === 'patch' ? popups.slice(i, i + count).map((p) => (p.kind === 'patch' ? p.version : '')).filter(Boolean) : [];
    const id =
      first?.kind === 'tournament_settlement'
        ? first.tournamentId
        : first?.kind === 'season_summary' || first?.kind === 'rookie_draft'
          ? String(first.ti)
          : first?.kind === 'patch'
            ? versions.join('>')
            : first?.kind === 'message'
              ? first.title
              : '';
    const base = `${first?.kind ?? 'unknown'}:${id}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ key: n ? `${base}#${n}` : base, start: i, count, first, versions });
    i += count;
  }
  return out;
}

const KIND_CHIP: Record<Popup['kind'], { text: string; cls: string }> = {
  tournament_settlement: { text: '赛事结算', cls: 'bg-gold/15 text-gold border-gold/40' },
  season_summary: { text: '赛季总结', cls: 'bg-dota/20 text-dota-2 border-dota/40' },
  patch: { text: '版本更新', cls: 'bg-tier-s/15 text-[#c9a6ff] border-tier-s/40' },
  rookie_draft: { text: '新秀选秀', cls: 'bg-info/15 text-info border-info/40' },
  message: { text: '消息', cls: 'bg-panel-3 text-mute border-line' },
};
const UNKNOWN_CHIP = { text: '通知', cls: 'bg-panel-3 text-mute border-line' };

interface NoticeView {
  chip: { text: string; cls: string };
  title: ReactNode;
  /** 一行摘要（收起时显示） */
  summary: ReactNode;
  body: ReactNode;
  links: { label: string; to: ViewKey; title?: string }[];
  /** 弹窗宽度（游戏结束界面的弹窗用） */
  width: string;
}

function settlementSummary(game: GameState, tournamentId: string): ReactNode {
  const t = game.tournaments[tournamentId];
  const s: TournamentSettlement | undefined =
    t?.settlement ?? (game.history?.playerSettlements ?? []).find((x) => x.tournamentId === tournamentId);
  if (!s) return '结算数据缺失';
  const honor = Math.round(s.honor?.total ?? 0);
  return (
    <>
      <b className={cx(s.rankFrom === 1 ? 'text-gold' : s.rankFrom <= 3 ? 'text-ink' : 'text-mute')}>
        {s.rankFrom === 1 && s.rankTo === 1 ? '♛ ' : ''}
        {formatRank(s.rankFrom, s.rankTo)}
      </b>
      {' · 奖金 '}
      <Gold value={s.prize} />
      {' · 荣誉 '}
      <Delta value={honor} />
      {s.points ? <span className="text-info"> · 积分 +{Math.round(s.points)}</span> : null}
    </>
  );
}

function seasonSummaryLine(game: GameState, ti: number): ReactNode {
  const s = (game.history?.seasons ?? []).find((x) => x.ti === ti);
  if (!s) return '赛季总结数据缺失';
  const me = game.settings.playerTeamId;
  return (
    <>
      TI 冠军 <span className={cx(s.tiChampionId === me ? 'text-gold' : 'text-ink')}>{s.tiChampionId ? teamNameOf(game, s.tiChampionId) : '—'}</span>
      {' · 我的 TI '}
      {s.playerTiRank ? formatRank(s.playerTiRank[0], s.playerTiRank[1]) : '未参加'}
      {' · 积分排名 #'}
      {s.finalRank}
      {' · 荣誉 '}
      <Delta value={Math.round(s.honorEnd - s.honorStart)} />
    </>
  );
}

function rookieSummary(game: GameState, ti: number): ReactNode {
  const rec = safe(() => rookieDraftRecord(game, ti), null);
  if (!rec) return '选秀记录缺失';
  const me = game.settings.playerTeamId;
  const mine = rec.picks.filter((p) => p.teamId === me && p.playerId);
  if (!mine.length) return '本届没有选中新秀';
  const names = mine.map((p) => game.players[p.playerId!]?.handle ?? p.handle ?? '?');
  return (
    <>
      你选中 <b className="text-ink">{mine.length}</b> 名新秀：{names.slice(0, 3).join('、')}
      {names.length > 3 ? ` 等` : ''}
      {game.phase === 'preseason' && game.season?.ti === ti ? <span className="text-faint">（赛季初可免费放弃）</span> : null}
    </>
  );
}

function noticeView(game: GameState, g: NoticeGroup): NoticeView {
  const p = g.first;
  switch (p?.kind) {
    case 'tournament_settlement': {
      const t = game.tournaments[p.tournamentId];
      const hist = (game.history?.tournaments ?? []).find((h) => h.tournamentId === p.tournamentId);
      return {
        chip: KIND_CHIP.tournament_settlement,
        title: t?.name ?? hist?.name ?? p.tournamentId,
        summary: settlementSummary(game, p.tournamentId),
        body: <SettlementBody game={game} tournamentId={p.tournamentId} />,
        links: [{ label: '荣誉史', to: 'club', title: '俱乐部 / 荣誉史' }],
        width: 'max-w-3xl',
      };
    }
    case 'season_summary':
      return {
        chip: KIND_CHIP.season_summary,
        title: `TI${p.ti} 赛季总结`,
        summary: seasonSummaryLine(game, p.ti),
        body: <SeasonSummaryBody game={game} ti={p.ti} />,
        links: !game.gameOver && game.season?.ti > p.ti ? [{ label: '新赛季赛程', to: 'schedule', title: '赛事 / 赛程报名' }] : [],
        width: 'max-w-2xl',
      };
    case 'patch': {
      const last = g.versions.length ? safe(() => patchByVersion(g.versions[g.versions.length - 1]), undefined) : undefined;
      return {
        chip: KIND_CHIP.patch,
        title: (
          <span>
            版本 <span className="text-[#c9a6ff]">{g.versions.join(' → ')}</span>
          </span>
        ),
        summary: last?.title ? `${last.title}${g.versions.length > 1 ? `（共 ${g.versions.length} 个版本连续生效）` : ''}` : '倍数已作用于对应位置的基础属性，英雄强度表已重排',
        body: <PatchBody versions={g.versions} game={game} />,
        links: [{ label: '版本详情', to: 'patches', title: '赛事 / 版本' }],
        width: 'max-w-2xl',
      };
    }
    case 'rookie_draft':
      return {
        chip: KIND_CHIP.rookie_draft,
        title: `TI${p.ti} 新秀选秀结果`,
        summary: rookieSummary(game, p.ti),
        body: <RookieDraftPopupBody game={game} ti={p.ti} />,
        links: [{ label: '新秀选秀', to: 'draft', title: '转会 / 新秀选秀' }],
        width: 'max-w-4xl',
      };
    case 'message':
      return {
        chip: KIND_CHIP.message,
        title: p.title || '通知',
        summary: (p.body || '').split('\n')[0] || '（无内容）',
        body: <p className="whitespace-pre-line text-sm leading-relaxed text-ink/90">{p.body || '（无内容）'}</p>,
        links: [],
        width: 'max-w-lg',
      };
    default:
      // 旧存档 / 未知类型：给出兜底，保证可以清除
      return {
        chip: UNKNOWN_CHIP,
        title: '通知',
        summary: '无法识别的通知内容',
        body: <EmptyState text="无法识别的通知内容，可点击「全部已读」清除。" />,
        links: [],
        width: 'max-w-lg',
      };
  }
}

/**
 * 清除队列最前面（最早）的 n 条：多人模式下在服务器推送新状态前先在本地隐藏，避免重复点击。
 * 返回 [当前已在清除中的条数, 清除函数]。
 */
function useDismissPopups(total: number): [number, (n: number) => void] {
  const callSilent = useCallSilent();
  const [pending, setPending] = useState<{ len: number; n: number } | null>(null);
  const hidden = pending && pending.len === total ? Math.min(pending.n, total) : 0;
  const dismiss = (n: number) => {
    const k = Math.max(0, Math.min(Math.floor(n), total - hidden));
    if (!k) return;
    setPending({ len: total, n: hidden + k });
    void callSilent('dismissPopups', k).finally(() => setPending(null));
  };
  return [hidden, dismiss];
}

// ---------------------------------------------------------------------------
// 总览「通知」卡片
// ---------------------------------------------------------------------------
/** 默认显示的最新条数，其余折叠 */
const NOTICES_VISIBLE = 4;

export function NoticesCard({ className }: { className?: string }) {
  const game = useGame();
  const setView = useGameStore((s) => s.setView);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const popups = game.popups ?? [];
  const [hidden, dismiss] = useDismissPopups(popups.length);
  const groups = groupNotices(popups.slice(hidden)).reverse(); // 最新在前
  if (!groups.length) return null;

  const visible = showAll ? groups : groups.slice(0, NOTICES_VISIBLE);
  const older = groups.slice(visible.length);
  const olderRaw = older.reduce((n, g) => n + g.count, 0);
  const toggle = (key: string) =>
    setOpenKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section
      className={cx(
        'fade-up relative overflow-hidden rounded-xl border border-info/30 bg-gradient-to-br from-info/[0.06] via-panel to-panel shadow-lg shadow-black/20',
        className,
      )}
      aria-label="通知"
    >
      <span className="absolute inset-y-0 left-0 w-1 bg-info/70" />
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/70 px-4 py-2 pl-5">
        <span className="text-[11px] font-bold tracking-[0.2em] text-info">通知</span>
        <span className="rounded-full bg-info/20 px-1.5 text-[10px] font-bold leading-4 text-info tabular">{groups.length}</span>
        <span className="text-[11px] text-faint">最新在前 · 点击查看详情，不影响推进回合</span>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          title="清空全部通知（详情可在赛事中心、荣誉史、版本页等处查看）"
          onClick={() => {
            setOpenKeys(new Set());
            setShowAll(false);
            dismiss(popups.length - hidden);
          }}
        >
          ✓ 全部已读
        </Button>
      </header>
      <ul className="divide-y divide-line/50">
        {visible.map((g, i) => {
          const v = noticeView(game, g);
          const open = openKeys.has(g.key);
          return (
            <li key={g.key}>
              <button
                type="button"
                onClick={() => toggle(g.key)}
                aria-expanded={open}
                className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 pl-5 text-left transition-colors hover:bg-panel-2/50"
              >
                <span className={cx('shrink-0 rounded border px-1.5 py-px text-[10px] font-semibold', v.chip.cls)}>{v.chip.text}</span>
                <span className="max-w-[40%] shrink-0 truncate text-sm font-medium text-ink">{v.title}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-mute">{v.summary}</span>
                {i === 0 && groups.length > 1 && !showAll && <span className="shrink-0 text-[10px] text-gold">最新</span>}
                <span className="shrink-0 text-[11px] text-faint">{open ? '收起 ▴' : '详情 ▾'}</span>
              </button>
              {open && (
                <div className="border-t border-line/50 bg-panel-2/20 px-4 py-3 pl-5">
                  {v.body}
                  {v.links.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {v.links.map((l) => (
                        <Button key={l.label} size="xs" variant="ghost" title={l.title} onClick={() => setView(l.to)}>
                          {l.label} ›
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {(older.length > 0 || showAll) && groups.length > NOTICES_VISIBLE && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line/60 px-4 py-1.5 pl-5 text-[11px] text-faint">
          {showAll ? (
            <button type="button" className="cursor-pointer hover:text-ink" onClick={() => setShowAll(false)}>
              只看最新 {NOTICES_VISIBLE} 条 ▴
            </button>
          ) : (
            <>
              <span>还有 {older.length} 条较早的通知</span>
              <button type="button" className="cursor-pointer text-mute hover:text-ink" onClick={() => setShowAll(true)}>
                展开 ▾
              </button>
              <button
                type="button"
                className="ml-auto cursor-pointer text-mute hover:text-gold"
                title="只清除较早的通知，保留最新的几条"
                onClick={() => dismiss(olderRaw)}
              >
                清除较早的 {older.length} 条
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 其他页面：左下角的通知徽标（不阻塞操作，点击回到总览）。
// 放在侧栏底部的空白处（侧栏宽 w-40，只有顶部 6 个入口）：不会盖住页面内容——
// 放在右下角时会挡住表格行尾的操作按钮（如转会市场的「签约」），误点会直接跳回总览。
// ---------------------------------------------------------------------------
const BADGE_FRESH_MS = 4000;

export function NoticeBadge() {
  const game = useGame();
  const view = useGameStore((s) => s.view);
  const setView = useGameStore((s) => s.setView);
  const count = groupNotices(game.popups ?? []).length;
  // 有新通知到达时短暂高亮
  const prev = useRef(count);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const grew = count > prev.current;
    prev.current = count;
    if (!grew) return;
    setFresh(true);
    const id = setTimeout(() => setFresh(false), BADGE_FRESH_MS);
    return () => clearTimeout(id);
  }, [count]);
  // 总览顶部已有通知卡片；比赛页进行中的比赛不打扰
  if (!count || view === 'dashboard' || (view === 'match' && game.activeMatch)) return null;
  return (
    <button
      type="button"
      onClick={() => setView('dashboard')}
      title={`${count} 条新通知（赛事结算、版本更新等）：点击回到总览查看`}
      className={cx(
        'fade-up fixed bottom-24 left-2 z-40 flex w-36 cursor-pointer items-center gap-2 rounded-lg border bg-panel/95 px-2.5 py-1.5 text-left text-xs shadow-lg shadow-black/40 backdrop-blur transition-colors',
        fresh ? 'border-info text-info ring-2 ring-info/40' : 'border-line text-ink hover:border-info hover:text-info',
      )}
    >
      <span className={cx('h-2 w-2 shrink-0 rounded-full bg-info', fresh && 'animate-pulse')} />
      <span className="min-w-0 leading-tight">
        <span className="block font-semibold">
          <span className="tabular">{count}</span> 条新通知
        </span>
        <span className="block text-[11px] text-mute">回总览查看 ›</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 游戏结束界面：逐条弹窗（没有总览可以承载通知卡片，保持原样）
// ---------------------------------------------------------------------------
export default function PopupHost() {
  const game = useGame();
  const setView = useGameStore((s) => s.setView);
  // 从弹窗里点开选手/战队详情时暂时让位（两者同为 z-50，PopupHost 在 DOM 中更靠后会盖住详情弹窗），关闭详情后弹窗恢复
  const detailOpen = useGameStore((s) => s.selectedPlayerId !== null || s.selectedTeamId !== null);
  const popups = game.popups ?? [];
  const [hidden, dismiss] = useDismissPopups(popups.length);
  const groups = groupNotices(popups.slice(hidden));
  const g = groups[0];
  if (!g || detailOpen) return null;
  const remaining = groups.length - 1;
  const v = noticeView(game, g);
  const close = () => dismiss(g.count);

  return (
    <Modal
      key={`${popups.length}-${g.key}`}
      open
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <span className={cx('rounded border px-1.5 py-px text-[10px] font-semibold', v.chip.cls)}>{v.chip.text}</span>
          {v.title}
          {remaining > 0 && <span className="rounded-full bg-panel-3 px-2 py-0.5 text-[10px] font-normal text-mute">还有 {remaining} 条</span>}
        </span>
      }
      width={v.width}
      footer={
        <>
          {!game.gameOver &&
            v.links.map((l) => (
              <Button
                key={l.label}
                variant="ghost"
                onClick={() => {
                  close();
                  setView(l.to);
                }}
              >
                {l.label}
              </Button>
            ))}
          <Button variant="primary" onClick={close} className="min-w-24">
            {remaining > 0 ? '下一条 ›' : '知道了'}
          </Button>
        </>
      }
    >
      {v.body}
    </Modal>
  );
}

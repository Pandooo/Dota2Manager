// 版本更新：当前版本倍数、英雄改动、本存档版本时间线、本赛季即将到来的版本（按回合）
import { useState } from 'react';
import { useGame } from '../../store/gameStore';
import type { GameState, PatchInfo, Position } from '../../engine/types';
import { POSITIONS } from '../../engine/types';
import { POSITION_LABEL, heroName, lineupPlayers, patchByVersion } from '../../engine';
import { Badge, Card, EmptyState, Hint, PlayerLink, PosBadge, cx } from '../components/common';
import { ScreenHeader } from '../layout/HubKit';
import { MultValue, PHASE_LABEL, dateRange, safe } from '../components/TourShared';

function hn(id: string): string {
  return safe(() => heroName(id), id);
}

function pct(v: number | undefined): string {
  const d = ((typeof v === 'number' && Number.isFinite(v) ? v : 1) - 1) * 100;
  if (Math.abs(d) < 0.05) return '±0%';
  return `${d > 0 ? '+' : ''}${d.toFixed(1)}%`;
}

/** 倍数 → 背景色强度 */
function multBg(v: number | undefined): string {
  const d = (typeof v === 'number' && Number.isFinite(v) ? v : 1) - 1;
  if (Math.abs(d) < 0.0005) return 'bg-panel-2/40';
  if (d > 0) return d >= 0.02 ? 'bg-good/25' : d >= 0.01 ? 'bg-good/15' : 'bg-good/8';
  return d <= -0.02 ? 'bg-bad/25' : d <= -0.01 ? 'bg-bad/15' : 'bg-bad/8';
}

/** 位置倍数表 */
function MultTable({ game, patch }: { game: GameState; patch: PatchInfo }) {
  const me = game.settings.playerTeamId;
  const starters = safe(() => lineupPlayers(game, me), []);
  const starterOf = (pos: Position) => starters.find((s) => s.pos === pos)?.player ?? null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-xs">
        <thead>
          <tr>
            <th className="w-20 text-left font-normal text-faint" />
            {POSITIONS.map((pos) => (
              <th key={pos} className="font-normal">
                <div className="flex flex-col items-center gap-0.5">
                  <PosBadge pos={pos} />
                  <span className="hidden text-[10px] text-faint lg:block">{POSITION_LABEL[pos].split(' ')[1] ?? ''}</span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(
            [
              ['战斗力', patch.powerMult],
              ['灵性', patch.insightMult],
            ] as const
          ).map(([label, mults]) => (
            <tr key={label}>
              <td className="pr-2 text-mute">{label}倍数</td>
              {POSITIONS.map((pos) => (
                <td key={pos} className={cx('rounded-md px-2 py-2 text-center', multBg(mults?.[pos]))}>
                  <MultValue v={mults?.[pos]} className="block text-sm font-semibold" />
                  <span className="text-[10px] text-faint">{pct(mults?.[pos])}</span>
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td className="pr-2 text-mute">本队首发</td>
            {POSITIONS.map((pos) => {
              const p = starterOf(pos);
              return (
                <td key={pos} className="truncate px-1 text-center">
                  {p ? <PlayerLink player={p} className="text-xs" /> : <span className="text-faint">空缺</span>}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function HeroChips({ ids, cls, empty }: { ids?: string[]; cls: string; empty?: string }) {
  if (!ids || ids.length === 0) return <span className="text-xs text-faint">{empty ?? '无'}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <span key={id} className={cx('rounded border px-1.5 py-0.5 text-xs', cls)} title={id}>
          {hn(id)}
        </span>
      ))}
    </div>
  );
}

type PatchTag = 'current' | 'applied' | 'upcoming';

export default function Patches() {
  const game = useGame();
  const [viewVersion, setViewVersion] = useState<string | null>(null);
  const rounds = game.season?.rounds ?? [];
  const applied = (game.appliedPatches ?? []).slice().reverse();
  const upcoming = rounds
    .filter((r) => r.index > game.roundIndex)
    .flatMap((r) => (r.patchVersions ?? []).map((v) => ({ v, r })));
  const seasonPatches = rounds.flatMap((r) => (r.patchVersions ?? []).map((v) => ({ v, r })));

  const tagOf = (v: string): PatchTag => (v === game.currentPatch ? 'current' : upcoming.some((u) => u.v === v) ? 'upcoming' : 'applied');
  const shownVersion = viewVersion ?? game.currentPatch;
  const patch = shownVersion ? safe(() => patchByVersion(shownVersion), undefined) : undefined;
  const shownTag = tagOf(shownVersion);
  const shownRound = seasonPatches.find((x) => x.v === shownVersion)?.r;

  // 版本强度
  const meta = Object.entries(game.heroMeta ?? {}).filter(([, v]) => Number.isFinite(v));
  const strong = meta.slice().sort((a, b) => b[1] - a[1]).slice(0, 8);
  const weak = meta.slice().sort((a, b) => a[1] - b[1]).slice(0, 6);

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="版本更新"
        subtitle={`当前版本 ${game.currentPatch || '—'} · 本存档已应用 ${applied.length} 个版本 · 本赛季还有 ${upcoming.length} 次更新`}
      />

      <div className="rounded-xl border border-info/30 bg-info/5 px-4 py-3 text-xs leading-relaxed text-mute">
        <span className="font-semibold text-info">版本如何生效：</span>
        每个版本按<span className="text-ink">真实发布日期</span>映射到其所在的大回合，在<span className="text-ink">该回合开始时</span>
        生效（而不是赛季开始时）；一个赛季可能有多次更新，也可能某些回合没有更新。更新的倍数会
        <span className="text-ink">永久</span>作用于所有现役选手对应位置的<span className="text-ink">基础战斗力与灵性</span>
        （例如 1 号位 ×1.02 = 所有 1 号位选手战力永久 +2%），同时重新生成英雄强度表，影响 BP。
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          {!patch ? (
            <Card>
              <EmptyState text="暂无版本数据" />
            </Card>
          ) : (
            <Card
              className={shownTag === 'current' ? 'border-info/40' : undefined}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-black tracking-wide text-ink">{patch.version}</span>
                  {shownTag === 'current' && <Badge className="bg-info/20 text-info border border-info/40">当前版本</Badge>}
                  {shownTag === 'upcoming' && <Badge className="bg-gold/15 text-gold border border-gold/40">即将生效</Badge>}
                  {shownTag === 'applied' && <Badge>历史版本</Badge>}
                  {patch.major && <Badge className="bg-dota/20 text-dota-2 border border-dota/40">大版本</Badge>}
                  {patch.projected && <Badge className="bg-panel-3 text-faint" title="超出真实数据的未来版本，倍数为推演">推演</Badge>}
                </span>
              }
              subtitle={
                <>
                  发布于 {patch.date}
                  {shownRound ? ` · 第 ${shownRound.index} 回合（${PHASE_LABEL[shownRound.phase]}）开始时生效` : ''}
                </>
              }
              actions={
                viewVersion && viewVersion !== game.currentPatch ? (
                  <button className="cursor-pointer text-xs text-mute hover:text-ink" onClick={() => setViewVersion(null)}>
                    返回当前版本
                  </button>
                ) : undefined
              }
            >
              <div className="mb-3">
                <div className="text-sm font-semibold">{patch.title}</div>
                <p className="mt-1 text-sm leading-relaxed text-mute">{patch.summary}</p>
              </div>
              <MultTable game={game} patch={patch} />
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div>
                  <div className="mb-1.5 text-[11px] text-good">加强英雄</div>
                  <HeroChips ids={patch.heroBuffs} cls="border-good/40 bg-good/10 text-good" />
                </div>
                <div>
                  <div className="mb-1.5 text-[11px] text-bad">削弱英雄</div>
                  <HeroChips ids={patch.heroNerfs} cls="border-bad/40 bg-bad/10 text-bad" />
                </div>
                <div>
                  <div className="mb-1.5 text-[11px] text-gold">新英雄</div>
                  <HeroChips ids={patch.newHeroes} cls="border-gold/40 bg-gold/10 text-gold" />
                </div>
              </div>
            </Card>
          )}

          <Card title="当前版本英雄强度" subtitle="版本强势英雄在 BP 中价值更高（-2 ~ +2）">
            {meta.length === 0 ? (
              <EmptyState text="英雄强度表尚未生成" />
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="mb-2 text-[11px] text-good">版本强势</div>
                  <div className="space-y-1">
                    {strong.map(([id, v]) => (
                      <MetaRow key={id} id={id} v={v} />
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-[11px] text-bad">版本弱势</div>
                  <div className="space-y-1">
                    {weak.map(([id, v]) => (
                      <MetaRow key={id} id={id} v={v} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card title="本赛季版本路线" subtitle={`TI${game.season.ti} 赛季 · 共 ${seasonPatches.length} 次更新`}>
            <RoundStrip game={game} onPick={setViewVersion} />
            <div className="mt-3 space-y-1.5">
              {upcoming.length === 0 ? (
                <div className="text-xs text-faint">本赛季后续回合没有版本更新。</div>
              ) : (
                upcoming.map(({ v, r }) => {
                  const p = safe(() => patchByVersion(v), undefined);
                  return (
                    <button
                      key={v}
                      onClick={() => setViewVersion(v)}
                      className={cx(
                        'w-full cursor-pointer rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:border-gold/50',
                        shownVersion === v ? 'border-gold/60 bg-gold/10' : 'border-line bg-panel-2/50',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-gold">{v}</span>
                        <span className="text-faint">
                          将在第 {r.index} 回合生效 · {r.startDate}
                        </span>
                      </div>
                      {p && <div className="mt-0.5 truncate text-mute">{p.title}</div>}
                    </button>
                  );
                })
              )}
            </div>
          </Card>

          <Card title="版本时间线" subtitle="本存档已应用的版本（新 → 旧）" bodyClassName="p-0">
            {applied.length === 0 ? (
              <EmptyState text="尚未应用任何版本" />
            ) : (
              <div className="max-h-[520px] overflow-y-auto py-2">
                {applied.map((v, i) => {
                  const p = safe(() => patchByVersion(v), undefined);
                  const best = p ? POSITIONS.slice().sort((a, b) => (p.powerMult[b] ?? 1) - (p.powerMult[a] ?? 1))[0] : null;
                  const worst = p ? POSITIONS.slice().sort((a, b) => (p.powerMult[a] ?? 1) - (p.powerMult[b] ?? 1))[0] : null;
                  return (
                    <button
                      key={`${v}-${i}`}
                      onClick={() => setViewVersion(v)}
                      className={cx(
                        'relative block w-full cursor-pointer py-1.5 pl-8 pr-3 text-left text-xs hover:bg-panel-2/60',
                        shownVersion === v && 'bg-panel-2/80',
                      )}
                    >
                      <span className="absolute bottom-0 left-4 top-0 w-px bg-line" />
                      <span
                        className={cx(
                          'absolute left-[13px] top-3 h-2 w-2 rounded-full border',
                          v === game.currentPatch ? 'border-info bg-info' : p?.major ? 'border-dota-2 bg-dota' : 'border-mute bg-panel',
                        )}
                      />
                      <div className="flex items-center gap-2">
                        <span className={cx('font-semibold', v === game.currentPatch ? 'text-info' : 'text-ink')}>{v}</span>
                        {p?.major && <span className="text-[10px] text-dota-2">大版本</span>}
                        <span className="ml-auto text-faint tabular">{p?.date ?? ''}</span>
                      </div>
                      {p && (
                        <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                          <span className="min-w-0 flex-1 truncate text-mute">{p.title}</span>
                          {best && (p.powerMult[best] ?? 1) > 1.0005 && (
                            <span className="shrink-0 text-good">
                              {POSITION_LABEL[best].split(' ')[0]} {pct(p.powerMult[best])}
                            </span>
                          )}
                          {worst && (p.powerMult[worst] ?? 1) < 0.9995 && (
                            <span className="shrink-0 text-bad">
                              {POSITION_LABEL[worst].split(' ')[0]} {pct(p.powerMult[worst])}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
          <Hint>点击任意版本可在左侧查看其完整倍数与英雄改动。</Hint>
        </div>
      </div>
    </div>
  );
}

function MetaRow({ id, v }: { id: string; v: number }) {
  const w = Math.min(100, (Math.abs(v) / 2) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 truncate" title={id}>
        {hn(id)}
      </span>
      <div className="relative h-1.5 flex-1 rounded-full bg-panel-3">
        <span className="absolute left-1/2 top-0 h-full w-px bg-line" />
        <span
          className={cx('absolute top-0 h-full rounded-full', v >= 0 ? 'left-1/2 bg-good' : 'right-1/2 bg-bad')}
          style={{ width: `${w / 2}%` }}
        />
      </div>
      <span className={cx('w-10 shrink-0 text-right tabular', v >= 0 ? 'text-good' : 'text-bad')}>
        {v > 0 ? '+' : ''}
        {v.toFixed(2)}
      </span>
    </div>
  );
}

/** 本赛季每个回合一个格子：有版本更新的回合高亮 */
function RoundStrip({ game, onPick }: { game: GameState; onPick: (v: string) => void }) {
  const rounds = game.season?.rounds ?? [];
  if (rounds.length === 0) return null;
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {rounds.map((r) => {
          const has = (r.patchVersions ?? []).length > 0;
          const isCur = r.index === game.roundIndex;
          const past = r.index < game.roundIndex;
          return (
            <button
              key={r.index}
              disabled={!has}
              onClick={() => has && onPick(r.patchVersions[r.patchVersions.length - 1])}
              title={`第 ${r.index} 回合 · ${PHASE_LABEL[r.phase]} · ${dateRange(r.startDate, r.endDate)}${has ? `\n版本：${r.patchVersions.join('、')}` : '\n无版本更新'}`}
              className={cx(
                'relative grid h-7 w-7 place-items-center rounded text-[10px] tabular transition-colors',
                has ? (past || isCur ? 'bg-info/30 text-info' : 'bg-gold/25 text-gold') : 'bg-panel-3 text-faint',
                has ? 'cursor-pointer hover:brightness-125' : 'cursor-default',
                isCur && 'ring-2 ring-gold',
                r.phase === 'ti' && !has && 'bg-gold/10',
              )}
            >
              {r.index === 0 ? '初' : r.phase === 'ti' ? 'TI' : r.phase === 'ti_qualifier' ? '预' : r.index}
              {has && r.patchVersions.length > 1 && (
                <span className="absolute -right-1 -top-1 rounded-full bg-dota px-1 text-[8px] leading-3 text-white">{r.patchVersions.length}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-faint">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-info/30" />
          已生效
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-gold/25" />
          即将生效
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm ring-2 ring-gold" />
          当前回合
        </span>
      </div>
    </div>
  );
}

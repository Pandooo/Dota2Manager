// ============================================================================
// 系列赛对局详情弹窗（赛事中心点击已完成的系列赛）
// ============================================================================
import type { DraftAction, GameRecord, GameState, Series } from '../../engine/types';
import { POSITIONS } from '../../engine/types';
import { heroName } from '../../engine';
import { Badge, Modal, PosBadge, cx } from './common';
import { safe, teamInfo, TeamName } from './TourShared';

function hn(id: string): string {
  return safe(() => heroName(id), id);
}

function DraftSide({ game, actions, color }: { game: GameState; actions: DraftAction[]; color: string }) {
  // 选人按位置 1→5 排列（无位置的放最后，保持原 BP 顺序）
  const posIdx = (a: DraftAction) => (a.position ? POSITIONS.indexOf(a.position) : 99);
  const picks = actions
    .map((a, i) => ({ a, i }))
    .filter((x) => x.a.type === 'pick')
    .sort((x, y) => posIdx(x.a) - posIdx(y.a) || x.i - y.i)
    .map((x) => x.a);
  const bans = actions.filter((a) => a.type === 'ban');
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="space-y-1">
        {picks.length === 0 && <div className="text-xs text-faint">无选人记录</div>}
        {picks.map((a, i) => {
          const p = a.playerId ? game.players[a.playerId] : undefined;
          return (
            <div key={`${a.heroId}-${i}`} className="flex items-center gap-1.5 text-xs">
              <span className="h-3 w-0.5 shrink-0 rounded" style={{ background: color }} />
              {a.position ? <PosBadge pos={a.position} /> : <span className="w-10" />}
              <span className="truncate font-medium text-ink">{hn(a.heroId)}</span>
              {p && <span className="truncate text-faint">· {p.handle}</span>}
            </div>
          );
        })}
      </div>
      {bans.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {bans.map((a, i) => (
            <span key={`${a.heroId}-b${i}`} className="rounded bg-panel-3 px-1.5 py-0.5 text-[10px] text-faint line-through" title="禁用">
              {hn(a.heroId)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function GameCard({ game, g, n }: { game: GameState; g: GameRecord; n: number }) {
  const a = teamInfo(game, g.teamA);
  const b = teamInfo(game, g.teamB);
  const winner = g.winner === 'A' ? a : b;
  const radiantTeam = g.radiant === 'A' ? a : b;
  const draft = Array.isArray(g.draft) ? g.draft : [];
  const mvp = g.mvpPlayerId ? game.players[g.mvpPlayerId] : undefined;
  const dp = g.eval?.dotaPlusWinRateA;
  return (
    <div className="rounded-lg border border-line bg-panel-2/50">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2 text-xs">
        <span className="text-sm font-semibold">第 {n} 局</span>
        <span>
          胜者 <span className={cx('font-semibold', winner.isPlayer ? 'text-gold' : 'text-ink')}>{winner.name}</span>
        </span>
        <span className="text-mute">
          时长 <span className="tabular text-ink">{Number.isFinite(g.durationMin) ? Math.round(g.durationMin) : '?'}</span> 分钟
        </span>
        <span className="text-mute">
          击杀 <span className="tabular text-ink">{g.killsA ?? 0}</span> : <span className="tabular text-ink">{g.killsB ?? 0}</span>
        </span>
        <span className="text-mute">
          <span className="text-radiant">天辉</span> {radiantTeam.tag}
        </span>
        {typeof dp === 'number' && (
          <span className="text-mute" title="BP 结束时大老师给出的胜率（左侧战队）">
            大老师胜率 <span className="tabular text-info">{Math.round(dp * 100)}%</span>
          </span>
        )}
        {typeof g.winProbA === 'number' && (
          <span className="text-mute" title="综合 BP 与实力的最终胜率（左侧战队）">
            综合胜率 <span className="tabular text-ink">{Math.round(g.winProbA * 100)}%</span>
          </span>
        )}
        {mvp && <Badge className="bg-gold/15 text-gold border border-gold/40">MVP {mvp.handle}</Badge>}
      </div>
      {draft.length === 0 ? (
        <div className="px-3 py-2 text-xs text-faint">后台模拟对局，未记录 BP 详情。</div>
      ) : (
        <div className="grid gap-4 p-3 sm:grid-cols-2">
          {(['A', 'B'] as const).map((side) => {
            const info = side === 'A' ? a : b;
            const isRadiant = g.radiant === side;
            return (
              <div key={side} className="min-w-0">
                <div className="mb-1.5 flex items-center gap-2 text-xs">
                  <TeamName game={game} teamId={side === 'A' ? g.teamA : g.teamB} />
                  <span className={cx('text-[10px]', isRadiant ? 'text-radiant' : 'text-dire')}>{isRadiant ? '天辉' : '夜魇'}</span>
                  {g.winner === side && <span className="text-[10px] font-bold text-good">胜</span>}
                </div>
                <DraftSide game={game} actions={draft.filter((d) => d.side === side)} color={info.color} />
              </div>
            );
          })}
        </div>
      )}
      {((g.incidents && g.incidents.length > 0) || (g.eval?.notes && g.eval.notes.length > 0)) && (
        <div className="space-y-1 border-t border-line px-3 py-2 text-xs text-mute">
          {g.eval?.notes?.slice(0, 3).map((t, i) => (
            <div key={`n${i}`}>· {t}</div>
          ))}
          {g.incidents?.map((ev, i) => (
            <div key={`i${i}`} className="text-[#e0a35f]">
              ⚠ {ev.minute}' {ev.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SeriesModal({ game, series, onClose }: { game: GameState; series: Series | null; onClose: () => void }) {
  const res = series?.result;
  const games = res?.games ?? [];
  return (
    <Modal
      open={!!series}
      onClose={onClose}
      width="max-w-3xl"
      title={
        series ? (
          <span className="flex flex-wrap items-center gap-2">
            <span>{series.label}</span>
            <Badge>Bo{series.bestOf}</Badge>
          </span>
        ) : null
      }
    >
      {series && (
        <div className="space-y-4">
          <div className="flex items-center justify-center gap-6 rounded-lg border border-line bg-panel-2/60 py-4">
            <div className="flex min-w-0 flex-1 justify-end">
              <TeamName game={game} teamId={series.teamA} className={cx('text-base', res?.winnerId === series.teamA && 'font-bold')} />
            </div>
            <div className="shrink-0 text-2xl font-black tabular">
              <span className={res && res.scoreA > res.scoreB ? 'text-ink' : 'text-mute'}>{res?.scoreA ?? '-'}</span>
              <span className="mx-2 text-faint">:</span>
              <span className={res && res.scoreB > res.scoreA ? 'text-ink' : 'text-mute'}>{res?.scoreB ?? '-'}</span>
            </div>
            <div className="flex min-w-0 flex-1 justify-start">
              <TeamName game={game} teamId={series.teamB} className={cx('text-base', res?.winnerId === series.teamB && 'font-bold')} />
            </div>
          </div>
          {series.loserPlacement && (
            <div className="text-center text-xs text-faint">
              败者获得第 {series.loserPlacement[0]}
              {series.loserPlacement[1] !== series.loserPlacement[0] ? `-${series.loserPlacement[1]}` : ''} 名
            </div>
          )}
          {games.length === 0 ? (
            <div className="py-6 text-center text-sm text-mute">该系列赛为后台模拟，未记录逐局详情。</div>
          ) : (
            games.map((g, i) => <GameCard key={i} game={game} g={g} n={i + 1} />)
          )}
        </div>
      )}
    </Modal>
  );
}

// ============================================================================
// 房间设置（房主可改，其他玩家只读）：起止 TI 卡片（默认 TI1 → TI16）、难度、玩法（各自组建 / 选择已有战队）
// ============================================================================
import { useMemo, useState } from 'react';
import { MAX_TI, formatGold, tiYear, type TiInfo } from '../../engine';
import { availableStartTis, getAllTiInfo } from '../../data/index';
import type { MpMode, RoomSettings } from '../../shared/protocol';
import { Card, cx } from './common';
import { DIFFICULTY_LABEL, prettySlug, safe, type Difficulty } from './ShellKit';
import { MP_MODE_LABEL, MP_MODE_RULE } from './MpKit';
import { BREAKPOINT, useMinWidth } from '../mobile';

function StartTiCard({ info, available, selected, editable, onSelect }: { info: TiInfo; available: boolean; selected: boolean; editable: boolean; onSelect: () => void }) {
  const clickable = available && editable;
  return (
    <button
      onClick={clickable ? onSelect : undefined}
      disabled={!available || (!editable && !selected)}
      title={available ? `${info.name}（${info.city}）${editable ? '' : ' · 起始 TI 由房主设置'}` : '暂无该届阵容数据，无法作为起点'}
      className={cx(
        'relative flex flex-col overflow-hidden rounded-lg border px-2.5 py-2 text-left transition-all',
        'disabled:opacity-35',
        clickable ? 'cursor-pointer' : 'cursor-default',
        selected
          ? 'border-gold bg-gradient-to-br from-gold/15 via-panel-2 to-panel-2 shadow-lg shadow-gold/10'
          : cx('border-line bg-panel-2/60', clickable && 'hover:border-gold/40 hover:bg-panel-2'),
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={cx('text-lg font-black italic tracking-tight', selected ? 'text-gold' : 'text-ink')}>TI{info.ti}</span>
        <span className="text-[11px] tabular text-mute">{info.year}</span>
      </div>
      <div className="truncate text-[11px] text-mute">{info.city}</div>
      <div className="truncate text-[10px] text-faint">
        冠军 <span className="text-ink">{info.champion ? prettySlug(info.champion) : info.projected ? '待揭晓' : '—'}</span>
      </div>
      <div className="text-[10px] text-faint">
        奖金池 <span className="tabular text-gold">{formatGold(info.prizePool)}</span>
      </div>
      {selected && <span className="absolute right-0 top-0 h-0 w-0 border-l-[14px] border-t-[14px] border-l-transparent border-t-gold" />}
    </button>
  );
}

export default function MpRoomSettings({
  settings,
  editable,
  onChange,
}: {
  settings: RoomSettings;
  editable: boolean;
  onChange: (patch: Partial<RoomSettings>) => void;
}) {
  const allTis = useMemo(() => safe(() => getAllTiInfo(), [] as TiInfo[]).filter((t) => t.ti >= 1 && t.ti <= MAX_TI - 1), []);
  const startTis = useMemo(() => safe(() => availableStartTis(), [] as number[]), []);
  const { startTi, endTi, difficulty, mode } = settings;
  const seasons = Math.max(1, endTi - startTi + 1);

  const pickStart = (ti: number) => onChange(ti > endTi ? { startTi: ti, endTi: Math.max(ti, endTi) } : { startTi: ti });
  // < xl 的非房主：设置只读，默认只显示一行摘要（不用先滑过十几张不能点的 TI 卡片），可展开查看
  const wide = useMinWidth(BREAKPOINT.xl);
  const [open, setOpen] = useState(false);
  const compact = !editable && !wide && !open;
  const startInfo = allTis.find((t) => t.ti === startTi);

  return (
    <Card
      title="对局设置"
      subtitle={editable ? '房主设置；修改后所有玩家需要重新确认准备' : '由房主设置'}
      actions={<span className="text-xs text-mute">TI{startTi} → TI{endTi} · 共 {seasons} 个赛季</span>}
    >
      {!editable && !wide && (
        <div className={cx('flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm', !compact && 'mb-4')}>
          <span className="min-w-0">
            起始 <span className="font-semibold text-gold">TI{startTi}</span>
            {startInfo && <span className="text-xs text-mute">（{startInfo.year} · {startInfo.city}）</span>} → 终点{' '}
            <span className="font-semibold text-gold">TI{endTi}</span>
            <span className="text-mute"> · {DIFFICULTY_LABEL[difficulty]} · {MP_MODE_LABEL[mode]}</span>
          </span>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="min-h-9 shrink-0 cursor-pointer text-xs text-info hover:text-gold"
          >
            {open ? '收起 ▴' : '查看设置详情 ▾'}
          </button>
        </div>
      )}
      {!compact && (
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 text-xs font-medium text-mute">起始 TI（各战队使用该届 TI 参赛时的真实阵容）</div>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 xl:grid-cols-6">
            {allTis.map((info) => (
              <StartTiCard
                key={info.ti}
                info={info}
                available={startTis.includes(info.ti)}
                selected={startTi === info.ti}
                editable={editable}
                onSelect={() => pickStart(info.ti)}
              />
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-mute">终点 TI（该届 TI 结算后对局结束）</div>
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
            {Array.from({ length: MAX_TI - startTi + 1 }, (_, i) => startTi + i).map((ti) => {
              const sel = ti === endTi;
              return (
                <button
                  key={ti}
                  disabled={!editable && !sel}
                  onClick={editable ? () => onChange({ endTi: ti }) : undefined}
                  className={cx(
                    'min-w-0 rounded-md border px-2 py-1 text-left transition-colors disabled:opacity-35',
                    editable ? 'cursor-pointer' : 'cursor-default',
                    sel ? 'border-gold bg-gold/15' : cx('border-line bg-panel-2/50', editable && 'hover:border-gold/40'),
                  )}
                >
                  <div className={cx('text-sm font-black', sel ? 'text-gold' : 'text-ink')}>TI{ti}</div>
                  <div className="text-[10px] text-faint">
                    {tiYear(ti)}
                    {ti === MAX_TI ? ' · 推演' : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <div>
            <div className="mb-1.5 text-xs font-medium text-mute">难度</div>
            <div className="flex gap-1.5 md:flex-col">
              {(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => (
                <button
                  key={d}
                  disabled={!editable && difficulty !== d}
                  onClick={editable ? () => onChange({ difficulty: d }) : undefined}
                  className={cx(
                    'flex flex-1 items-center gap-2 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-35 pointer-coarse:min-h-10',
                    editable ? 'cursor-pointer' : 'cursor-default',
                    difficulty === d ? 'border-gold/70 bg-gold/10 text-gold' : cx('border-line bg-panel-2/50 text-mute', editable && 'hover:text-ink'),
                  )}
                >
                  <span className={cx('h-2.5 w-2.5 rounded-full border-2', difficulty === d ? 'border-gold bg-gold' : 'border-faint')} />
                  {DIFFICULTY_LABEL[d]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-mute">玩法</div>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
              {(['build', 'existing'] as MpMode[]).map((m) => (
                <button
                  key={m}
                  disabled={!editable && mode !== m}
                  onClick={editable ? () => onChange({ mode: m }) : undefined}
                  className={cx(
                    'rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-35',
                    editable ? 'cursor-pointer' : 'cursor-default',
                    mode === m ? 'border-gold/70 bg-gold/10' : cx('border-line bg-panel-2/50', editable && 'hover:border-gold/30'),
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cx('h-3 w-3 rounded-full border-2', mode === m ? 'border-gold bg-gold' : 'border-faint')} />
                    <span className={cx('text-sm font-semibold', mode === m ? 'text-gold' : 'text-ink')}>{MP_MODE_LABEL[m]}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-mute">{MP_MODE_RULE[m]}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      )}
    </Card>
  );
}

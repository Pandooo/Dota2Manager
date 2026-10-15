// DotaPedia · 战队词条「使命」章节（第十波 #3）与信息框「成立」一行（第十波 #2）。只读：数据来自 engine/missions.ts 的
// clubMissionView（AI 真实俱乐部组建现实巅峰阵容的进度：五名成员、各自现在在哪）与 clubs.ts 的 foundingOf。
import { useGame } from '../../store/gameStore';
import { MISSION_STATUS_LABEL, clubMissionView, foundingOf, tiYear } from '../../engine';
import type { ClubMissionView, GameState, MissionMemberStatus } from '../../engine';
import { PosBadge, StatBar, cx } from '../components/common';
import { Chip, type ChipTone } from '../components/SquadShared';
import NewBadge from '../components/NewBadge';
import { InfoRow, PPlayer, PSection, PTeam, safe } from '../components/PediaKit';

const STATUS_TONE: Record<MissionMemberStatus, ChipTone> = {
  here: 'good',
  team: 'info',
  human: 'gold',
  free: 'mute',
  retired: 'mute',
  banned: 'bad',
  future: 'mute',
  absent: 'mute',
};

/** 战队的使命视图（虚构 / 程序化战队、无巅峰阵容数据为 null；纯查询，开销很小，渲染时现算） */
export function teamMissionOf(game: GameState, teamId: string): ClubMissionView | null {
  return safe(() => clubMissionView(game, teamId), null);
}

/** 信息框：本局中途成立的俱乐部（真实组织按现实首次出现的届次 / 虚构新组织） */
export function TeamFoundedRow({ teamId }: { teamId: string }) {
  const game = useGame();
  const f = safe(() => foundingOf(game, teamId), null);
  if (!f) return null;
  return (
    <InfoRow label="成立">
      TI{f.ti} 赛季（{tiYear(f.ti)}）{f.kind === 'real' ? '加入联赛' : '· 新组织'}
    </InfoRow>
  );
}

/** 「使命」章节（无使命数据时不渲染） */
export default function PediaTeamMission({ view, id = 'pt-mission' }: { view: ClubMissionView | null; id?: string }) {
  if (!view) return null;
  const pct = view.total ? view.have / view.total : 0;
  const status = view.fulfilled ? (
    <Chip tone="gold">使命完成</Chip>
  ) : !view.active ? (
    <Chip tone="mute">{view.note ? '不适用' : '未生效'}</Chip>
  ) : view.complete ? (
    <Chip tone="gold">已集齐</Chip>
  ) : (
    <Chip tone="info">进行中</Chip>
  );
  return (
    <PSection
      id={id}
      title={
        <>
          使命 <NewBadge feature="missions" dismissOn="view" />
        </>
      }
      right={<span>组建现实巅峰阵容 · 转会窗口中优先引进、尽量留住，不保证成功</span>}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm text-ink">
          目标：重组 <span className="font-semibold text-gold">TI{view.peakTi} 巅峰阵容</span>
          <span className="text-mute">
            （{view.peakName}
            {view.resultLabel ? ` · 现实成绩：TI${view.peakTi} ${view.resultLabel}` : ''}
            {view.titles.length > 1 ? ` · 这套阵容夺得 ${view.titles.map((t) => `TI${t}`).join(' / ')}` : ''}）
          </span>
        </span>
        {status}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <StatBar value={pct * 100} className="max-w-xs" color={view.complete ? 'bg-gold' : 'bg-info'} />
        <span className="text-sm font-semibold tabular text-ink">
          {view.have}/{view.total}
        </span>
      </div>
      {view.note && <div className="mt-2 text-xs text-mute">{view.note}</div>}
      {/* 手机（< sm）：不设最小宽度，「现在」一列（状态 + 战队）在单元格内换行，不需要横向滑动 */}
      <div className="mt-3 sm:overflow-x-auto">
        <table className="w-full text-sm sm:min-w-[420px]">
          <thead>
            <tr className="border-b border-line text-left text-xs text-mute">
              <th className="py-1.5 pr-2 font-normal">位置</th>
              <th className="py-1.5 pr-2 font-normal">成员</th>
              <th className="py-1.5 font-normal">现在</th>
            </tr>
          </thead>
          <tbody>
            {view.members.map((m) => (
              <tr key={m.id} className={cx('border-b border-line/60 last:border-0', m.status === 'here' && 'bg-good/5')}>
                <td className="py-1.5 pr-2">
                  <PosBadge pos={m.position} />
                </td>
                <td className="py-1.5 pr-2">
                  {m.status === 'future' || m.status === 'absent' ? <span className="text-mute">{m.handle}</span> : <PPlayer id={m.id} handle={m.handle} />}
                </td>
                <td className="py-1.5">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <Chip tone={STATUS_TONE[m.status]}>{MISSION_STATUS_LABEL[m.status]}</Chip>
                    {m.teamId && m.status !== 'here' && <PTeam id={m.teamId} name={m.teamName} />}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(view.firstCompletedTi !== undefined || view.tiTitles.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
          {view.firstCompletedTi !== undefined && <span>首次集齐：TI{view.firstCompletedTi} 赛季</span>}
          {view.completedTi !== undefined && view.completedTi !== view.firstCompletedTi && <span>最近一次集齐：TI{view.completedTi} 赛季</span>}
          {view.tiTitles.length > 0 && (
            <span className="text-gold">集齐后夺得 {view.tiTitles.map((t) => `TI${t}`).join('、')} 冠军</span>
          )}
        </div>
      )}
    </PSection>
  );
}

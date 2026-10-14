// DotaPedia 中心页：总览 | 战队 | 选手 | 名人堂 | 赛事 | 英雄 | 羁绊图鉴（只读百科；标签行右侧为全站搜索）
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGame, useGameStore, type PediaTab as Tab } from '../../store/gameStore';
import { pediaSearch } from '../../engine';
import type { PediaSearchHit } from '../../engine';
import { HubShell, useHubTab, type HubTabDef } from '../layout/HubKit';
import { cx } from '../components/common';
import NewBadge from '../components/NewBadge';
import { PEDIA_KIND_LABEL, openPedia, pediaTabReselect, safe, syncPediaGame, type PediaKind } from '../components/PediaKit';
import PediaHome from './PediaHome';
import PediaTeams from './PediaTeams';
import PediaPlayers from './PediaPlayers';
import PediaHallOfFame from './PediaHallOfFame';
import PediaTours from './PediaTours';
import PediaHeroes from './PediaHeroes';
import PediaSynergies from './PediaSynergies';

export default function PediaHub() {
  const game = useGame();
  const tab = useHubTab<Tab>('pedia');
  // 换局后清空词条选中状态与返回历史（选中状态按存档 id 读取，渲染时不会显示上一局的词条）
  useEffect(() => syncPediaGame(game.id), [game.id]);

  const tabs: HubTabDef[] = [
    { key: 'pediaHome', label: '总览', title: '历史数据、TI 冠军、排行榜、单局纪录与历史地位榜' },
    { key: 'pediaTeams', label: '战队', title: '全部战队（含已解散）的词条：成就、战绩、阵容变迁与历史地位' },
    { key: 'pediaPlayers', label: '选手', title: '全部选手的词条：生涯数据、成就、战队履历与常用英雄' },
    {
      key: 'pediaHall',
      label: '名人堂',
      title: '名人堂：DotA1 时代传奇、开局之前真实历史中的 SS / SSR（补录）与本局历届 SS / SSR 选手，新秀抽卡「请神」的原型',
      badge: <NewBadge feature="hallOfFame" />, // 新功能徽标（v0.3.0）：点击标签后消失
    },
    { key: 'pediaTours', label: '赛事', title: '历届赛事的冠亚军与名次' },
    { key: 'pediaHeroes', label: '英雄', title: '英雄出场、胜率与禁用（按赛季）' },
    {
      key: 'pediaSynergies',
      label: '羁绊图鉴',
      title: '羁绊图鉴：历届 TI 冠军阵容（及少数经典阵容）的隐藏羁绊，五人同队集齐后觉醒并解锁',
      badge: <NewBadge feature="synergies" />, // 新功能徽标（v0.2）：点击标签后消失
    },
  ];

  return (
    // 再次点击当前标签：从词条回到该类的列表（「返回」仍可回到词条）；总览 / 列表回到顶部
    <HubShell title="DotaPedia" tabs={tabs} value={tab} right={<PediaSearchBox />} onReselect={pediaTabReselect}>
      {tab === 'pediaHome' && <PediaHome />}
      {tab === 'pediaTeams' && <PediaTeams />}
      {tab === 'pediaPlayers' && <PediaPlayers />}
      {tab === 'pediaHall' && <PediaHallOfFame />}
      {tab === 'pediaTours' && <PediaTours />}
      {tab === 'pediaHeroes' && <PediaHeroes />}
      {tab === 'pediaSynergies' && <PediaSynergies />}
    </HubShell>
  );
}

const KIND_TONE: Record<PediaKind, string> = {
  team: 'text-gold',
  player: 'text-info',
  tournament: 'text-dota-2',
  hero: 'text-good',
};

/** 全站搜索：战队 / 选手 / 赛事 / 英雄（回车打开第一条，Esc 清空） */
function PediaSearchBox() {
  const game = useGame();
  const version = useGameStore((s) => s.version);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // 悬停 / 方向键只改高亮，不重新搜索
  const hits: PediaSearchHit[] = useMemo(() => (q.trim() ? safe(() => pediaSearch(game, q, 12), []) : []), [game, version, q]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  const go = (h: PediaSearchHit | undefined) => {
    if (!h) return;
    setOpen(false);
    setQ('');
    openPedia(h.kind, h.id);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go(hits[active]);
          else if (e.key === 'Escape') {
            setQ('');
            setOpen(false);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(hits.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          }
        }}
        placeholder="搜索战队 / 选手 / 赛事 / 英雄"
        className="w-64 rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-faint hover:border-mute focus:border-dota"
      />
      {open && q.trim() && (
        <div className="absolute right-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-lg border border-line bg-panel shadow-2xl shadow-black/50">
          {hits.length === 0 ? (
            <div className="px-3 py-3 text-xs text-faint">没有找到「{q.trim()}」</div>
          ) : (
            <ul className="max-h-96 overflow-y-auto py-1">
              {hits.map((h, i) => (
                <li key={`${h.kind}-${h.id}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(h)}
                    className={cx('flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm', i === active ? 'bg-panel-2' : 'hover:bg-panel-2')}
                  >
                    <span className={cx('w-8 shrink-0 text-[11px] font-semibold', KIND_TONE[h.kind])}>{PEDIA_KIND_LABEL[h.kind]}</span>
                    <span className="min-w-0 flex-1 truncate text-ink">{h.label}</span>
                    <span className="max-w-32 shrink-0 truncate text-[11px] text-faint">{h.sub}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

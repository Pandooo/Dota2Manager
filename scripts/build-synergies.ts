// 由 rosters/ti*.json 生成 src/data/synergies.json（第十波 #5 羁绊系统）：
// - 历届 TI 冠军阵容：各届 roster 中 atTI 且 tiResult === "1" 的战队，取其首发五人（roster 约定前五人为位置各不相同的首发，
//   之后的为替补，如 TI4 Newbee 的 KingJ）。同一五人组多次夺冠（OG TI8 / TI9）合并为一条，届次取最早一届；
// - 少数标志性阵容（ICONIC，下方逐条说明理由），同样取当届 roster 中该队的首发五人；
// - 属性：用户指定 Wings、Na'Vi → 灵性，Spirit → 韧性，OG → 天赋，Newbee → 战斗力，Liquid → 天梯；
//   其余按阵容特点分配（理由写在 note 中，并在 docs/DESIGN.md「羁绊」一节列表说明）。
// 引擎（src/engine/synergy.ts）同步导入这份小文件，不需要异步加载 roster。
// 用法：npx tsx scripts/build-synergies.ts
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Position, SeedTeam, SynergyAttr, SynergyDef } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { ROSTER_DIR, readRosterSync } from './nodeData';

/** 俱乐部简称（用于羁绊名称「TI6 · Wings 五人组」） */
const SHORT: Record<string, string> = {
  'natus-vincere': "Na'Vi",
  'invictus-gaming': 'iG',
  alliance: 'Alliance',
  newbee: 'Newbee',
  'evil-geniuses': 'EG',
  'wings-gaming': 'Wings',
  'team-liquid': 'Liquid',
  og: 'OG',
  'team-spirit': 'Spirit',
  'tundra-esports': 'Tundra',
  'team-falcons': 'Falcons',
  'team-dk': 'DK',
  'psg-lgd': 'PSG.LGD',
  'team-secret': 'Secret',
};

/** 属性分配：按俱乐部（用户指定的 6 家）或按届次覆盖（其余冠军按阵容特点） */
const ATTR_BY_CLUB: Record<string, { attr: SynergyAttr; note: string }> = {
  'natus-vincere': { attr: 'insight', note: '用户指定：Na\'Vi → 灵性' },
  'wings-gaming': { attr: 'insight', note: '用户指定：Wings → 灵性' },
  'team-spirit': { attr: 'resilience', note: '用户指定：Spirit → 韧性' },
  og: { attr: 'talent', note: '用户指定：OG → 天赋' },
  newbee: { attr: 'power', note: '用户指定：Newbee → 战斗力' },
  'team-liquid': { attr: 'mmr', note: '用户指定：Liquid → 天梯' },
  'invictus-gaming': { attr: 'resilience', note: '稳健运营、后期团战的防守反击打法 → 韧性' },
  alliance: { attr: 'insight', note: '以分推牵制战术与 BP 创新著称 → 灵性' },
  'evil-geniuses': { attr: 'talent', note: '16 岁的 SumaiL 随队夺冠 → 天赋' },
  'tundra-esports': { attr: 'power', note: '以扎实的对线与团战压制著称 → 战斗力' },
  'team-falcons': { attr: 'talent', note: '以 Malr1ne、ATF 等年轻核心为首 → 天赋' },
};

/**
 * 标志性阵容（非冠军）：只收录公认的、当届 roster 中五人齐全的阵容。
 * - TI4 DK：2014 年集合 BurNIng、Mushi、iceiceice、LaNm、MMY 的全明星阵容（TI4 第四名），以个人能力著称 → 战斗力；
 * - TI8 PSG.LGD：TI8 亚军，与 OG 的决赛打满五局，以 fy 为核心的体系与 BP 著称 → 灵性（TI9 为同一五人组，按 TI8 收录）；
 * - TI9 Team Secret：2019–2020 赛季连夺多项大赛冠军的阵容（TI9 第四名），Puppey 以发掘、培养新人著称 → 天赋。
 */
const ICONIC: { ti: number; clubId: string; attr: SynergyAttr; note: string }[] = [
  { ti: 4, clubId: 'team-dk', attr: 'power', note: '2014 年的全明星阵容（TI4 第四名），以个人能力著称 → 战斗力' },
  { ti: 8, clubId: 'psg-lgd', attr: 'insight', note: 'TI8 亚军，以 fy 为核心的体系与 BP 著称 → 灵性' },
  { ti: 9, clubId: 'team-secret', attr: 'talent', note: '2019–2020 赛季的统治级阵容（TI9 第四名），Puppey 以发掘新人著称 → 天赋' },
];

const tis = readdirSync(ROSTER_DIR)
  .map((f) => Number(/^ti(\d+)\.json$/.exec(f)?.[1]))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

const errors: string[] = [];

/** roster 首发五人（前五人，位置各不相同） */
function starters(ti: number, team: SeedTeam): SynergyDef['members'] {
  const five = team.players.slice(0, 5);
  const pos = new Set(five.map((p) => p.position));
  if (five.length !== 5 || pos.size !== 5 || !POSITIONS.every((p: Position) => pos.has(p))) {
    errors.push(`TI${ti} ${team.id}：前五人不是位置各不相同的首发`);
  }
  return POSITIONS.map((p) => five.find((x) => x.position === p)).filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => ({ id: x.id, handle: x.handle, position: x.position }));
}

const key = (members: SynergyDef['members']) => members.map((m) => m.id).sort().join('|');

const defs: SynergyDef[] = [];
const byKey = new Map<string, SynergyDef>();

for (const ti of tis) {
  const roster = readRosterSync(ti);
  for (const team of roster.teams) {
    if (!team.atTI || String(team.tiResult) !== '1') continue;
    const members = starters(ti, team);
    const k = key(members);
    const prev = byKey.get(k);
    if (prev) {
      // 同一五人组再次夺冠（OG TI8 / TI9）：合并
      prev.tis.push(ti);
      continue;
    }
    const a = ATTR_BY_CLUB[team.id];
    if (!a) errors.push(`TI${ti} 冠军 ${team.id} 缺少属性分配（ATTR_BY_CLUB）`);
    const short = SHORT[team.id] ?? team.tag ?? team.name;
    const def: SynergyDef = {
      id: `ti${ti}-${team.id}`,
      kind: 'champion',
      ti,
      tis: [ti],
      clubId: team.id,
      club: team.name,
      short,
      color: team.color ?? '#888888',
      name: `TI${ti} · ${short} 五人组`,
      attr: a?.attr ?? 'power',
      members,
      note: a?.note ?? '',
    };
    byKey.set(k, def);
    defs.push(def);
  }
}

for (const ic of ICONIC) {
  const roster = readRosterSync(ic.ti);
  const team = roster.teams.find((t) => t.id === ic.clubId);
  if (!team) {
    errors.push(`TI${ic.ti} 缺少标志性阵容 ${ic.clubId}`);
    continue;
  }
  const members = starters(ic.ti, team);
  if (byKey.has(key(members))) {
    errors.push(`标志性阵容 TI${ic.ti} ${ic.clubId} 与已有羁绊重复`);
    continue;
  }
  const short = SHORT[team.id] ?? team.tag ?? team.name;
  const def: SynergyDef = {
    id: `ti${ic.ti}-${team.id}`,
    kind: 'iconic',
    ti: ic.ti,
    tis: [ic.ti],
    result: team.tiResult,
    clubId: team.id,
    club: team.name,
    short,
    color: team.color ?? '#888888',
    name: `TI${ic.ti} · ${short} 五人组`,
    attr: ic.attr,
    members,
    note: ic.note,
  };
  byKey.set(key(members), def);
  defs.push(def);
}

defs.sort((a, b) => a.ti - b.ti || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'champion' ? -1 : 1));
const names = new Set<string>();
for (const d of defs) {
  if (names.has(d.name)) errors.push(`羁绊名称重复：${d.name}`);
  names.add(d.name);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
// 每条羁绊一行，便于查看差异
writeFileSync(join(ROSTER_DIR, '..', 'synergies.json'), `[\n${defs.map((d) => JSON.stringify(d)).join(',\n')}\n]\n`);
console.log(`synergies: ${defs.length} 条（冠军 ${defs.filter((d) => d.kind === 'champion').length}，标志性 ${defs.filter((d) => d.kind === 'iconic').length}）`);
for (const d of defs) console.log(`  ${d.name}  ${d.attr}  ${d.members.map((m) => m.handle).join(' ')}${d.tis.length > 1 ? `  (TI${d.tis.join('/TI')})` : ''}`);

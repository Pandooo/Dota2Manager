// 程序化生成与种子数据转换【E1 负责实现】
import { getHeroes, getPlayerIndex } from '../data';
import { CONFIG } from './config';
import { clampPlayerAttrs, computeSalary, playerTier, regionOfNationality, seasonEconIndex, seasonYear, tierIndex } from './player';
import { realRoleFor, refreshAltPositions } from './roles';
import type { Rng } from './rng';
import { hashSeed, rngOf } from './rng';
import { addPlayerToTeam, autoLineup } from './team';
import { realClubStartingFunds, roundWageBill } from './economy';
import type {
  Coach, GameState, Player, PlayerIndexEntry, PlayerStats, Position, Region, SeedCoach, SeedPlayer, SeedTeam, Team, Tier,
} from './types';
import { POSITIONS, REGIONS, TIERS } from './types';
import { clamp, nextId, round2 } from './util';

type Strength = 'weak' | 'mid' | 'strong';

// ===========================================================================
// 选手 ID（handle）生成：按赛区风格由词素拼接
// ===========================================================================

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** 随机把 1~2 个字母换成数字（leetspeak） */
function leetify(rng: Rng, word: string): string {
  const map: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };
  const idx: number[] = [];
  for (let i = 1; i < word.length; i++) if (map[word[i].toLowerCase()]) idx.push(i);
  if (idx.length === 0) return word;
  const times = Math.min(idx.length, rng.chance(0.3) ? 2 : 1);
  const chars = word.split('');
  rng.shuffle(idx);
  for (let k = 0; k < times; k++) chars[idx[k]] = map[chars[idx[k]].toLowerCase()];
  return chars.join('');
}

/** 交替大小写（北美式怪异大小写） */
function weirdCase(rng: Rng, word: string): string {
  const offset = rng.int(0, 1);
  return word
    .split('')
    .map((c, i) => ((i + offset) % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
    .join('');
}

const CN_PINYIN = [
  'xiao', 'yu', 'ming', 'long', 'hao', 'jun', 'wei', 'fei', 'lei', 'tian', 'chen', 'yang', 'bo', 'kai', 'zi', 'han',
  'xin', 'yi', 'le', 'qi', 'rui', 'feng', 'yun', 'jie', 'hui', 'shuai', 'pang', 'mo', 'lin', 'sheng', 'meng', 'dong',
  'bai', 'kun', 'nan', 'hu', 'ze', 'xuan', 'chao', 'peng',
];
const CN_WORDS = [
  'Moon', 'Echo', 'Dream', 'Lucky', 'Shadow', 'Silence', 'Sky', 'Rain', 'Storm', 'Ghost', 'Ice', 'Star', 'Night',
  'Zero', 'Hope', 'Nova', 'Mist', 'Lotus', 'Panda', 'Wind', 'Cloud', 'Lonely', 'Tears', 'Destiny', 'Forever', 'Smile',
];
const CN_NUMS = ['233', '666', '520', '007', '88', '9', '17', '1314'];

const CIS_NAMES = [
  'Vova', 'Misha', 'Sasha', 'Dima', 'Kolya', 'Pasha', 'Lyosha', 'Tolya', 'Grisha', 'Zhenya', 'Vanya', 'Tema', 'Slava',
  'Yura', 'Stas', 'Nikita', 'Danya', 'Kostya', 'Egor', 'Fedya', 'Borya', 'Seva',
];
const CIS_DIMINUTIVE = ['Dimka', 'Vovka', 'Pashka', 'Mishka', 'Sanka', 'Tolik', 'Grishka', 'Lyoshka', 'Kolyan', 'Vitalik', 'Serega', 'Zhekich'];
const CIS_WORDS = [
  'Silent', 'Ghost', 'Kinder', 'Raze', 'Fury', 'Cyber', 'Pure', 'Lone', 'Void', 'Frost', 'Blizzard', 'Tundra', 'Wolf',
  'Bear', 'Crow', 'Ash', 'Rage', 'Chaos', 'Magnum', 'Toxic', 'Sleepy', 'Kraken', 'Reaper', 'Nomad', 'Morozko',
];
const CIS_NUMS = ['666', '1337', '228', '322', '777', '13', '99'];

const EU_NAMES = [
  'Jonas', 'Lasse', 'Mikkel', 'Tobi', 'Seb', 'Max', 'Felix', 'Oskar', 'Emil', 'Niklas', 'Jesse', 'Aleksi', 'Ville',
  'Kalle', 'Pierre', 'Luca', 'Marco', 'Kuba', 'Bartek', 'Tomek', 'Ivo', 'Stefan', 'Nico', 'Rasmus', 'Teo', 'Aris',
  'Jarno', 'Elias', 'Sven', 'Mats',
];
const EU_WORDS = [
  'Ace', 'Blink', 'Zen', 'Rune', 'Viper', 'Bolt', 'Rogue', 'Jinx', 'Vex', 'Lynx', 'Fox', 'Kami', 'Mute', 'Hex', 'Pyro',
  'Orb', 'Glimmer', 'Wisp', 'Drift', 'Noble', 'Raven', 'Pixel', 'Tempo', 'Grim', 'Volt', 'Myth', 'Sage', 'Nyx',
];

const NA_WORDS = [
  'Fury', 'Blaze', 'Maverick', 'Ranger', 'Outlaw', 'Bandit', 'Hawk', 'Sniper', 'Tank', 'Rocket', 'Cowboy', 'Phantom',
  'Hype', 'Clutch', 'Nuke', 'Moose', 'Bison', 'Grizzly', 'Hustle', 'Rebel', 'Gunner', 'Thunder', 'Saint', 'King',
  'Sloth', 'Waffle', 'Taco', 'Biscuit',
];
const NA_ADJ = ['Mad', 'Lil', 'Big', 'Dark', 'Fast', 'Wild', 'Iron', 'Lone', 'Cool', 'Pure', 'Sneaky', 'Crazy', 'Holy', 'Frozen', 'Salty', 'Tilted'];

const SA_NAMES = [
  'Pablito', 'Javi', 'Lucho', 'Nacho', 'Pepe', 'Chuy', 'Tono', 'Beto', 'Rodri', 'Mateo', 'Thiago', 'Joao', 'Gabi',
  'Duda', 'Vini', 'Caio', 'Rafa', 'Kike', 'Santi', 'Fito', 'Memo', 'Manolo', 'Chino', 'Flaco', 'Pipo', 'Cholo',
];
const SA_WORDS = [
  'Fuego', 'Sombra', 'Lobo', 'Rayo', 'Diablo', 'Fantasma', 'Jaguar', 'Condor', 'Puma', 'Tigre', 'Toro', 'Cuervo',
  'Brujo', 'Mago', 'Sol', 'Luna', 'Trueno', 'Guerrero', 'Samurai', 'Ninja', 'Kaiser', 'Pibe', 'Capo', 'Chamo',
];

const SEA_NAMES = [
  'Kiko', 'Bok', 'Jing', 'Nash', 'Migs', 'Jom', 'Paeng', 'Ely', 'Toto', 'Bong', 'Ian', 'Aziz', 'Faiz', 'Ikmal',
  'Hafiz', 'Rizal', 'Bagus', 'Dewa', 'Putra', 'Eko', 'Arif', 'Nong', 'Ton', 'Pong', 'Bank', 'Tee', 'Win', 'Duy', 'Khoa',
];
const SEA_WORDS = [
  'Ninja', 'Kaze', 'Typhoon', 'Garuda', 'Kraken', 'Mango', 'Boogie', 'Savage', 'Kuro', 'Shiro', 'Yuki', 'Hiro', 'Ryu',
  'Zeus', 'Thor', 'Durian', 'Kopi', 'Sambal', 'Gecko', 'Monsoon', 'Tsunami',
];
const SEA_NUMS = ['23', '88', '99', '7', '13', '21'];

/** 生成一个候选 handle（未查重） */
function rawHandle(rng: Rng, region: Region): string {
  const r = rng.next();
  switch (region) {
    case 'CN': {
      const py = () => rng.pick(CN_PINYIN);
      if (r < 0.18) return `xiao${cap(py())}`;
      if (r < 0.34) return cap(py()) + py();
      if (r < 0.48) return rng.pick(CN_WORDS);
      if (r < 0.6) return `${rng.pick(CN_WORDS)}_${py()}`;
      if (r < 0.7) {
        const s = cap(py());
        const last = s[s.length - 1];
        return s + last + last;
      }
      if (r < 0.8) return py()[0] + py()[0] + rng.pick(CN_NUMS);
      if (r < 0.9) return `A${py()}`;
      return `Lao${cap(py())}`;
    }
    case 'CIS': {
      if (r < 0.2) return rng.pick(CIS_DIMINUTIVE);
      if (r < 0.32) return `${rng.int(1, 9)}${rng.pick(CIS_NAMES).toLowerCase()}`;
      if (r < 0.5) return rng.pick(CIS_WORDS) + rng.pick(CIS_NUMS);
      if (r < 0.66) return leetify(rng, rng.pick(CIS_WORDS));
      if (r < 0.76) return rng.pick(CIS_WORDS).toUpperCase();
      if (r < 0.88) return `${rng.pick(CIS_NAMES)}-`;
      {
        const nm = rng.pick(CIS_NAMES);
        // 元音结尾 → 去尾加昵称后缀（Sasha → Sashok）；辅音结尾 → 加姓氏式后缀（Egor → Egorov）
        return /[aeiouy]$/i.test(nm)
          ? nm.slice(0, -1) + rng.pick(['ok', 'chik', 'un'])
          : nm + rng.pick(['ich', 'off', 'ov']);
      }
    }
    case 'EU': {
      if (r < 0.14) return rng.pick(EU_NAMES) + rng.pick(['son', 'sen', 'zz', 'y']);
      if (r < 0.3) return rng.pick(EU_WORDS);
      if (r < 0.42) return `${rng.pick(EU_WORDS)}-`;
      if (r < 0.54) return leetify(rng, rng.pick(EU_WORDS));
      if (r < 0.66) return rng.pick(EU_NAMES).toLowerCase() + rng.int(88, 99);
      if (r < 0.76) return `${rng.pick(EU_NAMES)}!`;
      if (r < 0.9) return rng.pick(EU_WORDS) + rng.pick(EU_WORDS);
      return `Mr${rng.pick(EU_WORDS)}`;
    }
    case 'NA': {
      if (r < 0.25) return rng.pick(NA_ADJ) + rng.pick(NA_WORDS);
      if (r < 0.38) return weirdCase(rng, rng.pick(NA_WORDS));
      if (r < 0.5) {
        const A = 'ABCDEFGHJKLMNPRSTVWZ';
        return A[rng.int(0, A.length - 1)] + A[rng.int(0, A.length - 1)] + A[rng.int(0, A.length - 1)];
      }
      if (r < 0.66) return rng.pick(NA_WORDS) + rng.int(2, 99);
      if (r < 0.8) return `${rng.pick(NA_ADJ)}_${rng.pick(NA_WORDS)}`;
      if (r < 0.9) return `The${rng.pick(NA_WORDS)}`;
      return rng.pick(NA_WORDS).toLowerCase();
    }
    case 'SA': {
      if (r < 0.22) return rng.pick(SA_NAMES);
      if (r < 0.4) return rng.pick(SA_WORDS);
      if (r < 0.52) return `El${rng.pick(SA_WORDS)}`;
      if (r < 0.66) return leetify(rng, rng.pick(SA_WORDS));
      if (r < 0.78) return rng.pick(SA_NAMES) + rng.pick(['10', '7', '9', '23', '17']);
      if (r < 0.88) return `x${rng.pick(SA_WORDS)}`;
      return rng.pick(SA_NAMES) + 'zinho';
    }
    case 'SEA':
    default: {
      if (r < 0.14) {
        const n = rng.pick(SEA_NAMES).toLowerCase();
        return n + n;
      }
      if (r < 0.3) return rng.pick(SEA_NUMS) + rng.pick(SEA_WORDS).toLowerCase();
      if (r < 0.5) return rng.pick(SEA_NAMES);
      if (r < 0.62) return `${rng.pick(SEA_WORDS)}~`;
      if (r < 0.76) return rng.pick(SEA_WORDS).toLowerCase() + rng.pick(SEA_NAMES).toLowerCase();
      if (r < 0.88) return rng.pick(SEA_WORDS);
      return `Kuya${rng.pick(SEA_NAMES)}`;
    }
  }
}

/** 真实选手 handle（小写，取自 playerIndex，模块级缓存）：程序化 ID 不得冒用（如 "Ace" "9pasha"），也避免日后真实新秀登场时重名 */
let realHandleCache: Set<string> | null = null;
function realHandles(): Set<string> {
  if (realHandleCache) return realHandleCache;
  const set = new Set<string>();
  try {
    for (const e of getPlayerIndex() ?? []) {
      if (e?.handle) set.add(String(e.handle).toLowerCase());
      if (e?.id) set.add(String(e.id).toLowerCase());
    }
  } catch {
    // 数据缺失：仅按存档内 handle 查重
  }
  realHandleCache = set;
  return set;
}

/** 现有 handle / 教练名（小写）集合 */
function existingHandleSet(state: GameState): Set<string> {
  const set = new Set<string>();
  for (const id in state.players) {
    const h = state.players[id].handle;
    if (h) set.add(h.toLowerCase());
  }
  for (const id in state.coaches) {
    const n = state.coaches[id].name;
    if (n) set.add(n.toLowerCase());
  }
  return set;
}

const HANDLE_MAX_LEN = 14;
const HANDLE_MAX_TRIES = 40;

/** 按赛区风格生成选手 ID（如 CN: "xiaoYu"、CIS: "Kirito"），避免与现有 handle 及真实选手 handle 重复 */
export function generateHandle(state: GameState, region: Region): string {
  const rng = rngOf(state);
  const existing = existingHandleSet(state);
  const real = realHandles();
  const taken = (h: string) => {
    const k = h.toLowerCase();
    return existing.has(k) || real.has(k);
  };
  const reg: Region = REGIONS.includes(region) ? region : 'EU';
  for (let i = 0; i < HANDLE_MAX_TRIES; i++) {
    const h = rawHandle(rng, reg);
    if (h.length >= 2 && h.length <= HANDLE_MAX_LEN && !taken(h)) return h;
  }
  // 兜底：追加数字直到唯一
  const base = rawHandle(rng, reg).slice(0, HANDLE_MAX_LEN - 3);
  let h = base + rng.int(10, 999);
  while (taken(h)) h = base + rng.int(10, 9999);
  return h;
}

// ===========================================================================
// 国籍池
// ===========================================================================

/** 各赛区国籍权重（均满足 regionOfNationality(cc) === region） */
export const NATIONALITY_POOLS: Record<Region, [string, number][]> = {
  CN: [['CN', 92], ['TW', 3], ['HK', 3], ['MO', 1]],
  SEA: [
    ['PH', 30], ['MY', 20], ['ID', 14], ['TH', 10], ['VN', 8], ['SG', 6], ['MM', 4], ['KH', 2], ['LA', 1],
    ['KR', 2], ['JP', 1], ['AU', 1], ['MN', 1],
  ],
  CIS: [
    ['RU', 55], ['UA', 22], ['KZ', 6], ['BY', 5], ['KG', 2], ['UZ', 2], ['AM', 1], ['GE', 1], ['MD', 1],
    ['LV', 1], ['LT', 1], ['EE', 1],
  ],
  EU: [
    ['DE', 9], ['SE', 8], ['DK', 8], ['FI', 8], ['PL', 8], ['BG', 7], ['FR', 6], ['RO', 5], ['GB', 5], ['NO', 3],
    ['NL', 3], ['ES', 3], ['CZ', 3], ['RS', 3], ['GR', 3], ['TR', 3], ['JO', 4], ['IT', 2], ['PT', 2], ['SK', 2],
    ['AT', 2], ['BE', 2], ['HR', 2], ['MK', 2], ['IL', 2], ['LB', 2], ['HU', 2], ['IS', 1], ['CH', 1], ['SI', 1],
  ],
  NA: [['US', 70], ['CA', 24], ['MX', 6]],
  SA: [['PE', 40], ['BR', 30], ['AR', 6], ['CL', 6], ['BO', 6], ['CO', 4], ['EC', 3], ['VE', 3], ['UY', 2]],
};

function pickNationality(rng: Rng, region: Region): string {
  const pool = NATIONALITY_POOLS[region] ?? NATIONALITY_POOLS.EU;
  return rng.weighted(
    pool.map((x) => x[0]),
    pool.map((x) => x[1]),
  );
}

function pickRegion(rng: Rng): Region {
  const w = CONFIG.generation.regionWeights;
  return rng.weighted(REGIONS, REGIONS.map((r) => w[r] ?? 0));
}

// ===========================================================================
// 等级 / mmr / 战力
// ===========================================================================

/** 按权重随机等级 */
export function randomTier(rng: Rng, weights: Record<Tier, number>): Tier {
  const w = TIERS.map((t) => Math.max(0, weights?.[t] ?? 0));
  if (w.every((x) => x <= 0)) return 'A';
  return rng.weighted(TIERS, w);
}

/** 某等级区间内随机 mmr */
export function mmrForTier(rng: Rng, tier: Tier): number {
  const th = CONFIG.ladder.thresholds;
  const i = tierIndex(tier);
  const t = TIERS[i];
  let lo = th[t];
  let hi: number;
  if (i < TIERS.length - 1) {
    hi = th[TIERS[i + 1]];
  } else {
    const prevGap = i > 0 ? th[t] - th[TIERS[i - 1]] : 2000;
    hi = th[t] + prevGap;
  }
  if (i === 0) lo = Math.max(CONFIG.ladder.minMmr, th[t] - (hi - th[t]));
  hi = Math.min(hi, CONFIG.ladder.maxMmr + 1);
  lo = Math.max(lo, CONFIG.ladder.minMmr);
  // SSR 集中在门槛附近（越往上越稀有）
  const u = t === 'SSR' ? Math.pow(rng.next(), 2) : rng.next();
  return clamp(Math.floor(lo + (hi - 1 - lo) * u), CONFIG.ladder.minMmr, CONFIG.ladder.maxMmr);
}

/** 由战力反推最接近的等级（按 powerByTier 区间中点） */
export function tierForPower(power: number): Tier {
  let best: Tier = 'C';
  let bestD = Infinity;
  for (const t of TIERS) {
    const [lo, hi] = CONFIG.generation.powerByTier[t];
    const d = Math.abs((lo + hi) / 2 - power);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function lowerTier(t: Tier): Tier {
  return TIERS[Math.max(0, tierIndex(t) - 1)];
}

function talentMeanForAge(age: number): number {
  const table = CONFIG.generation.talentByAge;
  for (const [maxAge, mean] of table) if (age <= maxAge) return mean;
  return table.length ? table[table.length - 1][1] : 50;
}

function genAttr(rng: Rng, mean: number, sd: number = CONFIG.generation.attrSd): number {
  const [lo, hi] = CONFIG.generation.attrClamp;
  return round2(clamp(rng.normal(mean, sd), lo, hi));
}

function emptyStats(): PlayerStats {
  return { matches: 0, wins: 0, titles: 0, tiTitles: 0, mvp: 0 };
}

/** 随机招牌英雄：当前日期已上线、位置适配度达标的英雄 2~3 个（英雄数据缺失 → 空） */
function pickSignatureHeroes(state: GameState, rng: Rng, pos: Position): string[] {
  let heroes;
  try {
    heroes = getHeroes();
  } catch {
    return [];
  }
  if (!heroes || heroes.length === 0) return [];
  const date = state.currentDate || '9999-12-31';
  const fit = CONFIG.generation.signatureFit;
  const pool = heroes.filter((h) => (!h.releaseDate || h.releaseDate <= date) && (h.positions?.[pos] ?? 0) >= fit);
  if (pool.length === 0) return [];
  const [cMin, cMax] = CONFIG.generation.signatureCount;
  const n = Math.min(pool.length, rng.int(cMin, cMax));
  return rng.shuffle(pool.slice()).slice(0, n).map((h) => h.id);
}

function uniqueId(state: GameState, prefix: string, table: Record<string, unknown>): string {
  let id = nextId(state, prefix);
  while (table[id]) id = nextId(state, prefix);
  return id;
}

/**
 * 生成程序化选手并注册到 state.players（teamId=null，自由选手）。
 * 战力与等级正相关：C≈45-55, B≈52-62, A≈58-70, S≈66-78, SS≈74-86, SSR≈82-94（±噪声）；
 * rookie: 年龄 16-20、天赋偏高、战力偏低。isReal=false。
 */
export function generatePlayer(
  state: GameState,
  opts?: { tier?: Tier; position?: Position; age?: number; region?: Region; rookie?: boolean },
): Player {
  const rng = rngOf(state);
  const gen = CONFIG.generation;
  const rookie = !!opts?.rookie;
  const region: Region = opts?.region && REGIONS.includes(opts.region) ? opts.region : pickRegion(rng);
  const tier: Tier = opts?.tier && TIERS.includes(opts.tier) ? opts.tier : randomTier(rng, CONFIG.gacha.baseWeights);
  const position: Position = opts?.position && POSITIONS.includes(opts.position) ? opts.position : rng.pick(POSITIONS);

  let age: number;
  if (opts?.age !== undefined && Number.isFinite(opts.age)) age = Math.round(opts.age);
  else if (rookie) age = rng.int(CONFIG.player.rookieAgeRange[0], CONFIG.player.rookieAgeRange[1]);
  else age = Math.round(clamp(rng.normal(gen.ageMean, gen.ageSd), gen.ageRange[0], gen.ageRange[1]));

  const [pLo, pHi] = gen.powerByTier[tier];
  let power = rng.range(pLo, pHi) + rng.normal(0, gen.powerNoise);
  if (rookie) power *= rng.range(gen.rookiePowerMult[0], gen.rookiePowerMult[1]);

  const yearsPro = age - 18;
  const nationality = pickNationality(rng, region);
  const p: Player = {
    id: uniqueId(state, 'gp', state.players),
    handle: generateHandle(state, region),
    nationality,
    region,
    birthYear: seasonYear(state) - age,
    position,
    mmr: mmrForTier(rng, tier),
    power: round2(Math.max(1, power)),
    talent: genAttr(rng, talentMeanForAge(age) + (rookie ? gen.rookieTalentBonus : 0), gen.talentSd),
    resilience: genAttr(rng, gen.resilienceBase + yearsPro * gen.resiliencePerYear),
    insight: genAttr(rng, gen.insightBase + yearsPro * gen.insightPerYear + tierIndex(tier) * gen.insightPerTier),
    loyalty: genAttr(rng, gen.loyaltyMean, gen.loyaltySd),
    salary: 0,
    contractUntil: state.season?.ti ?? state.settings.startTi,
    teamId: null,
    status: 'active',
    modifiers: [],
    signatureHeroes: pickSignatureHeroes(state, rng, position),
    stats: emptyStats(),
    joinedSeason: state.season?.ti ?? state.settings.startTi,
    isReal: false,
  };
  if (rookie) p.isRookie = true;
  clampPlayerAttrs(p);
  p.salary = computeSalary(state, p, rookie);
  state.players[p.id] = p;
  return p;
}

// ===========================================================================
// 教练
// ===========================================================================

function coachBoost(rng: Rng, tier: Tier): number {
  const base = CONFIG.coach.boostByTier[tier] ?? 0;
  const v = CONFIG.coach.boostVariance;
  return round2(clamp(base * (1 + rng.range(-v, v)), 0, 10));
}

function coachSalary(state: GameState, tier: Tier): number {
  const raw = (CONFIG.coach.salaryByTier[tier] ?? 0) * seasonEconIndex(state);
  return Math.max(CONFIG.economy.minSalary, Math.round(raw));
}

function weightsOf(partial: Partial<Record<Tier, number>>): Record<Tier, number> {
  return { C: 0, B: 0, A: 0, S: 0, SS: 0, SSR: 0, ...partial };
}

/** 生成程序化教练并注册到 state.coaches（teamId=null） */
export function generateCoach(state: GameState, opts?: { tier?: Tier; region?: Region }): Coach {
  const rng = rngOf(state);
  const gen = CONFIG.generation;
  const region: Region = opts?.region && REGIONS.includes(opts.region) ? opts.region : pickRegion(rng);
  const tier: Tier = opts?.tier && TIERS.includes(opts.tier) ? opts.tier : randomTier(rng, gen.coachTierWeights);
  const age = rng.int(gen.coachAgeRange[0], gen.coachAgeRange[1]);
  const coach: Coach = {
    id: uniqueId(state, 'gc', state.coaches),
    name: generateHandle(state, region),
    nationality: pickNationality(rng, region),
    birthYear: seasonYear(state) - age,
    tier,
    insight: genAttr(rng, gen.coachInsightBase + tierIndex(tier) * gen.coachInsightPerTier),
    talentBoost: coachBoost(rng, tier),
    resilienceBoost: coachBoost(rng, tier),
    salary: coachSalary(state, tier),
    teamId: null,
  };
  state.coaches[coach.id] = coach;
  return coach;
}

// ===========================================================================
// AI 战队
// ===========================================================================

const TEAM_WORDS: Record<Region, { adj: string[]; noun: string[] }> = {
  CN: {
    adj: ['Phoenix', 'Tiger', 'Jade', 'Thunder', 'Crimson', 'Golden', 'Imperial', 'Lunar', 'Celestial', 'Starlight',
      'Silk Road', 'Dragon', 'Panda', 'Mystic', 'Scarlet', 'Ancient', 'Eastern Wind', 'Kunlun'],
    noun: ['Gaming', 'Dynasty', 'Esports', 'Club', 'Legion', 'Dragons', 'Tigers', 'Lotus', 'Warriors', 'Monarchs', 'Blade'],
  },
  CIS: {
    adj: ['Northern', 'Steel', 'Winter', 'Red', 'Polar', 'Siberian', 'Iron', 'Volga', 'Frost', 'Ural', 'White', 'Silver',
      'Arctic', 'Taiga'],
    noun: ['Wolves', 'Bears', 'Legion', 'Star', 'Lynx', 'Mammoth', 'Pirates', 'Ravens', 'Hussars', 'Cossacks', 'Vanguard',
      'Brigade'],
  },
  EU: {
    adj: ['Nordic', 'Atlantic', 'Royal', 'Black', 'Alpine', 'Baltic', 'Iberian', 'Celtic', 'Northern', 'Midnight',
      'Viking', 'Phantom', 'Neon', 'Emerald'],
    noun: ['Vikings', 'Rebels', 'Knights', 'Forest', 'Eagles', 'Lights', 'Storm', 'Templars', 'Lions', 'Valkyries',
      'Syndicate', 'Crusaders'],
  },
  NA: {
    adj: ['Coast', 'Lone', 'Liberty', 'Golden', 'Pacific', 'Midwest', 'Maple', 'Desert', 'Rocky', 'Neon', 'Empire', 'Bay',
      'Grizzly', 'Frontier'],
    noun: ['Raiders', 'Star', 'Hawks', 'Gate', 'Wave', 'Rangers', 'Outlaws', 'Mustangs', 'Bisons', 'Coyotes', 'Titans',
      'Pioneers'],
  },
  SA: {
    adj: ['Andes', 'Inca', 'Jaguar', 'Amazon', 'Pampas', 'Samba', 'Aztec', 'Patagonia', 'Lima', 'Furia', 'Carnaval',
      'Atacama', 'Cusco'],
    noun: ['Condors', 'Kings', 'Esports', 'Serpents', 'Gauchos', 'Squad', 'Warriors', 'Pumas', 'Guardians', 'Llamas',
      'Lobos', 'Legends'],
  },
  SEA: {
    adj: ['Tropical', 'Garuda', 'Monsoon', 'Lotus', 'Mekong', 'Island', 'Typhoon', 'Merlion', 'Coral', 'Jungle', 'Bamboo',
      'Volcano', 'Pearl', 'Siam', 'Komodo'],
    noun: ['Storm', 'Gaming', 'Esports', 'Dragons', 'Tigers', 'Kings', 'Warriors', 'Raiders', 'Sharks', 'Spirits', 'Titans',
      'Monkeys'],
  },
};

/** 真实战队名（生成时规避） */
const REAL_TEAM_NAMES = new Set(
  [
    'Invictus Gaming', 'Vici Gaming', 'Keen Gaming', 'Royal Never Give Up', 'Azure Ray', 'Thunder Awaken',
    'Thunder Predator', 'Team Spirit', 'Natus Vincere', 'Evil Geniuses', 'Team Liquid', 'Tundra Esports',
    'Gaimin Gladiators', 'Team Secret', 'Nigma Galaxy', 'BetBoom Team', 'Shopify Rebellion', 'Talon Esports',
    'Team Falcons', 'Xtreme Gaming', 'Boom Esports', 'Polaris Esports', 'Sky Esports', 'Team Aster', 'Lgd Gaming',
  ].map((s) => s.toLowerCase()),
);

/** 预设调色板 */
export const TEAM_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#e84393', '#00cec9', '#6c5ce7',
  '#fd79a8', '#d63031', '#0984e3', '#00b894', '#fdcb6e', '#a29bfe', '#55efc4', '#fab1a0', '#74b9ff', '#b33939',
  '#218c74', '#cc8e35', '#706fd3', '#ff793f',
];

/** 由 id 稳定映射到调色板颜色 */
export function colorFromId(id: string): string {
  const h = hashSeed(id || 'team');
  return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length];
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'team';
}

function makeTag(name: string): string {
  const words = name.split(/[\s.]+/).filter(Boolean);
  if (words.length >= 2) {
    const initials = words.map((w) => w[0]).join('').toUpperCase();
    if (initials.length >= 3) return initials.slice(0, 4);
    // 两个词：首词前 2~3 字母 + 次词首字母
    return (words[0].slice(0, 2) + words[1][0]).toUpperCase();
  }
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'TEAM';
}

/** 生成不重名的战队名与简称 */
export function generateTeamName(state: GameState, region: Region): { name: string; tag: string } {
  const rng = rngOf(state);
  const words = TEAM_WORDS[region] ?? TEAM_WORDS.EU;
  const takenNames = new Set<string>();
  const takenTags = new Set<string>();
  for (const id in state.teams) {
    takenNames.add(state.teams[id].name.toLowerCase());
    takenTags.add(state.teams[id].tag.toUpperCase());
  }
  let name = '';
  for (let i = 0; i < 60; i++) {
    const adj = rng.pick(words.adj);
    const noun = rng.pick(words.noun);
    const a = adj.toLowerCase();
    const n = noun.toLowerCase();
    if (a.includes(n) || n.includes(a) || n.startsWith(a.slice(0, 4))) continue; // 避免 Tiger Tigers 之类
    const candidate = `${adj} ${noun}`;
    const lc = candidate.toLowerCase();
    if (!takenNames.has(lc) && !REAL_TEAM_NAMES.has(lc)) {
      name = candidate;
      break;
    }
  }
  if (!name) {
    const base = `${rng.pick(words.adj)} ${rng.pick(words.noun)}`;
    let n = 2;
    name = `${base} ${n}`;
    while (takenNames.has(name.toLowerCase())) name = `${base} ${++n}`;
  }
  let tag = makeTag(name);
  if (takenTags.has(tag)) {
    const base = tag.slice(0, 3);
    let n = 1;
    tag = `${base}${n}`;
    while (takenTags.has(tag)) tag = `${base}${++n}`;
  }
  return { name, tag };
}

function uniqueTeamId(state: GameState, base: string): string {
  if (!state.teams[base]) return base;
  let n = 2;
  while (state.teams[`${base}-${n}`]) n++;
  return `${base}-${n}`;
}

/**
 * 生成 AI 战队（5 名首发 + 可能 1 替补 + 可能教练），注册到 state.teams/players/coaches。
 * 资金：generation.aiTeam.funds[强度档] × 经济指数视为该队的「数据资金」，按真实俱乐部同一公式（economy.realClubStartingFunds，
 * 下限按实际阵容工资）折算——开局补足、赛季初补足联赛规模（ai.aiEnsureRosters）与假赛除名补位（scandal.ts）都经过这里
 */
export function generateAiTeam(state: GameState, region: Region, strength: Strength): Team {
  const rng = rngOf(state);
  const cfg = CONFIG.generation.aiTeam;
  const str: Strength = strength in cfg.tiers ? strength : 'mid';
  const reg: Region = REGIONS.includes(region) ? region : 'EU';
  const { name, tag } = generateTeamName(state, reg);
  const id = uniqueTeamId(state, slugify(name));
  const [hLo, hHi] = cfg.honor[str];
  const [fLo, fHi] = cfg.funds[str];
  const team: Team = {
    id,
    name,
    tag,
    region: reg,
    color: rng.pick(TEAM_COLORS),
    honor: rng.int(hLo, hHi),
    gold: Math.round((rng.range(fLo, fHi) * seasonEconIndex(state)) / 1000) * 1000,
    isPlayer: false,
    playerIds: [],
    lineup: { C: null, M: null, O: null, SS: null, HS: null },
    coachId: null,
    points: 0,
  };
  state.teams[id] = team;

  const tierWeights = weightsOf(cfg.tiers[str]);
  const [cMin, cMax] = CONFIG.economy.contractSeasons;
  for (const pos of POSITIONS) {
    const p = generatePlayer(state, { tier: randomTier(rng, tierWeights), position: pos, region: reg });
    addPlayerToTeam(state, p.id, id, { contractSeasons: rng.int(cMin, cMax) });
  }
  if (rng.chance(cfg.subChance)) {
    const lowest = TIERS.find((t) => tierWeights[t] > 0) ?? 'B';
    const p = generatePlayer(state, { tier: lowerTier(lowest), position: rng.pick(POSITIONS), region: reg });
    addPlayerToTeam(state, p.id, id, { contractSeasons: rng.int(cMin, cMax) });
  }
  if (rng.chance(cfg.coachChance[str] ?? 0)) {
    const coach = generateCoach(state, { tier: randomTier(rng, weightsOf(cfg.coachTier[str])), region: reg });
    coach.teamId = id;
    team.coachId = coach.id;
  }
  autoLineup(state, id);
  team.gold = realClubStartingFunds(team.gold, null, state.season?.ti ?? state.settings?.startTi ?? 1, roundWageBill(state, id));
  return team;
}

// ===========================================================================
// 种子数据转换
// ===========================================================================

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 种子选手 → Player（注册到 state.players，isReal=true，计算工资/合同） */
export function playerFromSeed(state: GameState, seed: SeedPlayer, teamId: string | null): Player {
  const existing = state.players[seed.id];
  if (existing) return existing; // 同一选手重复出现：保留首次注册
  const rng = rngOf(state);
  const ti = state.season?.ti ?? state.settings.startTi;
  const team = teamId ? state.teams[teamId] : undefined;
  const position: Position = POSITIONS.includes(seed.position) ? seed.position : 'C';
  const p: Player = {
    id: seed.id,
    handle: seed.handle || seed.id,
    nationality: (seed.nationality || 'EU').toUpperCase(),
    region: regionOfNationality(seed.nationality),
    birthYear: num(seed.birthYear, seasonYear(state) - 22),
    position,
    mmr: num(seed.mmr, CONFIG.ladder.thresholds.A),
    power: num(seed.power, 60),
    talent: num(seed.talent, 50),
    resilience: num(seed.resilience, 50),
    insight: num(seed.insight, 50),
    loyalty: num(seed.loyalty, 65),
    salary: 0,
    contractUntil: team ? ti + rng.int(0, 2) : ti,
    teamId: team ? team.id : null,
    status: 'active',
    modifiers: [],
    signatureHeroes: Array.isArray(seed.signatureHeroes) ? seed.signatureHeroes.slice() : [],
    stats: emptyStats(),
    joinedSeason: ti,
    isReal: true,
  };
  if (seed.name) p.name = seed.name;
  // 副位置（第十三波，roles.ts）：截至当届真实生涯中担任过的其他位置（种子位置即当届位置）
  refreshAltPositions(p, ti);
  clampPlayerAttrs(p);
  p.salary = computeSalary(state, p);
  state.players[p.id] = p;
  if (team && !team.playerIds.includes(p.id)) team.playerIds.push(p.id);
  return p;
}

export function coachFromSeed(state: GameState, seed: SeedCoach, teamId: string | null): Coach {
  const existing = state.coaches[seed.id];
  if (existing) return existing;
  const rng = rngOf(state);
  const tier: Tier = TIERS.includes(seed.tier) ? seed.tier : 'A';
  const team = teamId ? state.teams[teamId] : undefined;
  const coach: Coach = {
    id: seed.id,
    name: seed.name || seed.id,
    nationality: (seed.nationality || 'EU').toUpperCase(),
    birthYear: num(seed.birthYear, seasonYear(state) - 35),
    tier,
    insight: clamp(num(seed.insight, 60), 0, CONFIG.player.maxAttr),
    talentBoost: coachBoost(rng, tier),
    resilienceBoost: coachBoost(rng, tier),
    salary: coachSalary(state, tier),
    teamId: team ? team.id : null,
  };
  state.coaches[coach.id] = coach;
  if (team && !team.coachId) team.coachId = coach.id;
  return coach;
}

/** 种子战队 → Team（含选手/教练注册、自动排阵）。funds 按难度缩放由调用方处理 */
export function teamFromSeed(state: GameState, seed: SeedTeam, isPlayer: boolean): Team {
  const team: Team = {
    id: seed.id,
    name: seed.name || seed.id,
    tag: seed.tag || makeTag(seed.name || seed.id),
    region: REGIONS.includes(seed.region) ? seed.region : 'EU',
    color: seed.color || colorFromId(seed.id),
    honor: num(seed.honor, CONFIG.team.newClubHonor),
    gold: Math.round(num(seed.funds, 0)),
    isPlayer,
    playerIds: [],
    lineup: { C: null, M: null, O: null, SS: null, HS: null },
    coachId: null,
    points: 0,
  };
  state.teams[team.id] = team;

  let needAuto = false;
  (seed.players ?? []).forEach((sp, i) => {
    const p = playerFromSeed(state, sp, team.id);
    if (p.teamId !== team.id) {
      needAuto = true; // 该选手已在其他战队注册
      return;
    }
    if (i < POSITIONS.length) {
      if (!team.lineup[p.position]) team.lineup[p.position] = p.id;
      else needAuto = true;
    }
  });
  if (POSITIONS.some((pos) => !team.lineup[pos])) needAuto = true;
  if (needAuto) autoLineup(state, team.id);

  if (seed.coach) {
    const c = coachFromSeed(state, seed.coach, team.id);
    if (c.teamId === team.id || c.teamId === null) {
      c.teamId = team.id;
      team.coachId = c.id;
    }
  }
  return team;
}

/**
 * 真实新秀：基于 playerIndex 条目生成「新人期」选手（战力 ≈ firstPower × 0.88~0.95，天赋 ≈ peakTalent，
 * mmr 对应低一档），isReal=true、isRookie=true，注册到 state.players（自由选手）。
 */
export function rookieFromIndex(state: GameState, entry: PlayerIndexEntry): Player {
  const existing = state.players[entry.id];
  if (existing) return existing;
  const rng = rngOf(state);
  const gen = CONFIG.generation;
  const ti = state.season?.ti ?? state.settings.startTi;
  const firstPower = num(entry.firstPower, 60);
  // 位置：当届（或此前最近一届）的真实位置（第十三波；错过登场时机的旧条目不再沿用首次出现时的位置），无数据时用索引的首次位置
  const real = realRoleFor(entry.id, ti);
  const position: Position = real ?? (POSITIONS.includes(entry.position) ? entry.position : 'C');
  const birthYear = num(entry.birthYear, seasonYear(state) - 18);
  const age = seasonYear(state) - birthYear;
  const [rLo, rHi] = gen.rookiePowerMult;
  const p: Player = {
    id: entry.id,
    handle: entry.handle || entry.id,
    nationality: (entry.nationality || 'EU').toUpperCase(),
    region: regionOfNationality(entry.nationality),
    birthYear,
    position,
    mmr: mmrForTier(rng, lowerTier(tierForPower(firstPower))),
    power: round2(firstPower * rng.range(rLo, rHi)),
    talent: round2(clamp(num(entry.peakTalent, 60) + rng.normal(0, 2), 0, CONFIG.player.maxAttr)),
    resilience: genAttr(rng, gen.resilienceBase + (age - 18) * gen.resiliencePerYear),
    insight: round2(num(entry.insight, 50) * rng.range(gen.rookieInsightMult[0], gen.rookieInsightMult[1])),
    loyalty: genAttr(rng, gen.loyaltyMean + gen.rookieLoyaltyBonus, gen.loyaltySd),
    salary: 0,
    contractUntil: ti,
    teamId: null,
    status: 'active',
    modifiers: [],
    signatureHeroes: Array.isArray(entry.signatureHeroes) ? entry.signatureHeroes.slice() : [],
    stats: emptyStats(),
    joinedSeason: ti,
    isRookie: true,
    isReal: true,
  };
  if (entry.name) p.name = entry.name;
  refreshAltPositions(p, ti);
  clampPlayerAttrs(p);
  p.salary = computeSalary(state, p, true);
  state.players[p.id] = p;
  return p;
}

/** 退役选手 → 同等级教练（insight 继承，boost 按等级随机），注册到 state.coaches */
export function coachFromRetiredPlayer(state: GameState, p: Player): Coach {
  const rng = rngOf(state);
  const tier = playerTier(p);
  let id = `coach-${p.id}`;
  if (state.coaches[id]) id = uniqueId(state, `coach-${p.id}`, state.coaches);
  const coach: Coach = {
    id,
    name: p.handle,
    nationality: p.nationality,
    birthYear: p.birthYear,
    tier,
    insight: round2(clamp(num(p.insight, 50), 0, CONFIG.player.maxAttr)),
    talentBoost: coachBoost(rng, tier),
    resilienceBoost: coachBoost(rng, tier),
    salary: coachSalary(state, tier),
    teamId: null,
    formerPlayerId: p.id,
  };
  state.coaches[coach.id] = coach;
  return coach;
}

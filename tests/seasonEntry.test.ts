// 赛季中报名 / 退赛与补充邀请（第十四波，src/engine/schedule.ts）：
// 补充邀请按本赛季积分榜触发、只增不撤；人类战队默认接受 + 通知 + 同回合冲突处理；退赛扣荣誉（同回合免扣、提前减半、低荣誉减损、跌破 0 禁止）；
// 重新报名 / 重新接受；确定性（不消耗随机数）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameState, RoundInfo, TiInfo, TournamentTemplate } from '../src/engine/types';
import { makeTestState } from './helpers';

// ---------------------------------------------------------------------------
// 依赖模块桩（与 tests/schedule.test.ts 相同）
// ---------------------------------------------------------------------------
vi.mock('../src/data/index', () => ({
  getTournamentTemplates: vi.fn(() => []),
  getTiInfo: vi.fn(() => { throw new Error('缺少 TI 数据'); }),
  lastTournamentDataSeason: vi.fn(() => 0),
}));
vi.mock('../src/engine/calendar', () => ({
  roundIndexForDate: (season: { rounds: RoundInfo[] }, date: string) => {
    let last = 1;
    for (const r of season.rounds) {
      if (r.phase !== 'regular') continue;
      last = r.index;
      if (date < r.endDate) return r.index;
    }
    return last;
  },
  regularRoundCount: (season: { rounds: RoundInfo[] }) => season.rounds.filter((r) => r.phase === 'regular').length || 18,
}));
vi.mock('../src/engine/team', () => ({
  teamRating: (state: GameState, id: string) => {
    const t = state.teams[id];
    if (!t) return 0;
    let s = 0;
    for (const pid of Object.values(t.lineup)) if (pid && state.players[pid]) s += state.players[pid].power;
    return s;
  },
}));
vi.mock('../src/engine/economy', () => ({
  addFinance: (state: GameState, teamId: string, amount: number) => {
    const t = state.teams[teamId];
    if (t) t.gold += Math.round(amount);
  },
  econ: () => 1,
  econIndex: () => 1,
}));
vi.mock('../src/engine/growth', () => ({ applyTournamentGrowth: () => [], adjustLoyalty: () => {} }));
vi.mock('../src/engine/market', () => ({ releaseTempSubs: () => {} }));

import * as data from '../src/data/index';
import {
  buildSeasonTournaments, isFillerCup, refreshSeasonInvites, registerForTournament, startRoundTournaments,
  unregisterFromTournament, withdrawPenaltyOf,
} from '../src/engine/schedule';
import { CONFIG } from '../src/engine/config';

// ---------------------------------------------------------------------------
// 夹具：6 个常规回合 + TI 预选(7) + TI(8)
// ---------------------------------------------------------------------------
const R = 6;
function buildRounds(): RoundInfo[] {
  const ends = ['2018-10-20', '2018-12-10', '2019-01-30', '2019-03-20', '2019-05-10', '2019-07-10'];
  const rounds: RoundInfo[] = [{ index: 0, phase: 'preseason', startDate: '2018-09-01', endDate: '2018-09-01', tournamentIds: [], patchVersions: [] }];
  let prev = '2018-09-01';
  ends.forEach((end, i) => {
    rounds.push({ index: i + 1, phase: 'regular', startDate: prev, endDate: end, tournamentIds: [], patchVersions: [] });
    prev = end;
  });
  rounds.push({ index: R + 1, phase: 'ti_qualifier', startDate: '2019-07-10', endDate: '2019-08-15', tournamentIds: [], patchVersions: [] });
  rounds.push({ index: R + 2, phase: 'ti', startDate: '2019-08-15', endDate: '2019-08-25', tournamentIds: [], patchVersions: [] });
  return rounds;
}

function tpl(over: Partial<TournamentTemplate> & { id: string; startDate: string }): TournamentTemplate {
  return {
    seriesId: over.id.replace(/-\d{4}$/, ''), name: over.id, tier: 'minor', endDate: over.startDate, city: '城市',
    hostRegion: 'EU', prizePool: 300000, teams: 8, invites: 4, format: 'de8', ...over,
  };
}

const TEMPLATES: TournamentTemplate[] = [
  tpl({ id: 'r2-minor-2018', startDate: '2018-11-01', invites: 4 }),
  tpl({ id: 'r4-major-2019', tier: 'major', startDate: '2019-03-01', invites: 4, prizePool: 1_000_000, format: 'groups_de' }),
  tpl({ id: 'r4-minor-2019', startDate: '2019-03-05', invites: 2 }),
  tpl({ id: 'r5-cn-league-2019', tier: 'premier', startDate: '2019-04-01', teams: 6, invites: 1, regionLocked: 'CN', format: 'rr' }),
  tpl({ id: 'r6-minor-2019', startDate: '2019-06-01', invites: 4 }),
];

const TI9: TiInfo = {
  ti: 9, year: 2019, name: 'The International 2019', city: '上海', country: 'CN', hostRegion: 'CN',
  startDate: '2019-08-15', endDate: '2019-08-25', prizePool: 30_000_000, teams: 8, directInvites: 4,
  qualifierSlots: { CN: 2, EU: 2 },
};

/** 16 队（t0 = 玩家，CN；t6 / t12 也是 CN），AI 上赛季排名 t_i = i；玩家默认排在最后（不获赛季初邀请） */
function setup(playerRank = 99): GameState {
  const state = makeTestState(16);
  state.season.rounds = buildRounds();
  state.season.tiStartDate = '2019-08-15';
  Object.values(state.teams).forEach((t, i) => { t.lastSeasonRank = i; });
  state.teams.t0.lastSeasonRank = playerRank;
  return state;
}

/** 进入第 idx 个常规回合（只改回合号，赛事状态由测试自己安排） */
function atRound(state: GameState, idx: number): void {
  state.roundIndex = idx;
  state.phase = 'regular';
}

function points(state: GameState, pts: Record<string, number>): void {
  for (const id in state.teams) state.teams[id].points = pts[id] ?? 0;
}

beforeEach(() => {
  vi.mocked(data.getTournamentTemplates).mockImplementation((ti: number) => (ti === 9 ? TEMPLATES.slice() : []));
  vi.mocked(data.lastTournamentDataSeason).mockReturnValue(9);
  vi.mocked(data.getTiInfo).mockImplementation((ti: number) => {
    if (ti === 9) return TI9;
    throw new Error('缺少 TI 数据');
  });
});

// ---------------------------------------------------------------------------
describe('补充邀请（AI）', () => {
  it('按本赛季积分榜补邀：婉拒 / 解散腾出的席位 + 追加席位；只增不撤；同回合已受邀更高等级的 AI 不重复补邀', () => {
    const s = setup();
    buildSeasonTournaments(s);
    const major = s.tournaments['r4-major-2019'];
    const minor4 = s.tournaments['r4-minor-2019'];
    const r2 = s.tournaments['r2-minor-2018'];
    expect(major.invitedTeamIds).toEqual(['t1', 't2', 't3', 't4']);
    expect(major.inviteSlots).toBe(4);
    expect(minor4.invitedTeamIds).toEqual(['t1', 't2']);
    points(s, { t9: 900, t10: 800, t11: 700, t12: 600, t13: 500 });
    atRound(s, 1);
    const rng0 = s.rngState;
    const added = refreshSeasonInvites(s);
    expect(added).toBeGreaterThan(0);
    expect(s.rngState).toBe(rng0); // 不消耗随机数
    // 追加 2 席：积分榜前 4（直邀名额）中尚未受邀的，按积分顺序
    expect(major.invitedTeamIds).toEqual(['t1', 't2', 't3', 't4', 't9', 't10']);
    expect(major.lateInvites).toEqual({ t9: 2, t10: 2 });
    // 下回合（第 2 回合）开赛的赛事 AI 照常补邀
    expect(r2.lateInvites).toEqual({ t9: 2, t10: 2 });
    // 同回合的 Minor（直邀 2 名）：积分榜前 2 已受邀同回合的 Major → 不补邀
    expect(minor4.lateInvites).toBeUndefined();
    expect(minor4.invitedTeamIds).toEqual(['t1', 't2']);
    // 只评估未来 horizonRounds（4）个回合内开赛的赛事：第 6 回合的 Minor 留到临近时再按当时的积分榜评估
    expect(CONFIG.tournament.lateInvite.horizonRounds).toBe(4);
    expect(s.tournaments['r6-minor-2019'].lateInvites).toBeUndefined();

    // 名额已满：再评估不变（不重复、不撤销）
    const before = JSON.stringify(major.invitedTeamIds);
    expect(refreshSeasonInvites(s)).toBe(0);
    expect(JSON.stringify(major.invitedTeamIds)).toBe(before);
    // 积分榜变化（t9 掉出前 4）也不撤销已有邀请
    points(s, { t11: 900, t12: 800, t13: 700, t14: 600 });
    refreshSeasonInvites(s);
    expect(major.invitedTeamIds).toEqual(expect.arrayContaining(['t9', 't10']));
    // 解散腾出 1 席 → 按积分榜补 1 队
    s.teams.t2.disbanded = true;
    atRound(s, 2);
    refreshSeasonInvites(s);
    expect(major.invitedTeamIds).toContain('t2'); // 名单保留（开赛时自动跳过解散战队）
    expect(major.invitedTeamIds).toContain('t11');
    expect(major.lateInvites?.t11).toBe(3);
    expect(major.invitedTeamIds.filter((id) => !s.teams[id].disbanded).length).toBe(6);
    // 第 2 回合结束：第 6 回合的赛事进入评估窗口，按当时的积分榜补邀（2 个追加席位 + 解散的 t2 腾出的 1 席）
    expect(s.tournaments['r6-minor-2019'].lateInvites).toEqual({ t11: 3, t12: 3, t13: 3 });
  });

  it('赛区锁定赛事按赛区内排名；需本赛季已有积分；线上公开赛 / TI 不参与；开赛时补邀的 AI 进入正赛', () => {
    const s = setup();
    buildSeasonTournaments(s);
    const cn = s.tournaments['r5-cn-league-2019'];
    expect(cn.invitedTeamIds).toEqual(['t6']);
    // 没有积分 → 不按排名补邀
    atRound(s, 1);
    refreshSeasonInvites(s);
    expect(cn.lateInvites).toBeUndefined();
    // t12（CN）本赛季积分在 CN 赛区第 1 → 补邀；EU 的 t1 积分更高但赛区不符
    points(s, { t1: 2000, t12: 300 });
    refreshSeasonInvites(s);
    expect(cn.lateInvites).toEqual({ t12: 2 });
    for (const id of s.seasonTournamentIds) {
      const t = s.tournaments[id];
      if (isFillerCup(t) || t.tier === 'ti') expect(t.lateInvites).toBeUndefined();
    }
    // 第 2 回合开赛：补邀的 AI 直接进入正赛（r2 已补邀 t12，还剩 1 个追加席位 → t9）
    points(s, { t9: 900, t10: 800 });
    refreshSeasonInvites(s);
    const r2 = s.tournaments['r2-minor-2018'];
    expect(r2.lateInvites).toEqual({ t12: 2, t9: 2 });
    startRoundTournaments(s, 2);
    expect(r2.status).toBe('running');
    expect(r2.teamIds).toEqual(expect.arrayContaining(['t12', 't9']));
    expect(r2.teamIds).not.toContain('t10');
  });

  it('确定性：同样的状态得到同样的补邀结果', () => {
    const run = () => {
      const s = setup();
      buildSeasonTournaments(s);
      points(s, { t9: 900, t10: 800, t11: 700, t12: 600, t13: 500, t0: 400 });
      atRound(s, 1);
      refreshSeasonInvites(s);
      return JSON.stringify(s.seasonTournamentIds.map((id) => [id, s.tournaments[id].invitedTeamIds, s.tournaments[id].lateInvites ?? null]));
    };
    expect(run()).toBe(run());
  });
});

describe('补充邀请（人类战队）', () => {
  it('默认接受 + 总览通知 + 新闻；下回合开赛的赛事不补邀人类；收到的回合内婉拒免扣，之后退出按规则扣荣誉', () => {
    const s = setup();
    buildSeasonTournaments(s);
    const major = s.tournaments['r4-major-2019'];
    const r2 = s.tournaments['r2-minor-2018'];
    expect(major.playerStatus).toBe('open');
    points(s, { t0: 2000, t9: 900 });
    atRound(s, 1);
    s.popups = [];
    refreshSeasonInvites(s);
    expect(r2.invitedTeamIds).not.toContain('t0'); // 第 2 回合开赛，来不及婉拒
    expect(r2.invitedTeamIds).toContain('t9');
    expect(major.invitedTeamIds).toContain('t0');
    expect(major.playerStatus).toBe('invited');
    expect(major.entryRound).toBe(2);
    expect(major.lateInvites?.t0).toBe(2);
    expect(s.season.registeredTournamentIds).toContain(major.id);
    const news = s.news.find((n) => n.title.startsWith('【补充邀请】'));
    expect(news).toBeTruthy();
    expect(news!.visibility).toBe('private');
    expect(news!.body).toContain('本赛季积分榜第 1 名');
    expect(news!.body).toContain('第 2 回合内婉拒补充邀请不扣荣誉');
    expect(s.popups.some((p) => p.kind === 'message' && p.title.startsWith('【补充邀请】'))).toBe(true);

    // 第 2 回合（收到通知的回合）婉拒：不扣荣誉
    atRound(s, 2);
    const pen = withdrawPenaltyOf(s, major.id)!;
    expect(pen.free).toBe(true);
    expect(pen.reason).toContain('补充邀请');
    expect(unregisterFromTournament(s, major.id).ok).toBe(true);
    expect(s.teams.t0.honor).toBe(300);
    expect(major.playerStatus).toBe('declined');
    expect(major.entryRound).toBeUndefined();
    // 已婉拒的人类不再被补邀覆盖（仍在名单中，可重新接受），腾出的席位可由 AI 递补
    refreshSeasonInvites(s);
    expect(major.playerStatus).toBe('declined');
    // 重新接受（第 2 回合）→ 第 3 回合退出扣 Major 全额（距开赛 1 回合不减半）
    expect(registerForTournament(s, major.id).ok).toBe(true);
    expect(major.playerStatus).toBe('invited');
    expect(major.entryRound).toBe(2);
    atRound(s, 3);
    const full = withdrawPenaltyOf(s, major.id)!;
    expect(full.free).toBe(false);
    expect(full.far).toBe(false);
    expect(full.honor).toBe(CONFIG.honor.withdraw.major);
    const res = unregisterFromTournament(s, major.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain(`荣誉 −${-CONFIG.honor.withdraw.major}`);
    expect(res.message).toContain('已扣的荣誉不退还');
    expect(s.teams.t0.honor).toBe(300 + CONFIG.honor.withdraw.major);
    expect(s.news[0].title).toContain('【婉拒邀请】');
    expect(s.news[0].body).toContain(`Major 退赛扣 ${-CONFIG.honor.withdraw.major} 荣誉`);
    expect(s.history.honor.at(-1)?.value).toBe(300 + CONFIG.honor.withdraw.major);
    // 邀请仍保留：开赛前可再次接受
    expect(major.invitedTeamIds).toContain('t0');
    expect(registerForTournament(s, major.id).ok).toBe(true);
  });

  it('同回合冲突：低等级的已有报名让位（不扣荣誉）；已有更高等级邀请时补充邀请记为已婉拒；已报名的同一赛事升级为受邀', () => {
    // 1) 已报名同回合的 Minor → Major 补充邀请：Minor 让位（不扣荣誉）；
    //    玩家同时进入 Minor 的直邀名额 → Minor 的补充邀请因与 Major 同期记为已婉拒（可在收到的回合内免费改回）
    const s = setup();
    buildSeasonTournaments(s);
    const major = s.tournaments['r4-major-2019'];
    const minor4 = s.tournaments['r4-minor-2019'];
    expect(registerForTournament(s, minor4.id).ok).toBe(true);
    points(s, { t0: 2000 });
    atRound(s, 1);
    refreshSeasonInvites(s);
    expect(major.playerStatus).toBe('invited');
    expect(s.season.registeredTournamentIds).not.toContain(minor4.id);
    expect(minor4.playerStatus).toBe('declined');
    expect(minor4.invitedTeamIds).toContain('t0');
    expect(s.teams.t0.honor).toBe(300);
    const note = s.news.find((n) => n.title.startsWith('【补充邀请】'))!;
    expect(note.title).toMatch(/收到 \d+ 项赛事的邀请/);
    expect(note.body).toContain('让位');
    // 收到通知的回合内改回：婉拒 Major（免扣）→ 以受邀身份接受 Minor
    atRound(s, 2);
    expect(unregisterFromTournament(s, major.id).ok).toBe(true);
    expect(registerForTournament(s, minor4.id).ok).toBe(true);
    expect(minor4.playerStatus).toBe('invited');
    expect(s.teams.t0.honor).toBe(300);

    // 2) 赛季初已受邀同回合的 Major → Minor 补充邀请记为已婉拒
    const s2 = setup(3);
    buildSeasonTournaments(s2);
    const major2 = s2.tournaments['r4-major-2019'];
    const minor2 = s2.tournaments['r4-minor-2019'];
    expect(major2.playerStatus).toBe('invited');
    expect(minor2.playerStatus).toBe('open');
    points(s2, { t0: 2000 });
    atRound(s2, 1);
    refreshSeasonInvites(s2);
    expect(minor2.invitedTeamIds).toContain('t0');
    expect(minor2.playerStatus).toBe('declined');
    expect(major2.playerStatus).toBe('invited');
    expect(s2.news.find((n) => n.title.startsWith('【补充邀请】'))!.body).toContain('先记为已婉拒');

    // 3) 已报名（需打封闭预选）的 Major → 升级为受邀，报名回合不变
    const s3 = setup();
    buildSeasonTournaments(s3);
    const major3 = s3.tournaments['r4-major-2019'];
    expect(registerForTournament(s3, major3.id).ok).toBe(true);
    expect(major3.entryRound).toBe(0);
    points(s3, { t0: 2000 });
    atRound(s3, 1);
    refreshSeasonInvites(s3);
    expect(major3.playerStatus).toBe('invited');
    expect(major3.entryRound).toBe(0);
    expect(s3.news.find((n) => n.title.startsWith('【补充邀请】'))!.body).toContain('升级为受邀');
  });
});

describe('退赛扣荣誉', () => {
  it('赛季初免扣；距开赛 ≥ 3 回合减半；低荣誉减损；扣分后跌破 0 不允许退出；同一回合内反悔免扣', () => {
    const s = setup();
    buildSeasonTournaments(s);
    const minor = s.tournaments['r6-minor-2019'];
    expect(registerForTournament(s, minor.id).ok).toBe(true);
    expect(minor.entryRound).toBe(0);
    const pre = withdrawPenaltyOf(s, minor.id)!;
    expect(pre.free).toBe(true);
    expect(pre.reason).toContain('赛季初');

    atRound(s, 2); // 距开赛 4 回合 → 减半
    const far = withdrawPenaltyOf(s, minor.id)!;
    expect(far.far).toBe(true);
    expect(far.honor).toBe(-Math.round(-CONFIG.honor.withdraw.minor * CONFIG.honor.withdrawFarMult));
    expect(far.reason).toContain('减半');
    atRound(s, 4); // 距开赛 2 回合 → 全额
    expect(withdrawPenaltyOf(s, minor.id)!.honor).toBe(CONFIG.honor.withdraw.minor);
    // 低荣誉减损：荣誉 100 → × (0.4 + 0.6 × 100/300) = 0.6
    s.teams.t0.honor = 100;
    const low = withdrawPenaltyOf(s, minor.id)!;
    expect(low.honor).toBe(-Math.round(-CONFIG.honor.withdraw.minor * 0.6));
    expect(low.reason).toContain('低荣誉减损');
    // 扣分后跌破 0 → 不允许退出
    s.teams.t0.honor = 3;
    expect(withdrawPenaltyOf(s, minor.id)!.blocked).toBeTruthy();
    const no = unregisterFromTournament(s, minor.id);
    expect(no.ok).toBe(false);
    expect(no.message).toContain('跌破 0');
    expect(minor.playerStatus).toBe('registered');
    expect(s.teams.t0.honor).toBe(3);

    s.teams.t0.honor = 300;
    const out = unregisterFromTournament(s, minor.id);
    expect(out.ok).toBe(true);
    expect(s.teams.t0.honor).toBe(300 + CONFIG.honor.withdraw.minor);
    expect(s.news[0].title).toContain('【退赛】');
    expect(s.news[0].body).toContain('Minor 退赛扣');
    // 退出后可重新报名；同一回合内再反悔不扣
    expect(registerForTournament(s, minor.id).ok).toBe(true);
    expect(minor.entryRound).toBe(4);
    const same = withdrawPenaltyOf(s, minor.id)!;
    expect(same.free).toBe(true);
    expect(same.reason).toContain('同一回合');
    expect(unregisterFromTournament(s, minor.id).ok).toBe(true);
    expect(s.teams.t0.honor).toBe(300 + CONFIG.honor.withdraw.minor);
  });

  it('赛季初的邀请赛季中婉拒要扣荣誉；线上公开赛按 withdrawOpenCup；TI 阶段与未报名赛事没有退出代价（不可退出）', () => {
    const s = setup(1);
    buildSeasonTournaments(s);
    const major = s.tournaments['r4-major-2019'];
    expect(major.playerStatus).toBe('invited');
    expect(major.entryRound).toBeUndefined(); // 赛季初的邀请缺省按第 0 回合
    atRound(s, 1);
    const pen = withdrawPenaltyOf(s, major.id)!;
    expect(pen.free).toBe(false);
    expect(pen.far).toBe(true); // 距开赛 3 回合
    expect(pen.honor).toBe(-Math.round(-CONFIG.honor.withdraw.major * CONFIG.honor.withdrawFarMult));

    expect(withdrawPenaltyOf(s, 'ti-9')).toBeNull();
    expect(unregisterFromTournament(s, 'ti-9').ok).toBe(false);
    const open = s.seasonTournamentIds.map((id) => s.tournaments[id]).find((t) => t.playerStatus === 'open')!;
    expect(withdrawPenaltyOf(s, open.id)).toBeNull(); // 未报名

    // 线上公开赛：按 withdrawOpenCup
    const s2 = setup();
    vi.mocked(data.getTournamentTemplates).mockImplementation((ti: number) => (ti === 9 ? [TEMPLATES[1]] : []));
    buildSeasonTournaments(s2);
    const cup = s2.seasonTournamentIds.map((id) => s2.tournaments[id]).find((t) => isFillerCup(t) && t.roundIndex === 6)!;
    expect(cup).toBeTruthy();
    expect(registerForTournament(s2, cup.id).ok).toBe(true);
    atRound(s2, 5);
    expect(withdrawPenaltyOf(s2, cup.id)!.honor).toBe(CONFIG.honor.withdrawOpenCup);
    expect(withdrawPenaltyOf(s2, cup.id)!.reason).toContain('线上公开赛');
  });
});

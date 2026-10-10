// 冒烟测试：手动比赛流程（准备 → 手动 BP → 直播 → 提交），覆盖若干赛季
import { registerNodeRosterLoader } from './nodeData';
import * as E from '../src/engine';
import { draftSuggestions } from '../src/engine/draft';

registerNodeRosterLoader();
const ti = Number(process.argv[2] ?? 9);

async function main() {
  const g = await E.createNewGame({ startTi: ti, seasons: 2, difficulty: 'normal', managerName: 'T', teamId: undefined, newClub: undefined, seed: 7 } as never)
    .catch(async () => E.createNewGame({ startTi: ti, seasons: 2, difficulty: 'normal', managerName: 'T', newClub: { name: '测试', tag: 'TST', region: 'CN', color: '#c23c2a' }, seed: 7 }));
  let games = 0;
  for (let step = 0; step < 400 && !g.gameOver; step++) {
    // 处理决策
    while (g.pendingDecisions.length) E.resolveDecision(g, g.pendingDecisions[0].id, g.pendingDecisions[0].choices[0]?.id ?? '');
    // 报名所有可报名赛事
    if (g.phase === 'preseason') for (const id of g.seasonTournamentIds) if (g.tournaments[id]?.playerStatus === 'open') E.registerForTournament(g, id);
    const t = E.currentPlayerTournament(g);
    if (t && t.status === 'running') {
      // 首发凑不齐 5 人时先招募临时替补（否则手动比赛无法开始、快速模拟会弃权判负）
      if (E.validateLineup(g, g.settings.playerTeamId, t.id).length) E.fillLineupWithTempSubs(g);
      const r = E.prepareNextMatch(g);
      if (r.ok && g.activeMatch) {
        while (g.activeMatch) {
          const s1 = E.startDraft(g, true);
          if (!s1.ok) throw new Error('startDraft ' + s1.message);
          let guard = 0;
          while (g.activeMatch?.draft && !g.activeMatch.draft.done && guard++ < 30) {
            const sug = E.getDraftSuggestions(g);
            const hero = sug[0]?.heroId ?? g.activeMatch.draft.available[0];
            const res = E.playerDraftAction(g, hero);
            if (!res.ok) throw new Error('draftAction ' + res.message);
          }
          const pg = E.playGame(g);
          if (!pg.ok) throw new Error('playGame ' + pg.message);
          const rec = g.activeMatch!.pendingGame!;
          if (!rec.live.length) throw new Error('no live events');
          games++;
          const c = E.commitGame(g);
          if (!c.ok) throw new Error('commit ' + c.message);
        }
        continue;
      }
    }
    if (g.phase !== 'preseason' && E.trainingSessionsLeft(g) > 0) E.doTraining(g);
    const blockers = E.getAdvanceBlockers(g);
    if (blockers.length) {
      console.log('blocked:', blockers.map((b) => b.message).join(' | '));
      if (t) { E.quickSimTournament(g); continue; }
      break;
    }
    E.advance(g);
  }
  console.log(`OK: played ${games} manual games; season TI${g.season.ti} round ${g.roundIndex} gameOver=${!!g.gameOver}`);
  void draftSuggestions;
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });

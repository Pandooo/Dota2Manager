// 引擎公共出口（Store/UI 从这里导入）
export * from './types';
export * from './config';
export * from './util';
export { rngOf, seededRng, hashSeed } from './rng';
export * from './game';
export * from './save';
export {
  tierOf, tierIndex, ladderMult, ageOf, effectiveAttr, effectivePower, playerTier, playerRating, overallRating,
  marketValue, isAvailable, regionOfNationality,
} from './player';
// 位置（第十三波：副位置 / 四五号位互换 / 真实生涯位置；只读查询，位置同步由引擎在赛季初与读档时自动完成）
export {
  ROLE_FIT_LABEL, roleFit, roleFactor, roleFitFactor, roleFitText, positionText, naturalPositions, playsNaturally,
  realRoleSpans, uncoveredPositions,
} from './roles';
export type { RoleFit } from './roles';
export {
  getPlayerTeam, teamPlayers, lineupPlayers, benchPlayers, autoLineup, validateLineup, setLineupSlot,
  teamRating, teamInsight, rosterRoom, rosterSize, rosterHardRoom, rosterSigningBlock, rosterOverflowNotice, rosterSigningNote, rosterOverCap, rosterOverCapNotice,
  rankTeamsByRating, getCoach, activeTeams,
} from './team';
export { scrimMultiplier, overRosterBenchPenalty } from './growth';
export { scrimInsightMult } from './growth';
export { scrimBookedIds, isScrimBooked } from './trainingLog';
export { heroById, heroName, availableHeroes } from './heroes';
export { DRAFT_SEQUENCE, currentStep } from './draft';
export type { DraftSuggestion } from './draft';
export { honorLuck, expectedRank } from './honor';
export {
  registerForTournament, unregisterFromTournament, computePlayerEntryStatus, playerTournamentInRound, roundCounts,
  seasonStandings, isFillerCup, withdrawPenaltyOf,
} from './schedule';
export type { WithdrawPenalty } from './schedule';
export { readySeries, playerNextSeries, isTeamEliminated, prizeForPlacement } from './tournament';
export { econIndex, econ, roundWageBill, extraTrainingCost, scrimCost } from './economy';
export {
  awardedPrizePool, awardedPrize, payoutShare, tournamentAppearanceFee, qualifierAppearanceFee,
  realClubStartingFunds, newClubStartingFunds, estimateNewClubStartingFunds, estimateNewClubStart, newClubGachaGrant,
  eraFundsFactor, realClubWealth, seedTeamWageBill, seedTeamStartingFunds,
} from './economy';
export {
  roundRevenue, sponsorContract, sponsorQuote, streamingIncome, activeMerchBoosts, seasonProjection, remainingPaidRounds,
} from './revenue';
export type { RoundRevenue, SeasonProjection } from './revenue';
export {
  isTransferWindowOpen, freeAgents, playerWillingness, signFreeAgent, suggestedFee, bidForPlayer, respondToOffer,
  releasePlayer, releasePlayers, releaseCompensation, renewContract, generateTempSubCandidates, tempSubCost, hireTempSub,
  signingFee, aiAcceptChance, importanceInTeam,
} from './market';
// 选手交易（现金 + 本队选手抵价求购；玩家操作 tradeForPlayer 为白名单 RPC，tradeValuation / tradeQuote 为界面只读估值）
export { tradeForPlayer, tradeValuation, tradeQuote, tradeOfferBlock, tradeHoldRoundsLabel } from './trade';
export type { TradeItem, TradeValuation, TradeQuote } from './trade';
// 新秀选秀（2026-10-14 起默认关闭：CONFIG.draft.enabled；保留一个版本供旧存档查看往届选秀）
export {
  rookieDraftRecord, rookieDraftHistory, rookieTierProbabilities, nextRookieSsrChance, lotteryOddsTable, rookieSlotSalary,
  rookieContractSeasons, postDraftRosterLimit, draftedRookiesOf, draftedRookieReleaseBlock, releaseDraftedRookie,
} from './rookieDraft';
// 新秀抽卡（2026-10-14 取代选秀）：玩家操作 gachaPull / gachaDiscard（白名单 RPC）+ UI 只读查询
export {
  gachaPull, gachaDiscard, gachaPullBlock, gachaDiscardBlock, gachaDiscardRefund, gachaPrice, gachaPriceForTi, gachaCost, gachaView, gachaLog,
  gachaHistory, gachaTierProbabilities, gachaPityThreshold, currentGachaPool, teamSeasonPulls, pullLabel, GACHA_KIND_LABEL,
  gachaRookieWageCap, gachaRookieSalary, gachaOverCapAfter,
} from './gacha';
export type { GachaView, GachaTierView, GachaPullResult } from './gacha';
// 名人堂（请神原型；只读查询：DotaPedia 名人堂页、选手页的请神关系。入选由引擎在赛季结算时自动完成）
export { HOF_SOURCE_LABEL, hallOfFameRows, hofMember, livingSummonsOf, isSummonable } from './hallOfFame';
export type { HallOfFameRow } from './hallOfFame';
export { resolveDecision } from './events';
export { allPatches, patchByVersion, patchAt } from './patches';
export { tiYear, currentRound, regularRoundCount, roundKindForPlayer } from './calendar';
export { addNews } from './news';
export {
  squadRoundKey, raiseSalary, raiseSalaryPreview, talkToPlayer, talkSuccessChance, talkedThisRound, teamBuilding,
  teamBuildingCost, teamBuildingDoneThisRound, activeListing, listedPlayers, listingPriceRange, listingOffers,
  listPlayerForTransfer, listPlayersForTransfer, unlistPlayer, listingBidOutlook, processTransferListings,
  LISTING_RULE_VERSION, listingRoundsPerSeason, listingDurationRounds, listingDurationLabel, listingProgress, migrateListing,
  migrateTransferListings, listingStaleFactor, listingRoundStatus, listingClock, listingListedAtLabel, gachaResaleLockLeft,
  gachaResaleLockText, gachaResaleLockBrief, gachaResaleHoldRounds, listingMinTeamMatches, teamSeriesCount, teamMatchesSinceJoin, listingMatchLockLeft,
  listingMinTransferRounds, transferRoundsSinceJoin, listingRoundLockLeft, listingJoinLock, listingJoinLocked,
  listingJoinLockText, listingJoinLockTitle, listingJoinLockBrief, gachaListingRuleText, resaleLockText, resaleLocked,
} from './squadOps';
export type { RaisePreview, ListingBidOutlook, ListingProgress, ListingRoundStatus, ListingJoinLock } from './squadOps';
// 薪资情绪（只导出定性信息；隐藏的预期薪资数值不在界面展示）
export {
  SALARY_MOOD_LABEL, OVERALL_MOOD_LABEL, playerSalaryMood, playerMoodSummary, renewalAsk, salaryMoodOf,
  // 签约 / 求购后的工资（含隐藏浮动，与续约要价同法，无法反推出精确的预期薪资）
  signingSalary,
} from './salary';
export type { SalaryMood, OverallMood, PlayerMoodSummary } from './salary';
// 选手奖金分成（第九波）：玩家操作 setPrizeShare（白名单 RPC）+ UI 只读查询
export {
  setPrizeShare, prizeSharePreview, prizeShareStatus, prizeShareOf, splitPrize, prizeSplitText, formatPrizeShare,
  prizeCutLoyaltyGain, prizeShareChangeLoyalty, prizeShareLoyaltyDelta,
} from './prizeShare';
export type { PrizeSharePreview, PrizeShareStatus, PrizeSplit, PrizeShareMemberEffect } from './prizeShare';
export {
  recordTraining, snapshotSquad, trainingSummary, trainingRecords, squadProgressOf, nextTrainingSession, pendingExtraSessionCost,
} from './trainingLog';
export type {
  TrainingRecordInput, TrainingSummary, TrainingGainTotals, PlayerTrainingTotals, FocusTrainingStats,
} from './trainingLog';
export { FORM_SOURCE, FORM_LABELS, formLabel, seasonFormOf, seasonFormModifier, peakWindow } from './form';
export type { FormLabel } from './form';
// 荣誉势头（第十四波；只读查询，回合结算由 season.ts 自动完成）
export { MOMENTUM_LABELS, momentumLabel, teamMomentumMult, teamMomentumView, teamYoyShift } from './momentum';
export type { MomentumLabel, TeamMomentumView } from './momentum';
// 赛季自主成长（第九波：只导出定性的成长趋势，隐藏的潜力上限不在界面展示）
export { developmentOutlook, GROWTH_OUTLOOKS, GROWTH_OUTLOOK_HINT } from './development';
export type { GrowthOutlook } from './development';
export {
  markNewsRead, dismissPopups, setPlayerAsStarter, talkWithPlayer, autoDraftAndPlay, autoArrangeLineup,
} from './uiActions';
// 多人对战（座位视图上的只读查询；服务器侧 API 见 src/engine/multi.ts）
export { isMultiplayer, isHumanTeam, h2hMatch } from './multi';
// 俱乐部全员假赛 / 生涯总结（第八波 #6 #7；只读查询，UI 结算页使用）
export { isClubBanned } from './scandal';
export {
  computeLegacyReport, computeAllLegacyReports, legacyClubs, legacyEndingOf, legacyTitleOf, legacyScore, clubStats, clubLine,
} from './legacy';
export type {
  LegacyReport, LegacyClubRef, LegacyStats, LegacyScore, LegacyTitle, LegacyBoardRow, LegacyTimelineRow, LegacyMoment,
  LegacyBestPlayer,
} from './legacy';
// DotaPedia 百科（stats.ts 记录 / pedia.ts 查询；纯只读查询，UI 在渲染时调用；数据为全局公开数据，多人模式各座位视图一致）
export {
  pediaDashboard, pediaTeamPage, pediaPlayerPage, pediaHasPlayer, pediaTournaments, pediaTournament, pediaHeroStats, pediaHeroTrend,
  pediaSearch, pediaLegacyBoard, pediaTeamLegacy, pediaPlayerStanding, pediaPlayerStandingBoard, pediaTiChampions,
  pediaRecords, pediaSeasons, pediaPreGameOf, majorSeasonOf, PEDIA_RECORD_LABEL, PEDIA_TIERS,
} from './pedia';
export type {
  PediaStatTotals, PediaPlayerTotals, PediaTeamTotals, PediaTitleRef, PediaPlacementRow, PediaBoardRow, PediaBoard,
  PediaRecordRow, PediaTiChampionRow, PediaPreGame, PediaTeamLegacy, PediaPlayerStanding, PediaOverview, PediaDashboard,
  PediaTeamSeasonView, PediaTeamPage, PediaPlayerSeasonView, PediaPlayerTiResult, PediaPlayerPage, PediaTournamentRow,
  PediaTournamentPage, PediaHeroRow, PediaSearchHit,
} from './pedia';
export { pediaOf, pediaEnabled, PEDIA_VERSION, stripLegacyGameBoxes } from './stats';
// 俱乐部品牌变迁（第十波 #4；只读查询：品牌沿革、队徽辅色、同一组织的战队 id。套用由 season.startSeason 自动完成）
export { brandOrgs, brandOrgOf, brandEraAt, brandColor2For, brandHistoryOf, sameOrgTeamIds } from './branding';
export type { BrandEra, BrandOrg } from './branding';
// 羁绊（第十波 #5；只读查询：羁绊图鉴、战队页 / 阵容页的激活羁绊。同步由引擎在阵容变化与每回合自动完成，无玩家操作）
export {
  allSynergies, synergyCatalog, synergyProgress, teamSynergies, synergyBonusText, synergyLockedHint, synergiesOfPlayer,
  SYNERGY_ATTR_LABEL, SYNERGY_KIND_LABEL, SYNERGY_SOURCE_PREFIX,
} from './synergy';
export type { SynergyCatalogEntry, SynergyMemberView, TeamSynergyView } from './synergy';
// 破产（第十波 #1；只读查询，总览「待处理」倒计时 / 结算页使用）
export { bankruptcyStatus, bankruptcyCountdownText, bankruptcyReasonText, bankruptcyRules, debtLimitOf } from './bankruptcy';
export type { BankruptcyStatus } from './bankruptcy';
// 新俱乐部涌现 / 俱乐部使命（第十波 #2 #3；只读查询：DotaPedia 战队页「使命」、成立记录。成立与使命引进由引擎在赛季初 / 转会窗口自动完成，无玩家操作）
export { foundingOf, leagueSize, leagueSizeRange } from './clubs';
export { clubMissionView, MISSION_STATUS_LABEL } from './missions';
export type { ClubMissionView, ClubMissionMember, MissionMemberStatus } from './missions';

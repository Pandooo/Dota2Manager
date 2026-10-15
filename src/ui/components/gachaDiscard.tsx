// 「退回新秀」的确认文案（新秀抽卡页的结果卡片与选手详情共用，两处说法一致）。
import { CONFIG, formatGold, type GachaCardKind } from '../../engine';
import type { ConfirmSpec } from './ConfirmPopover';

/** 窗口事件：让新秀抽卡页把本回合的抽卡结果（「退回」按钮）滚到眼前（底栏「处理超编」在抽卡页上点按时用） */
export const GACHA_FOCUS_EVENT = 'd2m:gacha-focus';

export function gachaDiscardConfirm(opts: { handle: string; refund: number; kind?: GachaCardKind; protoHandle?: string }): ConfirmSpec {
  const ratio = Math.round((Number(CONFIG.gacha.discardRefundRatio) || 0) * 100);
  return {
    title: `退回新秀 ${opts.handle}？`,
    danger: true,
    confirmLabel: '退回',
    cancelLabel: '保留',
    message: (
      <>
        返还 {formatGold(opts.refund)}（单抽价格的 {ratio}%），无解约补偿、不扣荣誉；他将以自由选手身份寻找新东家，其他战队可能签下他。不可撤销。
        {opts.kind === 'real' && <span className="mt-1 block text-gold">这是一名真实新秀，日后往往成长为职业强者。</span>}
        {opts.kind === 'summon' && <span className="mt-1 block text-[#c39cff]">请神新秀：成长走势复制 {opts.protoHandle}。</span>}
      </>
    ),
  };
}

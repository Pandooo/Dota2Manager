// ============================================================================
// 客户端消息校验：形状、类型、长度。只做「格式」校验，业务规则（房主、阶段……）在 rooms.ts。
// ============================================================================
import { REGIONS } from '../src/engine/types';
import type { Region } from '../src/engine/types';
import { RPC_WHITELIST } from '../src/shared/protocol';
import type { ClientMsg, NewClubSpec, RoomSettings } from '../src/shared/protocol';

export const LIMITS = {
  /** 单条消息最大字节数（WebSocket maxPayload） */
  maxPayload: 128 * 1024,
  sessionIdMax: 80,
  playerNameMax: 16,
  roomNameMax: 24,
  clubNameMax: 24,
  chatMax: 300,
  callArgsMax: 8,
  /** 单个 RPC 参数 JSON 的最大长度 */
  callArgsJsonMax: 16 * 1024,
  minPlayers: 2,
  maxPlayers: 6,
} as const;

export type ParseResult = { ok: true; msg: ClientMsg } | { ok: false; error: string };

const RPC_SET: ReadonlySet<string> = new Set<string>(RPC_WHITELIST);
const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
const MODES = ['build', 'existing'] as const;
const SESSION_RE = /^[A-Za-z0-9_.:-]+$/;
/** 座位键（rooms.newSeatKey：base64url） */
const SEAT_KEY_RE = /^[A-Za-z0-9_-]{4,40}$/;
// 控制字符（含零宽/方向控制符）
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 清理显示文本：去控制字符、合并空白、去首尾空白、截断（按码点） */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').replace(CONTROL_RE, '').trim();
  return Array.from(s).slice(0, max).join('');
}

export function isValidSessionId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 6 && v.length <= LIMITS.sessionIdMax && SESSION_RE.test(v);
}

export function normalizeRoomId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const id = v.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(id) ? id : null;
}

/** 新俱乐部信息：返回规范化结果或错误 */
export function parseNewClub(v: unknown): { ok: true; club: NewClubSpec } | { ok: false; error: string } {
  if (!isObj(v)) return { ok: false, error: '俱乐部信息格式错误' };
  const name = cleanText(v.name, 64);
  if (!name) return { ok: false, error: '请填写俱乐部名称' };
  if (Array.from(name).length > LIMITS.clubNameMax) return { ok: false, error: `俱乐部名称最多 ${LIMITS.clubNameMax} 个字` };
  const tag = typeof v.tag === 'string' ? v.tag.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{2,5}$/.test(tag)) return { ok: false, error: '简称需 2–5 个大写字母或数字' };
  if (typeof v.region !== 'string' || !REGIONS.includes(v.region as Region)) return { ok: false, error: '俱乐部赛区无效' };
  const color = typeof v.color === 'string' ? v.color.trim().toLowerCase() : '';
  if (!/^#[0-9a-f]{6}$/.test(color)) return { ok: false, error: '俱乐部主色无效（需为 #rrggbb）' };
  return { ok: true, club: { name, tag, region: v.region as Region, color } };
}

function parseSettings(v: unknown): Partial<RoomSettings> | string {
  if (!isObj(v)) return '房间设置格式错误';
  const out: Partial<RoomSettings> = {};
  if (v.startTi !== undefined) {
    if (!Number.isInteger(v.startTi)) return '起始 TI 无效';
    out.startTi = v.startTi as number;
  }
  if (v.endTi !== undefined) {
    if (!Number.isInteger(v.endTi)) return '终点 TI 无效';
    out.endTi = v.endTi as number;
  }
  if (v.difficulty !== undefined) {
    if (!(DIFFICULTIES as readonly unknown[]).includes(v.difficulty)) return '难度设置无效';
    out.difficulty = v.difficulty as RoomSettings['difficulty'];
  }
  if (v.mode !== undefined) {
    if (!(MODES as readonly unknown[]).includes(v.mode)) return '玩法设置无效';
    out.mode = v.mode as RoomSettings['mode'];
  }
  return out;
}

/** 解析并校验一条客户端消息 */
export function parseClientMsg(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: '消息不是有效的 JSON' };
  }
  if (!isObj(data) || typeof data.t !== 'string') return { ok: false, error: '消息格式错误' };
  const bad = (error: string): ParseResult => ({ ok: false, error });
  switch (data.t) {
    case 'hello': {
      // 房间信息里不含会话 ID（座位用随机座位键识别），座位键当作会话 ID 发来只会得到一个没有座位的新身份
      if (!isValidSessionId(data.sessionId)) return bad('会话 ID 无效');
      if (typeof data.protocol !== 'number') return bad('缺少协议版本');
      return { ok: true, msg: { t: 'hello', sessionId: data.sessionId, name: cleanText(data.name, LIMITS.playerNameMax), protocol: data.protocol } };
    }
    case 'listRooms':
      return { ok: true, msg: { t: 'listRooms' } };
    case 'createRoom': {
      const max = data.maxPlayers === undefined ? 4 : data.maxPlayers;
      if (typeof max !== 'number' || !Number.isFinite(max)) return bad('最大人数无效');
      const maxPlayers = Math.max(LIMITS.minPlayers, Math.min(LIMITS.maxPlayers, Math.round(max)));
      return { ok: true, msg: { t: 'createRoom', name: cleanText(data.name, LIMITS.roomNameMax), maxPlayers } };
    }
    case 'joinRoom': {
      const roomId = normalizeRoomId(data.roomId);
      if (!roomId) return bad('房间码应为 6 位字母或数字');
      return { ok: true, msg: { t: 'joinRoom', roomId } };
    }
    case 'leaveRoom':
      return { ok: true, msg: { t: 'leaveRoom' } };
    case 'updateSettings': {
      const s = parseSettings(data.settings);
      if (typeof s === 'string') return bad(s);
      return { ok: true, msg: { t: 'updateSettings', settings: s } };
    }
    case 'updateSeat': {
      const msg: Extract<ClientMsg, { t: 'updateSeat' }> = { t: 'updateSeat' };
      if (data.name !== undefined) {
        const name = cleanText(data.name, LIMITS.playerNameMax);
        if (!name) return bad('请填写昵称');
        msg.name = name;
      }
      if (data.teamId !== undefined) {
        if (data.teamId !== null && (typeof data.teamId !== 'string' || !data.teamId || data.teamId.length > 80)) return bad('战队无效');
        msg.teamId = data.teamId as string | null;
      }
      if (data.newClub !== undefined) {
        if (data.newClub === null) msg.newClub = null;
        else {
          const c = parseNewClub(data.newClub);
          if (!c.ok) return bad(c.error);
          msg.newClub = c.club;
        }
      }
      return { ok: true, msg };
    }
    case 'setLobbyReady':
      if (typeof data.ready !== 'boolean') return bad('准备状态无效');
      return { ok: true, msg: { t: 'setLobbyReady', ready: data.ready } };
    case 'kick':
      if (typeof data.seatKey !== 'string' || !SEAT_KEY_RE.test(data.seatKey)) return bad('要移出的玩家无效');
      return { ok: true, msg: { t: 'kick', seatKey: data.seatKey } };
    case 'startGame':
      return { ok: true, msg: { t: 'startGame' } };
    case 'call': {
      if (typeof data.reqId !== 'number' || !Number.isFinite(data.reqId)) return bad('reqId 无效');
      if (typeof data.fn !== 'string' || !RPC_SET.has(data.fn)) return bad(`不允许的操作：${String(data.fn).slice(0, 40)}`);
      const args = data.args === undefined ? [] : data.args;
      if (!Array.isArray(args) || args.length > LIMITS.callArgsMax) return bad('操作参数无效');
      if (JSON.stringify(args).length > LIMITS.callArgsJsonMax) return bad('操作参数过大');
      return { ok: true, msg: { t: 'call', reqId: data.reqId, fn: data.fn, args } };
    }
    case 'setRoundReady':
      if (typeof data.ready !== 'boolean') return bad('准备状态无效');
      if (data.auto !== undefined && typeof data.auto !== 'boolean') return bad('自动处理标记无效');
      return { ok: true, msg: data.auto === true ? { t: 'setRoundReady', ready: data.ready, auto: true } : { t: 'setRoundReady', ready: data.ready } };
    case 'setAutopilot':
      if (typeof data.teamId !== 'string' || !data.teamId || data.teamId.length > 80) return bad('要托管的战队无效');
      if (typeof data.on !== 'boolean') return bad('托管状态无效');
      return { ok: true, msg: { t: 'setAutopilot', teamId: data.teamId, on: data.on } };
    case 'chat': {
      const text = typeof data.text === 'string' ? cleanText(data.text, LIMITS.chatMax) : '';
      if (!text) return bad('消息不能为空');
      return { ok: true, msg: { t: 'chat', text } };
    }
    default:
      return bad(`未知的消息类型：${data.t.slice(0, 40)}`);
  }
}

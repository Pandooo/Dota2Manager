// ============================================================================
// 风格化队徽（第十波 #4）：纯函数，不依赖 React（tests/branding.test.ts 直接导入）。
// 真实队标属于商标，不随仓库分发；这里按「简称 + 品牌配色」确定性地生成原创的简单徽章：
// - 外形（盾 / 圆 / 六边形 / 冠盾 / 旗 / 八边形 / 菱形 / 圆角方）与装饰纹（横带 / 斜分 / 人字 / 四分 / 头带）由简称哈希决定；
// - 主色 = 战队品牌主色，辅色 = 品牌数据给出的 color2（无则由主色推导）；首字母取自简称。
// 同一俱乐部同一品牌时期得到同一队徽；换简称 / 换配色（品牌变迁）后自然换成新队徽。
// 坐标系为 32×32 的 viewBox（TeamEmblem.tsx 渲染）。
// ============================================================================

export type EmblemShape = 'shield' | 'round' | 'hex' | 'crest' | 'pennant' | 'octagon' | 'diamond' | 'squircle';
export type EmblemMotif = 'band' | 'diagonal' | 'chevron' | 'quarter' | 'chief' | 'plain';

export interface EmblemSpec {
  shape: EmblemShape;
  /** 外形路径（32×32） */
  outline: string;
  motif: EmblemMotif;
  /** 装饰纹路径（用外形裁剪；plain 为空串） */
  motifPath: string;
  /** 首字母（1–3 个字符） */
  initials: string;
  fontSize: number;
  /** 首字母的垂直中心（不同外形的视觉中心略有不同） */
  textY: number;
  /** 主色 / 辅色 / 描边 / 文字色（#RRGGBB） */
  fill: string;
  fill2: string;
  ring: string;
  text: string;
}

export const EMBLEM_SHAPES: readonly EmblemShape[] = ['shield', 'round', 'hex', 'crest', 'pennant', 'octagon', 'diamond', 'squircle'];
export const EMBLEM_MOTIFS: readonly EmblemMotif[] = ['band', 'diagonal', 'chevron', 'quarter', 'chief', 'plain'];

const OUTLINES: Record<EmblemShape, string> = {
  shield: 'M4 3.5H28V14C28 21.5 22.8 26.6 16 29.5C9.2 26.6 4 21.5 4 14Z',
  round: 'M2.5 16A13.5 13.5 0 1 0 29.5 16A13.5 13.5 0 1 0 2.5 16Z',
  hex: 'M16 2.5L27.7 9.25V22.75L16 29.5L4.3 22.75V9.25Z',
  crest: 'M3.5 6L10 3.5L16 6L22 3.5L28.5 6V15C28.5 22 23 26.8 16 29.5C9 26.8 3.5 22 3.5 15Z',
  pennant: 'M4 3.5H28V22L16 29.5L4 22Z',
  octagon: 'M10.5 2.5H21.5L29.5 10.5V21.5L21.5 29.5H10.5L2.5 21.5V10.5Z',
  diamond: 'M16 1.8L30.2 16L16 30.2L1.8 16Z',
  squircle: 'M9 3H23C27 3 29 5 29 9V23C29 27 27 29 23 29H9C5 29 3 27 3 23V9C3 5 5 3 9 3Z',
};

const MOTIFS: Record<EmblemMotif, string> = {
  band: 'M0 20H32V24.5H0Z',
  diagonal: 'M32 7V32H7Z',
  chevron: 'M0 21L16 27.5L32 21V25.5L16 32L0 25.5Z',
  quarter: 'M16 0H32V16H16ZM0 16H16V32H0Z',
  chief: 'M0 0H32V9H0Z',
  plain: '',
};

/** 外形的视觉中心（首字母的 y） */
const TEXT_Y: Record<EmblemShape, number> = {
  shield: 15, round: 16, hex: 16, crest: 15.5, pennant: 14.5, octagon: 16, diamond: 16, squircle: 16,
};
/** 外形可用宽度系数（菱形 / 六边形内部较窄，字号略小） */
const TEXT_SCALE: Record<EmblemShape, number> = {
  shield: 1, round: 1, hex: 0.92, crest: 1, pennant: 1, octagon: 1, diamond: 0.82, squircle: 1,
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FALLBACK = '#8B96AB';

/** FNV-1a 32 位哈希（确定性） */
export function emblemHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function normHex(c: unknown): string {
  return typeof c === 'string' && HEX_RE.test(c.trim()) ? c.trim().toUpperCase() : FALLBACK;
}

function rgbOf(hex: string): [number, number, number] {
  const h = normHex(hex);
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function toHex([r, g, b]: [number, number, number]): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`.toUpperCase();
}

/** 两色按比例混合（t = 0 → a，t = 1 → b） */
export function mixHex(a: string, b: string, t: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  const k = Math.max(0, Math.min(1, t));
  return toHex([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]);
}

/** 相对亮度（sRGB，0–1） */
export function luminance(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * 简称 → 队徽首字母（1–3 个字符）：
 * - 去掉标点后不超过 3 个字符：原样（全小写时转大写，如 bc → BC；iG / OG / LGD 保持）；
 * - 含分隔符（. 空格 - _ /）：前两段的首字母（PSG.LGD → PL）；
 * - 驼峰（大写字母 ≥ 2 且不全是大写）：前两个大写字母（TSpirit → TS、NaVi → NV）；
 * - 其余：首字母（Liquid → L、NAVI → N）。
 */
export function emblemInitials(tag: string): string {
  const raw = (tag ?? '').trim();
  const clean = raw.replace(/[^\p{L}\p{N}]/gu, '');
  if (!clean) return '?';
  if ([...clean].length <= 3) return clean === clean.toLowerCase() ? clean.toUpperCase() : clean;
  const segs = raw.split(/[.\s\-_/]+/).map((s) => s.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (segs.length >= 2) return (segs[0][0] + segs[1][0]).toUpperCase();
  const caps = [...clean].filter((ch) => /\p{Lu}/u.test(ch));
  if (caps.length >= 2 && caps.length < [...clean].length) return caps.slice(0, 2).join('');
  return [...clean][0].toUpperCase();
}

/** 字号（32×32 坐标系）：1 字 17、2 字 13、3 字 10，再按外形可用宽度缩放 */
function fontSizeFor(initials: string, shape: EmblemShape): number {
  const n = [...initials].length;
  const base = n <= 1 ? 17 : n === 2 ? 13 : 10;
  return Math.round(base * TEXT_SCALE[shape] * 10) / 10;
}

/**
 * 生成队徽规格（确定性：同一简称 + 主色 + 辅色总得到同一结果）。
 * @param tag 战队简称（决定外形、装饰纹与首字母）
 * @param color 品牌主色
 * @param color2 队徽辅色（品牌数据给出时；否则由主色推导：深色主色配亮一档的辅色，浅色主色配暗一档的辅色）
 */
export function emblemSpec(tag: string, color: string, color2?: string | null): EmblemSpec {
  const key = (tag ?? '').trim().toUpperCase() || '?';
  const h = emblemHash(key);
  const shape = EMBLEM_SHAPES[h % EMBLEM_SHAPES.length];
  const motif = EMBLEM_MOTIFS[(h >>> 8) % EMBLEM_MOTIFS.length];
  const fill = normHex(color);
  const lum = luminance(fill);
  const fill2 = color2 && HEX_RE.test(color2) ? normHex(color2) : lum > 0.45 ? mixHex(fill, '#000000', 0.5) : mixHex(fill, '#FFFFFF', 0.4);
  // 描边：深色主色用亮描边（暗色界面上仍看得清轮廓），其余用加深的主色
  const ring = lum < 0.08 ? mixHex(fill, '#FFFFFF', 0.55) : mixHex(fill, '#000000', 0.42);
  const text = lum > 0.5 ? '#111317' : '#FFFFFF';
  const initials = emblemInitials(tag);
  return {
    shape,
    outline: OUTLINES[shape],
    motif,
    motifPath: MOTIFS[motif],
    initials,
    fontSize: fontSizeFor(initials, shape),
    textY: TEXT_Y[shape],
    fill,
    fill2,
    ring,
    text,
  };
}

/** 本地覆盖文件的键：战队 id（小写）或「战队 id.简称」（简称去掉非字母数字并小写，如 lgd-gaming.psglgd） */
export function localLogoKeys(teamId: string | null | undefined, tag?: string | null): string[] {
  const id = (teamId ?? '').trim().toLowerCase();
  if (!id) return [];
  const t = (tag ?? '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  return t ? [`${id}.${t}`, id] : [id];
}

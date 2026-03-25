/**
 * Unicode character width lookup.
 * Returns 0 (combining/control), 1 (normal), or 2 (wide/CJK/emoji).
 */

// [start, end] inclusive ranges that are width-2
const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f],   // Hangul Jamo
  [0x2329, 0x232a],   // CJK brackets
  [0x2e80, 0x303e],   // CJK Radicals through CJK Symbols
  [0x3041, 0x33bf],   // Hiragana through CJK Compatibility
  [0x3400, 0x4dbf],   // CJK Ext A
  [0x4e00, 0x9fff],   // CJK Unified
  [0xa000, 0xa4cf],   // Yi
  [0xa960, 0xa97f],   // Hangul Jamo Ext-A
  [0xac00, 0xd7ff],   // Hangul Syllables
  [0xf900, 0xfaff],   // CJK Compatibility Ideographs
  [0xfe10, 0xfe1f],   // Vertical Forms
  [0xfe30, 0xfe4f],   // CJK Compatibility Forms
  [0xff01, 0xff60],   // Fullwidth Latin/punctuation
  [0xffe0, 0xffe6],   // Fullwidth Signs
  [0x1b000, 0x1b12f], // Kana Supplement
  [0x1f004, 0x1f0cf], // Playing cards, mahjong
  [0x1f300, 0x1f9ff], // Misc symbols, emoji
  [0x1fa00, 0x1faff], // Chess, additional emoji
  [0x20000, 0x2fffd], // CJK Ext B–F
  [0x30000, 0x3fffd], // CJK Ext G+
];

// [start, end] inclusive ranges that are width-0 (combining, control, zero-width)
const ZERO_RANGES: [number, number][] = [
  [0x0000, 0x001f],   // C0 controls
  [0x007f, 0x009f],   // DEL + C1 controls
  [0x0300, 0x036f],   // Combining Diacritical Marks
  [0x0483, 0x0489],   // Combining marks
  [0x0591, 0x05bd],   // Hebrew combining
  [0x0610, 0x061a],   // Arabic combining
  [0x064b, 0x065f],   // Arabic combining
  [0x1ab0, 0x1aff],   // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff],   // Combining Diacritical Marks Supplement
  [0x200b, 0x200f],   // Zero-width chars (ZWSP, ZWNJ, ZWJ, LRM, RLM)
  [0x2028, 0x202e],   // Line/paragraph separators, directional formatting
  [0x20d0, 0x20ff],   // Combining Diacritical Marks for Symbols
  [0xfe00, 0xfe0f],   // Variation Selectors
  [0xfeff, 0xfeff],   // BOM / ZWNBSP
  [0xfff9, 0xfffb],   // Interlinear annotations
];

function inRanges(cp: number, ranges: [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [start, end] = ranges[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

export function charWidth(codePoint: number): 0 | 1 | 2 {
  // Fast path: printable ASCII is always width 1 (covers ~95% of terminal output)
  if (codePoint >= 0x20 && codePoint < 0x7f) return 1;
  if (inRanges(codePoint, ZERO_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

export function stringWidth(s: string): number {
  let width = 0;
  // for...of iterates codepoints, handling surrogate pairs automatically
  for (const char of s) {
    width += charWidth(char.codePointAt(0)!);
  }
  return width;
}

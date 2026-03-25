import { describe, it, expect } from 'vitest';
import { charWidth, stringWidth } from '../../simulator/CharWidth.js';

describe('charWidth', () => {
  it('ASCII printable = 1', () => {
    expect(charWidth(0x41)).toBe(1); // 'A'
    expect(charWidth(0x7e)).toBe(1); // '~'
    expect(charWidth(0x20)).toBe(1); // ' '
  });

  it('control chars = 0', () => {
    expect(charWidth(0x00)).toBe(0); // NUL
    expect(charWidth(0x1b)).toBe(0); // ESC
    expect(charWidth(0x7f)).toBe(0); // DEL
  });

  it('CJK Unified Ideographs = 2', () => {
    expect(charWidth(0x4e00)).toBe(2); // first CJK
    expect(charWidth(0x9fff)).toBe(2); // last CJK Unified
    expect(charWidth(0x5c71)).toBe(2); // 山
  });

  it('CJK Ext A = 2', () => {
    expect(charWidth(0x3400)).toBe(2);
    expect(charWidth(0x4dbf)).toBe(2);
  });

  it('Hangul Syllables = 2', () => {
    expect(charWidth(0xac00)).toBe(2); // 가
    expect(charWidth(0xd7a3)).toBe(2);
  });

  it('fullwidth Latin = 2', () => {
    expect(charWidth(0xff01)).toBe(2); // ！
    expect(charWidth(0xff60)).toBe(2);
  });

  it('combining diacritical marks = 0', () => {
    expect(charWidth(0x0300)).toBe(0); // combining grave accent
    expect(charWidth(0x036f)).toBe(0);
  });

  it('zero-width chars = 0', () => {
    expect(charWidth(0x200b)).toBe(0); // ZWSP
    expect(charWidth(0xfeff)).toBe(0); // BOM/ZWNBSP
  });

  it('emoji in wide range = 2', () => {
    expect(charWidth(0x1f600)).toBe(2); // 😀
    expect(charWidth(0x1f4e7)).toBe(2); // 📧
  });
});

describe('stringWidth', () => {
  it('ASCII string', () => {
    expect(stringWidth('Hello')).toBe(5);
  });

  it('CJK string', () => {
    expect(stringWidth('\u4e00\u4e01')).toBe(4); // 2 CJK × 2 cols each
  });

  it('mixed ASCII + CJK', () => {
    expect(stringWidth('A\u4e00B')).toBe(4); // 1 + 2 + 1
  });

  it('surrogate pair emoji', () => {
    const emoji = '\uD83D\uDE00'; // U+1F600 = 2 cols
    expect(stringWidth(emoji)).toBe(2);
  });

  it('empty string', () => {
    expect(stringWidth('')).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { parseAnsi } from '../../simulator/AnsiParser.js';

describe('AnsiParser', () => {
  it('plain ASCII produces print events', () => {
    const events = parseAnsi('Hello');
    expect(events).toHaveLength(5);
    expect(events.every(e => e.type === 'print')).toBe(true);
    expect(events.map(e => (e as { type: 'print'; char: string }).char).join('')).toBe('Hello');
  });

  it('\\r → cr event', () => {
    const events = parseAnsi('\r');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('cr');
  });

  it('\\n → lf event', () => {
    const events = parseAnsi('\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('lf');
  });

  it('\\t → tab event', () => {
    const events = parseAnsi('\t');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tab');
  });

  it('SGR \\x1b[31m produces csi event with cmd=m, no print', () => {
    const events = parseAnsi('\x1b[31m');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('csi');
    const csi = events[0] as { type: 'csi'; cmd: string; params: number[]; priv: boolean };
    expect(csi.cmd).toBe('m');
    expect(csi.params).toEqual([31]);
  });

  it('cursor position \\x1b[5;3H → csi cmd=H, params=[5,3]', () => {
    const events = parseAnsi('\x1b[5;3H');
    expect(events).toHaveLength(1);
    const csi = events[0] as { type: 'csi'; cmd: string; params: number[]; priv: boolean };
    expect(csi.cmd).toBe('H');
    expect(csi.params).toEqual([5, 3]);
  });

  it('\\x1b[?25h (private CSI) produces csi event with priv=true', () => {
    const events = parseAnsi('\x1b[?25h');
    expect(events).toHaveLength(1);
    const csi = events[0] as { type: 'csi'; cmd: string; params: number[]; priv: boolean };
    expect(csi.priv).toBe(true);
    expect(csi.cmd).toBe('h');
  });

  it('OSC sequence is consumed without print events', () => {
    // OSC with BEL terminator
    const events = parseAnsi('\x1b]0;title\x07');
    expect(events.filter(e => e.type === 'print')).toHaveLength(0);
  });

  it('OSC sequence with ST terminator (ESC \\)', () => {
    const events = parseAnsi('\x1b]2;my title\x1b\\');
    expect(events.filter(e => e.type === 'print')).toHaveLength(0);
  });

  it('mixed: ANSI between printable chars — only visible chars produce print events', () => {
    const events = parseAnsi('A\x1b[31mB\x1b[0mC');
    const prints = events.filter(e => e.type === 'print');
    expect(prints).toHaveLength(3);
    expect(prints.map(e => (e as { type: 'print'; char: string }).char).join('')).toBe('ABC');
  });

  it('surrogate pair emoji produces single print event', () => {
    const emoji = '\uD83D\uDE00'; // U+1F600
    const events = parseAnsi(emoji);
    const prints = events.filter(e => e.type === 'print');
    expect(prints).toHaveLength(1);
    expect((prints[0] as { type: 'print'; char: string }).char).toBe(emoji);
  });

  it('cursor up/down/left/right CSI', () => {
    const cases = [
      { input: '\x1b[3A', cmd: 'A', params: [3] },
      { input: '\x1b[2B', cmd: 'B', params: [2] },
      { input: '\x1b[5C', cmd: 'C', params: [5] },
      { input: '\x1b[1D', cmd: 'D', params: [1] },
    ];
    for (const { input, cmd, params } of cases) {
      const events = parseAnsi(input);
      expect(events).toHaveLength(1);
      const csi = events[0] as { type: 'csi'; cmd: string; params: number[] };
      expect(csi.cmd).toBe(cmd);
      expect(csi.params).toEqual(params);
    }
  });
});

/**
 * VirtualTerminal keeps a packet's result only while the packet still owns a live row.
 *
 * Before: one `PacketSimResult` per chunk for the life of the terminal view (a `\r` spinner
 * grew the map one entry per frame while the screen stayed one row). The only live reader,
 * `getRowDataRange`, asks for the timestamp of a live row's OWNER, so a result whose rows were
 * all overwritten or scrolled off is dead weight. Drives the real `VirtualTerminal` with the
 * chunks `PtySyncSession.processChunk` would hand it.
 */

import { VirtualTerminal } from '@sdk/pty-sync/simulator/VirtualTerminal';
import type { OutputChunk } from '@sdk/pty-sync/types';
import { describe, expect, it } from 'vitest';

const enc = new TextEncoder();
const T0 = 1_700_000_000_000;

function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: enc.encode(text), timestamp: T0 + seq };
}

function makeVt(cols = 80, rows = 24, scrollbackLines = 100): VirtualTerminal {
  return new VirtualTerminal({ cols, rows, cellWidth: 7, cellHeight: 14, scrollbackLines, seed: 0 });
}

const retained = (vt: VirtualTerminal) => vt.getReport().packetResults.length;

/** Every live row with an owner must still resolve that owner's timestamp. */
function assertOwnersResolvable(vt: VirtualTerminal): void {
  const off = vt.getTotalScrolledOff();
  const rows = vt.getRowDataRange(off, vt.getReport().virtualBuffer.length);
  for (const r of rows) {
    if (r.ownerSeq !== null) expect(r.timestamp).toBe(T0 + r.ownerSeq);
  }
}

describe('VirtualTerminal packet results are bounded by live rows', () => {
  it('a \\r spinner holds one result after 5,000 frames', () => {
    const vt = makeVt();
    for (let seq = 1; seq <= 5000; seq++) {
      vt.processChunk(chunk(seq, `\r[${seq % 60}] spin ${String(seq).padStart(6, '0')} \x1b[K`));
    }
    expect(retained(vt)).toBe(1);
    expect(vt.getRowDataRange(0, 1)[0]).toMatchObject({ ownerSeq: 5000, timestamp: T0 + 5000 });
    assertOwnersResolvable(vt);
  });

  it('line output never exceeds rows + scrollbackLines once the buffer is full', () => {
    const vt = makeVt(80, 10, 50);
    const bound = 10 + 50;
    for (let seq = 1; seq <= 2000; seq++) {
      vt.processChunk(chunk(seq, `line ${seq}\r\n`));
      expect(retained(vt)).toBeLessThanOrEqual(bound);
    }
    expect(retained(vt)).toBe(bound - 1); // every buffer row but the cursor's empty one has an owner
    expect(vt.getTotalScrolledOff()).toBe(2000 + 1 - bound);
    assertOwnersResolvable(vt);
  });

  it('a repainted status block over a log stream tracks the live rows, not the frames', () => {
    const vt = makeVt(80, 24, 100);
    let seq = 0;
    for (let frame = 1; frame <= 3000; frame++) {
      if (frame % 20 === 0) vt.processChunk(chunk(++seq, `log line ${frame}\r\n`));
      // 5-row block repainted in place: cursor up 4, then 5 lines.
      const block = ['\x1b[4A', 'row a', '\r\n', 'row b', '\r\n', 'row c', '\r\n', 'row d', '\r\n', `row e ${frame}`].join('');
      vt.processChunk(chunk(++seq, block));
    }
    const live = vt.getReport().virtualBuffer.filter((r) => r.ownerSeq !== null).length;
    expect(retained(vt)).toBeLessThanOrEqual(live);
    expect(retained(vt)).toBeLessThan(seq / 10);
    assertOwnersResolvable(vt);
  });

  it('wide chars at the right edge, tab wraps and CSI H jumps keep every live owner resolvable', () => {
    const vt = makeVt(10, 5, 20);
    let seq = 0;
    vt.processChunk(chunk(++seq, '日本語日本語日本'));      // 16 cells on a 10-col row → wraps
    vt.processChunk(chunk(++seq, 'a\tb\tc\td\r\n'));       // tab past the edge wraps
    vt.processChunk(chunk(++seq, '\x1b[1;1Hover'));        // jump home, overwrite row 0's owner
    vt.processChunk(chunk(++seq, '\x1b[2;3Hxx'));          // partial overwrite of the wrapped row
    for (let i = 0; i < 40; i++) vt.processChunk(chunk(++seq, `l${i}\r\n`)); // scroll it all off
    assertOwnersResolvable(vt);
    const live = vt.getReport().virtualBuffer.filter((r) => r.ownerSeq !== null).length;
    expect(retained(vt)).toBeLessThanOrEqual(live);
  });
});

describe('VirtualTerminal.padTop anchors a windowed replay under rows it never saw', () => {
  it('shifts live rows, their records and the cursor by n; padded rows carry no owner', () => {
    const vt = makeVt(80, 24, 100);
    vt.processChunk(chunk(1, 'first\r\n'));
    vt.processChunk(chunk(2, 'second'));
    expect(vt.getCursorRow()).toBe(1);

    vt.padTop(7);

    expect(vt.getCursorRow()).toBe(8);
    expect(vt.getTotalScrolledOff()).toBe(0);
    const rows = vt.getRowDataRange(0, 9);
    for (let i = 0; i < 7; i++) expect(rows[i]).toMatchObject({ ownerSeq: null, timestamp: null });
    expect(rows[7]).toMatchObject({ ownerSeq: 1, timestamp: T0 + 1 });
    expect(rows[8]).toMatchObject({ ownerSeq: 2, timestamp: T0 + 2 });
    // The live index moved with the rows: overwriting row 8 releases packet 2.
    vt.processChunk(chunk(3, '\rthird'));
    expect(vt.getRowDataRange(8, 1)[0]).toMatchObject({ ownerSeq: 3, timestamp: T0 + 3 });
    expect(retained(vt)).toBe(2);
    assertOwnersResolvable(vt);
  });

  it('a pad past the buffer bound counts as scrolled off instead of growing the buffer', () => {
    const vt = makeVt(80, 5, 10); // 15-row buffer
    vt.processChunk(chunk(1, 'x'));
    vt.padTop(100);
    expect(vt.getCursorRow()).toBe(100);
    expect(vt.getReport().virtualBuffer.length).toBe(15);
    expect(vt.getTotalScrolledOff()).toBe(100 - 14);
    expect(vt.getRowDataRange(100, 1)[0]).toMatchObject({ ownerSeq: 1, timestamp: T0 + 1 });
    expect(vt.getRowDataRange(0, 1)[0]).toMatchObject({ ownerSeq: null, timestamp: null });
  });

  it('is a no-op for n <= 0', () => {
    const vt = makeVt();
    vt.processChunk(chunk(1, 'x'));
    vt.padTop(0);
    vt.padTop(-3);
    expect(vt.getCursorRow()).toBe(0);
    expect(vt.getRowDataRange(0, 1)[0]).toMatchObject({ ownerSeq: 1 });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { crLfify, writeToXterm } from '../../adapter/writeToXterm.js';

describe('crLfify', () => {
  it('returns same reference when no bare LFs (no allocation)', () => {
    const data = new Uint8Array([0x41, 0x0d, 0x0a, 0x42]); // A\r\nB — already normalised
    expect(crLfify(data)).toBe(data);
  });

  it('returns same reference for data with no newlines at all', () => {
    const data = new Uint8Array([0x41, 0x42, 0x43]); // ABC
    expect(crLfify(data)).toBe(data);
  });

  it('inserts CR before bare LF at start of buffer', () => {
    expect(crLfify(new Uint8Array([0x0a]))).toEqual(new Uint8Array([0x0d, 0x0a]));
  });

  it('inserts CR before bare LF in the middle', () => {
    const data = new Uint8Array([0x41, 0x0a, 0x42]); // A\nB
    expect(crLfify(data)).toEqual(new Uint8Array([0x41, 0x0d, 0x0a, 0x42]));
  });

  it('handles multiple bare LFs', () => {
    expect(crLfify(new Uint8Array([0x0a, 0x0a]))).toEqual(
      new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]),
    );
  });

  it('fixes bare LF immediately after an existing CR+LF sequence', () => {
    // \r\n\n  →  \r\n\r\n  (second \n is bare because it follows \n not \r)
    expect(crLfify(new Uint8Array([0x0d, 0x0a, 0x0a]))).toEqual(
      new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]),
    );
  });
});

describe('writeToXterm', () => {
  it('writes crLfified data to term and resolves', async () => {
    const written: Uint8Array[] = [];
    const fakeTerm = {
      write: vi.fn((data: Uint8Array, cb: () => void) => { written.push(data); cb(); }),
    };
    await writeToXterm(fakeTerm as any, new Uint8Array([0x41, 0x0a, 0x42]));
    expect(written[0]).toEqual(new Uint8Array([0x41, 0x0d, 0x0a, 0x42]));
  });

  it('does not resolve until the write callback fires', async () => {
    let fireCallback!: () => void;
    const fakeTerm = { write: vi.fn((_d: Uint8Array, cb: () => void) => { fireCallback = cb; }) };
    let settled = false;
    const p = writeToXterm(fakeTerm as any, new Uint8Array([0x41])).then(() => { settled = true; });
    expect(settled).toBe(false);
    fireCallback();
    await p;
    expect(settled).toBe(true);
  });
});

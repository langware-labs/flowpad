import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PtySyncSession } from '../../PtySyncSession.js';
import type { OutputChunk } from '../../types.js';

// Helper: create a text chunk
function chunk(seq: number, text: string): OutputChunk {
  return { seq, data: new TextEncoder().encode(text), timestamp: seq * 1000 };
}

// Mock Terminal (minimal interface needed by LiveXtermAdapter)
function createMockTerminal(cols = 80, rows = 24) {
  return {
    cols,
    rows,
    buffer: {
      active: {
        baseY: 0,
        viewportY: 0,
        cursorX: 0,
        cursorY: 0,
        length: rows,
        getLine: () => null,
      },
    },
    element: {
      clientWidth: cols * 7,
      clientHeight: rows * 14,
    },
    scrollLines: vi.fn(),
  } as any;
}

describe('PtySyncSession', () => {
  let session: PtySyncSession;

  beforeEach(() => {
    session = new PtySyncSession();
  });

  describe('initial state', () => {
    it('snapshot has null adapter, null vt, version 0', () => {
      const snap = session.getSnapshot();
      expect(snap.adapter).toBeNull();
      expect(snap.vt).toBeNull();
      expect(snap.version).toBe(0);
    });
  });

  describe('initialize()', () => {
    it('creates adapter and VT, bumps version', () => {
      const term = createMockTerminal();
      session.initialize(term);
      const snap = session.getSnapshot();
      expect(snap.adapter).not.toBeNull();
      expect(snap.vt).not.toBeNull();
      expect(snap.version).toBeGreaterThan(0);
    });
  });

  describe('dispose()', () => {
    it('nulls adapter and VT, bumps version', () => {
      session.initialize(createMockTerminal());
      const v1 = session.getSnapshot().version;
      session.dispose();
      const snap = session.getSnapshot();
      expect(snap.adapter).toBeNull();
      expect(snap.vt).toBeNull();
      expect(snap.version).toBeGreaterThan(v1);
    });
  });

  describe('processChunk()', () => {
    it('bumps version on each chunk', () => {
      session.initialize(createMockTerminal());
      const v0 = session.getSnapshot().version;
      session.processChunk(chunk(1, 'a'));
      expect(session.getSnapshot().version).toBeGreaterThan(v0);
    });

    it('is a no-op when VT is null', () => {
      // Before initialize — no VT
      const v0 = session.getSnapshot().version;
      session.processChunk(chunk(1, 'a'));
      // processChunk returns early, version unchanged
      expect(session.getSnapshot().version).toBe(v0);
    });

    it('updates adapter eviction offset after processing', () => {
      const smallSession = new PtySyncSession({ scrollbackLines: 5 });
      smallSession.initialize(createMockTerminal(80, 3));
      // Feed 15 lines: 3 rows + 5 scrollback = 8 max, so some should scroll off
      for (let i = 1; i <= 15; i++) {
        smallSession.processChunk(chunk(i, `line ${i}\n`));
      }
      const snap = smallSession.getSnapshot();
      expect(snap.adapter!.getEvictionOffset()).toBeGreaterThan(0);
    });
  });

  describe('rebuild()', () => {
    it('replays all chunks and bumps version', () => {
      session.initialize(createMockTerminal());
      const chunks = [chunk(1, 'line 1\n'), chunk(2, 'line 2\n'), chunk(3, 'line 3\n')];
      for (const c of chunks) session.processChunk(c);

      const vBefore = session.getSnapshot().version;
      session.rebuild(chunks);
      const snap = session.getSnapshot();

      expect(snap.version).toBeGreaterThan(vBefore);
      expect(snap.adapter).not.toBeNull();
      expect(snap.vt).not.toBeNull();
    });

    it('is a no-op when adapter is null', () => {
      const v0 = session.getSnapshot().version;
      session.rebuild([chunk(1, 'a')]);
      expect(session.getSnapshot().version).toBe(v0);
    });
  });

  describe('resetSession()', () => {
    it('nulls VT, bumps version', () => {
      session.initialize(createMockTerminal());
      session.processChunk(chunk(1, 'hello\n'));
      session.resetSession();
      const snap = session.getSnapshot();
      expect(snap.vt).toBeNull();
    });
  });

  describe('subscribe/getSnapshot contract', () => {
    it('notifies listeners on bump', () => {
      const listener = vi.fn();
      session.subscribe(listener);
      session.initialize(createMockTerminal());
      expect(listener).toHaveBeenCalled();
    });

    it('unsubscribe stops notifications', () => {
      const listener = vi.fn();
      const unsub = session.subscribe(listener);
      unsub();
      session.initialize(createMockTerminal());
      expect(listener).not.toHaveBeenCalled();
    });

    it('snapshot is referentially stable between bumps', () => {
      session.initialize(createMockTerminal());
      const snap1 = session.getSnapshot();
      const snap2 = session.getSnapshot();
      expect(snap1).toBe(snap2); // same object reference
    });

    it('snapshot changes reference after bump', () => {
      session.initialize(createMockTerminal());
      const snap1 = session.getSnapshot();
      session.processChunk(chunk(1, 'a'));
      const snap2 = session.getSnapshot();
      expect(snap1).not.toBe(snap2); // different object
    });
  });

  describe('config', () => {
    it('accepts custom scrollbackLines', () => {
      const s = new PtySyncSession({ scrollbackLines: 500 });
      s.initialize(createMockTerminal());
      expect(s.getSnapshot().vt).not.toBeNull();
    });
  });
});

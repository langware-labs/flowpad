import type { PtyConnection } from './ptyConnection';

export interface OrphanEntry {
  data: string;
  seq?: number;
  timestamp: number; // local time (ms) for eviction; not the server-side PTY timestamp
  timestamp_ms?: number; // server-side Unix epoch ms when the chunk was captured
}

const MAX_CHUNKS_PER_SESSION = 200;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_AGE_MS = 30000; // 30s

const buffers = new Map<string, OrphanEntry[]>();
let totalBytes = 0;

function evict(): void {
  const now = Date.now();
  for (const [shellId, entries] of buffers.entries()) {
    // Remove expired entries
    const fresh = entries.filter(e => now - e.timestamp < MAX_AGE_MS);
    if (fresh.length !== entries.length) {
      const removed = entries.length - fresh.length;
      totalBytes -= entries.slice(0, removed).reduce((s, e) => s + e.data.length, 0);
      buffers.set(shellId, fresh);
    }
    if (fresh.length === 0) buffers.delete(shellId);
  }
  // If still over total, evict oldest globally
  while (totalBytes > MAX_TOTAL_BYTES) {
    const first = buffers.entries().next();
    if (first.done) break;
    const [sid, ents] = first.value;
    if (ents.length === 0) { buffers.delete(sid); continue; }
    const removed = ents.shift()!;
    totalBytes -= removed.data.length;
    if (ents.length === 0) buffers.delete(sid);
  }
}

export const ptyOrphanBuffer = {
  buffer(shellId: string, data: string, seq?: number, timestamp_ms?: number): void {
    evict();
    if (!buffers.has(shellId)) buffers.set(shellId, []);
    const entries = buffers.get(shellId)!;
    if (entries.length >= MAX_CHUNKS_PER_SESSION) {
      const removed = entries.shift()!;
      totalBytes -= removed.data.length;
    }
    entries.push({ data, seq, timestamp: Date.now(), timestamp_ms });
    totalBytes += data.length;
  },

  flush(shellId: string, ptyConn: PtyConnection): void {
    const entries = buffers.get(shellId);
    if (!entries || entries.length === 0) return;
    totalBytes -= entries.reduce((s, e) => s + e.data.length, 0);
    buffers.delete(shellId);
    ptyConn.flush(entries);
  },

  clear(): void {
    buffers.clear();
    totalBytes = 0;
  },
};

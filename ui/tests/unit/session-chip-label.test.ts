import { describe, expect, it } from 'vitest';
import { sessionChipLabel } from '@src/hooks/useRemoteWorkerSessionForConversation';

describe('sessionChipLabel', () => {
  it('renders "<Host>\'s session" from a host name', () => {
    expect(sessionChipLabel({ hostName: 'Alice' })).toBe("Alice's session");
  });

  it('trims whitespace around the host name', () => {
    expect(sessionChipLabel({ hostName: '  Bob  ' })).toBe("Bob's session");
  });

  it('falls back to "Worker\'s session" when host is missing/empty', () => {
    expect(sessionChipLabel({ hostName: null })).toBe("Worker's session");
    expect(sessionChipLabel({ hostName: '   ' })).toBe("Worker's session");
    expect(sessionChipLabel({})).toBe("Worker's session");
  });

  it('never uses the word "room"', () => {
    expect(sessionChipLabel({ hostName: 'Carol' }).toLowerCase()).not.toContain('room');
  });
});

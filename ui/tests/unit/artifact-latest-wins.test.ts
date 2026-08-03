/**
 * "The latest artifact" has to be well-defined, because it is what the display
 * focuses after a registration. Rows arrive from a watched query in whatever
 * order the backend returned them, and a re-fetch REPLACES the array — so the
 * selector must be a pure function of the list it is handed, holding no memory
 * of a previous winner that a stale row could re-crown.
 *
 * Ties are real: two registrations inside the same clock tick share a
 * `created_date`. An unstable tie-break makes the focused artifact flicker
 * between renders, so it is pinned here rather than left to sort chance.
 */
import { describe, expect, it } from 'vitest';
import { Artifact } from '@sdk';
import { latestArtifact } from '@src/hooks/use-process-artifacts';

const at = (name: string, created: string, id: string) =>
  new Artifact({ id, name, kind: 'content.file', created_date: created } as never);

describe('latestArtifact', () => {
  it('is null for an empty list', () => {
    expect(latestArtifact([])).toBeNull();
    expect(latestArtifact(undefined as never)).toBeNull();
  });

  it('picks the newest by created_date regardless of arrival order', () => {
    const older = at('older', '2026-08-01T10:00:00Z', '11111111-0000-4000-8000-000000000001');
    const newer = at('newer', '2026-08-01T10:05:00Z', '22222222-0000-4000-8000-000000000002');

    expect(latestArtifact([older, newer])?.name).toBe('newer');
    expect(latestArtifact([newer, older])?.name).toBe('newer');
  });

  it('an older artifact never clobbers the newer one', () => {
    const newer = at('newer', '2026-08-01T10:05:00Z', '22222222-0000-4000-8000-000000000002');
    const stale = at('stale', '2026-08-01T09:00:00Z', '33333333-0000-4000-8000-000000000003');

    // The list is replaced wholesale on every re-fetch; a late-arriving stale
    // row is just another element, not a state transition.
    expect(latestArtifact([newer, stale, newer])?.name).toBe('newer');
  });

  it('breaks a same-timestamp tie deterministically, whatever the input order', () => {
    const t = '2026-08-01T10:00:00Z';
    const a = at('a', t, '11111111-0000-4000-8000-000000000001');
    const b = at('b', t, '22222222-0000-4000-8000-000000000002');

    expect(latestArtifact([a, b])?.id).toBe(latestArtifact([b, a])?.id);
  });

  it('does not mutate or reorder the list it was given', () => {
    const older = at('older', '2026-08-01T10:00:00Z', '11111111-0000-4000-8000-000000000001');
    const newer = at('newer', '2026-08-01T10:05:00Z', '22222222-0000-4000-8000-000000000002');
    const list = [newer, older];

    latestArtifact(list);

    expect(list.map((x) => x.name)).toEqual(['newer', 'older']);
  });

  it('tolerates a missing created_date rather than crowning it by NaN', () => {
    const dated = at('dated', '2026-08-01T10:00:00Z', '11111111-0000-4000-8000-000000000001');
    const undatedRow = new Artifact({
      id: '22222222-0000-4000-8000-000000000002',
      name: 'undated',
      kind: 'content.file',
    } as never);

    expect(latestArtifact([dated, undatedRow])?.name).toBe('dated');
    expect(latestArtifact([undatedRow, dated])?.name).toBe('dated');
  });
});

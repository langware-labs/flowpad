/**
 * Who gets offered "sign this sandbox out".
 *
 * A box holds exactly ONE cloud session, so the action is only ever meaningful
 * about that one user. Offering it while the box is signed in as someone else
 * would read as a way to evict them — which it is not, and which would 403
 * anyway, since `ops` is owner-only on compute_node.
 *
 * Pure: the rule is a comparison, and every way it can go wrong is a comparison
 * going wrong. The button's wiring is covered by the card test.
 */
import { describe, expect, it } from 'vitest';
import { isSignedInAsMe } from '@src/pages/hub-home/HubHome';

describe('isSignedInAsMe', () => {
  it('matches the viewer regardless of casing or padding', () => {
    // `logged_in_user` is whatever the box's provider record carried, so its
    // shape is not ours to assume — only its meaning.
    expect(isSignedInAsMe({ logged_in_user: 'bob@local.test' }, 'bob@local.test')).toBe(true);
    expect(isSignedInAsMe({ logged_in_user: 'Bob@Local.Test' }, 'bob@local.test')).toBe(true);
    expect(isSignedInAsMe({ logged_in_user: '  bob@local.test ' }, 'BOB@local.test')).toBe(true);
  });

  it('does not offer the button for someone else’s session', () => {
    expect(isSignedInAsMe({ logged_in_user: 'alice@local.test' }, 'bob@local.test')).toBe(false);
  });

  it('treats two unknowns as a non-match, never as a match', () => {
    // The failure this guards: `'' === ''` is true. Without the presence check a
    // signed-out viewer would be offered the button on every signed-out box —
    // the exact case where it is most obviously wrong.
    expect(isSignedInAsMe({ logged_in_user: null }, null)).toBe(false);
    expect(isSignedInAsMe({ logged_in_user: '' }, '')).toBe(false);
    expect(isSignedInAsMe({}, undefined)).toBe(false);
    expect(isSignedInAsMe({ logged_in_user: '   ' }, '   ')).toBe(false);
  });

  it('needs BOTH sides — a known box and a known viewer', () => {
    expect(isSignedInAsMe({ logged_in_user: 'bob@local.test' }, null)).toBe(false);
    expect(isSignedInAsMe({ logged_in_user: null }, 'bob@local.test')).toBe(false);
  });
});

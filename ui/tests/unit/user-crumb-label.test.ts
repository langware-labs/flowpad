/**
 * The user crumb's name: one human, one name, on every page.
 *
 * A desktop signed in to a hub holds TWO `user` rows for the same person — the
 * local desktop row (named from the machine, e.g. "serans1") and the hub row the
 * cloud login returned ("Eran Shlomo"). The crumb used to name the local row, so
 * `/dock/hub/home` greeted "Hey Eran" while `/dock/hub/stream_inbox` addressed
 * `serans1 › Stream Inbox` — two identities in one session.
 */
import { describe, it, expect } from 'vitest';
import { userCrumbLabel } from '@src/components/top-nav-bar/user-crumb-label';

// The real rows from the reproduction: `GET /api/v1/graph/user` on the desktop
// (uname `local`, name `serans1`) and `GET /api/v1/cloud/status`'s hub user.
const LOCAL = { name: 'serans1' };
const HUB = { name: 'Eran Shlomo' };

describe('userCrumbLabel', () => {
  it('names the hub identity while signed in, not the local desktop row', () => {
    expect(userCrumbLabel(HUB, LOCAL)).toBe('Eran Shlomo');
  });

  it('falls back to the local row when there is no cloud login', () => {
    expect(userCrumbLabel(null, LOCAL)).toBe('serans1');
  });

  it('falls back to the local row when the cloud row has no name yet', () => {
    expect(userCrumbLabel({ name: null }, LOCAL)).toBe('serans1');
    expect(userCrumbLabel({ name: '   ' }, LOCAL)).toBe('serans1');
  });

  it('is null when neither row has a name, so the caller can use the type label', () => {
    expect(userCrumbLabel(null, null)).toBe(null);
    expect(userCrumbLabel({ name: '' }, { name: null })).toBe(null);
  });

  it('trims, so a padded name never renders as whitespace', () => {
    expect(userCrumbLabel({ name: '  Eran Shlomo  ' }, LOCAL)).toBe('Eran Shlomo');
  });
});

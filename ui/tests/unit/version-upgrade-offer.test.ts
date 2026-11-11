import { describe, expect, it } from 'vitest';
import { upgradeOfferVersion } from '@src/components/version-popover/upgrade-offer';

// The popover's "Upgrade to vX" names, and installs, the release the desktop can run — not PyPI's newest.
describe('upgradeOfferVersion', () => {
  it('desktop: the newest release this desktop runs, even when PyPI has a newer one', () => {
    expect(upgradeOfferVersion({ desktop: true, desktopTarget: '0.2.181', pypiLatest: '0.2.190' })).toBe('0.2.181');
  });
  it('desktop: nothing newer runs here — no offer', () => {
    expect(upgradeOfferVersion({ desktop: true, desktopTarget: false, pypiLatest: '0.2.190' })).toBeNull();
  });
  it('desktop: undecided — PyPI newest (the desktop checks it before stopping anything)', () => {
    expect(upgradeOfferVersion({ desktop: true, desktopTarget: null, pypiLatest: '0.2.190' })).toBe('0.2.190');
    expect(upgradeOfferVersion({ desktop: true, desktopTarget: undefined, pypiLatest: '0.2.190' })).toBe('0.2.190');
  });
  it('an update already ready: no second engine button — "Update ready" installs it', () => {
    expect(
      upgradeOfferVersion({ desktop: true, desktopTarget: '0.2.263', pypiLatest: '0.2.263', updateReady: true }),
    ).toBeNull();
  });
  it('browser: PyPI newest', () => {
    expect(upgradeOfferVersion({ desktop: false, desktopTarget: '0.2.181', pypiLatest: '0.2.190' })).toBe('0.2.190');
    expect(upgradeOfferVersion({ desktop: false, desktopTarget: undefined, pypiLatest: null })).toBeNull();
  });
});

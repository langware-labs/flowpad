import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubReleaseLabel } from '@src/components/version-popover/hub-release-label';

// The UI build stamp reaches app code through `sdkConfig`, not the raw
// `__UI_VERSION__` define — so it is mocked here the way any module is, and the
// assertions use a version that can never coincide with the repo's real one.
const config = { ui_version: '' };
vi.mock('@sdk/config/index', () => ({
  get sdkConfig() {
    return config;
  },
}));

afterEach(() => {
  cleanup();
  config.ui_version = '';
});

describe('HubReleaseLabel', () => {
  it('shows a desktop-style chip and lists hub + ui in its popover', () => {
    config.ui_version = '9.9.9';
    render(<HubReleaseLabel hubVersion="0.29.31" />);
    const chip = screen.getByTestId('hub-release-label');
    expect(chip.textContent).toBe('v9.9.9');
    fireEvent.click(chip);
    const details = screen.getByTestId('hub-release-details').textContent;
    expect(details).toContain('0.29.31');
    expect(details).toContain('9.9.9');
  });

  it('falls back to the hub release when the UI build has no stamp', () => {
    render(<HubReleaseLabel hubVersion="0.29.31" />);
    expect(screen.getByTestId('hub-release-label').textContent).toBe('v0.29.31');
  });

  it('renders nothing when neither version is known', () => {
    render(<HubReleaseLabel hubVersion={null} />);
    expect(screen.queryByTestId('hub-release-label')).toBeNull();
  });
});

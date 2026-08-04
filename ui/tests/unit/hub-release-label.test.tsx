import { render, screen, cleanup } from '@testing-library/react';
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
  it('shows the hub release and the UI build side by side', () => {
    config.ui_version = '9.9.9';
    render(<HubReleaseLabel hubVersion="0.29.31" />);
    expect(screen.getByTestId('hub-release-label').textContent).toBe('hub 0.29.31 · ui 9.9.9');
  });

  it('omits the hub half when the hub ships no version yet', () => {
    config.ui_version = '9.9.9';
    render(<HubReleaseLabel hubVersion={null} />);
    expect(screen.getByTestId('hub-release-label').textContent).toBe('ui 9.9.9');
  });

  it('renders nothing when neither version is known', () => {
    render(<HubReleaseLabel hubVersion={null} />);
    expect(screen.queryByTestId('hub-release-label')).toBeNull();
  });
});

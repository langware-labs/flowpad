import { installProjectLandingUrl } from '@src/lib/content-install';
import { describe, expect, it } from 'vitest';

const result = {
  project: { id: '00000000-0000-4000-8000-000000000001' },
  install_result: {
    target_project_id: '00000000-0000-5000-8000-000000000002',
    auto_launch_journey_id: '00000000-0000-5000-8000-000000000003',
  },
};

describe('install Project landing', () => {
  it('opens the reconciled target Project with its auto-launch Journey', () => {
    expect(installProjectLandingUrl('https://workspace.example/', result)).toBe(
      'https://workspace.example/dock/project/00000000-0000-5000-8000-000000000002' +
        '?journeyId=00000000-0000-5000-8000-000000000003',
    );
  });

  it('carries the same URL-first landing through the cookie gate', () => {
    const landing = installProjectLandingUrl(
      'https://workspace.example/auth/gate?cookie-gate=secret&next=%2F',
      result,
    );

    const gated = new URL(landing!);
    expect(gated.searchParams.get('cookie-gate')).toBe('secret');
    expect(gated.searchParams.get('next')).toBe(
      '/dock/project/00000000-0000-5000-8000-000000000002' +
        '?journeyId=00000000-0000-5000-8000-000000000003',
    );
  });

  it('fails closed when neither result names a Project', () => {
    expect(installProjectLandingUrl('https://workspace.example/', {})).toBeNull();
  });
});

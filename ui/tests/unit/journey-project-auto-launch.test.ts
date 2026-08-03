import apiClient from '@sdk/client';
import { autoLaunchRedirect } from '@src/journey/journey-load-redirect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/client', () => ({
  default: { get: vi.fn() },
}));

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const JOURNEY_ID = '00000000-0000-5000-8000-000000000002';

beforeEach(() => {
  localStorage.clear();
  vi.mocked(apiClient.get).mockReset();
});

describe('project journey auto-launch', () => {
  it('does not call the desktop journey API for a Hub Project route', async () => {
    const response = await autoLaunchRedirect(
      new Request(`http://flowpad.local/dock/hub/project/${PROJECT_ID}`),
    );

    expect(response).toBeNull();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('scopes the backend selection to the Project named by the URL', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ journey_id: JOURNEY_ID });

    const response = await autoLaunchRedirect(
      new Request(`http://flowpad.local/dock/project/${PROJECT_ID}`),
    );

    expect(apiClient.get).toHaveBeenCalledWith(
      `/api/v1/journeys/auto-launch?project_id=${PROJECT_ID}`,
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toBe(
      `/dock/project/${PROJECT_ID}?journeyId=${JOURNEY_ID}`,
    );
  });
});

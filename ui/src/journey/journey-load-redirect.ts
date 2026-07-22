import apiClient from '@sdk/client';
import { redirect } from 'react-router';
import { JOURNEY_PARAM } from '@src/navigation/DockPointer';
import { registerLoadRedirect } from '@src/routes/loaders/load-redirects';

/**
 * The `auto_launch` journey redirect, or null when there's nothing to enter.
 *
 * Skipped entirely when the URL already carries a journey, and never blocks the
 * load — any failure just means no auto-launch. The backend picks the journey
 * (disk `auto_launch` flag), skips one the user completed, and launches the
 * journal, so the redirect lands the user on their current step.
 */
async function autoLaunchRedirect(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.searchParams.get(JOURNEY_PARAM)) return null; // already showing one

  const { journey_id: journeyId } = await apiClient.get<{ journey_id: string | null }>(
    '/api/v1/journeys/auto-launch',
  );
  if (!journeyId) return null;

  url.searchParams.set(JOURNEY_PARAM, journeyId);
  return redirect(`${url.pathname}${url.search}`);
}

registerLoadRedirect(autoLaunchRedirect);

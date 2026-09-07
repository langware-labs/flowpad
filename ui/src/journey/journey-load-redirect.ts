import apiClient from '@sdk/client';
import { redirect } from 'react-router';
import { JOURNEY_PARAM } from '@src/navigation/DockPointer';
import { isJourneyDismissed } from './journey-dismissed';
import { AMBIENT_JOURNEYS_ENABLED } from './journeys-enabled';
import { ambientLoadProjectId, registerLoadRedirect } from '@src/routes/loaders/load-redirects';

/**
 * The `auto_launch` journey redirect, or null when there's nothing to enter.
 *
 * Skipped entirely when the URL already carries a journey, and never blocks the
 * load — any failure just means no auto-launch. The backend picks the journey
 * (disk `auto_launch` flag), skips one the user completed, and launches the
 * journal, so the redirect lands the user on their current step.
 */
export async function autoLaunchRedirect(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.searchParams.get(JOURNEY_PARAM)) return null; // already showing one
  if (isJourneyDismissed()) return null; // user closed it this session — badge is the way back
  const projectId = ambientLoadProjectId(request);
  if (projectId === undefined) return null; // deep link / Hub / inside a session
  // Home and non-dock routes retain the existing unscoped fallback.
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  const { journey_id: journeyId } = await apiClient.get<{ journey_id: string | null }>(
    `/api/v1/journeys/auto-launch${query}`,
  );
  if (!journeyId) return null;

  url.searchParams.set(JOURNEY_PARAM, journeyId);
  return redirect(`${url.pathname}${url.search}`);
}

// Registration IS the switch: with the feature hidden the redirect is never
// in the load chain at all, rather than running on every load to say "no".
if (AMBIENT_JOURNEYS_ENABLED) registerLoadRedirect(autoLaunchRedirect);

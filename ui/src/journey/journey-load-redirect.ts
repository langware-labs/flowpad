import apiClient from '@sdk/client';
import { PageId } from '@sdk';
import { redirect } from 'react-router';
import { DockPointer, JOURNEY_PARAM } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { isJourneyDismissed } from './journey-dismissed';
import { registerLoadRedirect } from '@src/routes/loaders/load-redirects';

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
  // A deep link the user was SENT here by outranks an ambient auto-launch: this
  // redirect rewrites the query, and the `?action=open&…` params would be lost
  // before anything read them (a launched sandbox came up with no project that
  // way). The journey auto-launches on the next home load instead.
  if (url.searchParams.get('action') === 'open') return null;

  let projectId: string | null = null;
  try {
    const dock = DockPointer.fromUrl(url.toString());
    // Journeys are a desktop Project feature. Hub Project routes reuse the
    // Project pointer grammar, but the Hub has no journey auto-launch API.
    if (dock.page === PageId.HUB) return null;
    if (dock.viewType === ViewType.PROJECT) {
      projectId = DockPointer.parseProjectPointer(dock.pointer).projectTypeId?.id ?? null;
    }
  } catch {
    // Home and non-dock routes retain the existing unscoped fallback.
  }
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  const { journey_id: journeyId } = await apiClient.get<{ journey_id: string | null }>(
    `/api/v1/journeys/auto-launch${query}`,
  );
  if (!journeyId) return null;

  url.searchParams.set(JOURNEY_PARAM, journeyId);
  return redirect(`${url.pathname}${url.search}`);
}

registerLoadRedirect(autoLaunchRedirect);

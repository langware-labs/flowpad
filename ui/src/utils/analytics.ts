const LAST_ENGAGEMENT_DATE_STORAGE_KEY = '_led';

export interface EventData {
  user_id?: string | null;
  event: string;
  event_source?: string;
  /** Event parameters. GTM maps each one to GA4 through a Data Layer Variable of the same name. */
  [param: string]: string | number | null | undefined;
}

declare global {
  interface Window {
    dataLayer: Record<string, unknown>[];
  }
}

window.dataLayer = window.dataLayer || [];

export function trackEvent(eventData: EventData): void {
  window.dataLayer.push(eventData);
  trackDailyUserEngagement();
}

/**
 * Track daily user engagement - fires only once per day
 */
function trackDailyUserEngagement(): void {
  const today = new Date().setHours(0, 0, 0, 0).toString(); // local midnight timestamp
  const lastEngagementDate = localStorage.getItem(LAST_ENGAGEMENT_DATE_STORAGE_KEY);

  if (lastEngagementDate === today) return;
  localStorage.setItem(LAST_ENGAGEMENT_DATE_STORAGE_KEY, today);
  trackEvent({
    event: 'user_engagement_daily',
  });
}

import { SubAgent } from '@sdk';

/**
 * Redirects to the console for a given agent ID
 * @param agentId - The agent ID to redirect to
 * @param openInNewTab - Whether to open in a new tab (default: false)
 */
export const redirectToConsole = (agentId: string | undefined, openInNewTab: boolean = false): void => {
  if (!agentId) {
    console.error('No agentId found');
    return;
  }

  const url = `/${SubAgent.type}/${agentId}`;

  if (openInNewTab) {
    window.open(url, '_blank');
  } else {
    window.location.href = url;
  }
};

/**
 * Ensures a URL has a valid protocol
 * @param url - The URL to validate
 * @returns A URL with a valid protocol
 */
export const ensureValidUrl = (url: string | undefined): string => {
  if (!url) return '#';

  // If URL already has a protocol, return as is
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  // Add https:// protocol by default
  return `https://${url}`;
};

import { Trans } from '@lingui/react/macro';
import type { WebappIssueCode } from './classify';

/**
 * The one place a technical signal becomes a sentence a person can act on.
 *
 * Two rules hold this table together. First, the user never reads the raw error
 * -- stack traces and status codes live behind the Details disclosure, where
 * they serve the repair agent rather than the person. Second, the copy says what
 * happened to *their app*, not what happened to our probe: "The app isn't
 * running" rather than "ERR_CONNECTION_REFUSED on port 4173".
 */
export function headlineForCode(code: WebappIssueCode): React.ReactNode {
  switch (code) {
    case 'starting':
      return <Trans>Starting your app…</Trans>;
    case 'not_running':
      return <Trans>Your app isn't running right now.</Trans>;
    case 'not_http':
      return <Trans>Something is using this port, but it isn't your app.</Trans>;
    case 'server_error':
      return <Trans>Your app started but hit an error while loading.</Trans>;
    case 'not_found':
      return <Trans>Your app is running, but this page wasn't found.</Trans>;
    case 'blank_page':
      return <Trans>Your app loaded but is showing nothing.</Trans>;
    case 'hung':
      return <Trans>Your app started but stopped responding.</Trans>;
    case 'redirect_loop':
      return <Trans>Your app keeps redirecting to itself.</Trans>;
    case 'crashed':
      return <Trans>Your app opened but crashed while starting.</Trans>;
    case 'console_errors':
      return <Trans>Your app is running, but parts of it may not work.</Trans>;
    case 'failed_requests':
      return <Trans>Part of your app didn't load.</Trans>;
    case 'ok':
      return null;
  }
}

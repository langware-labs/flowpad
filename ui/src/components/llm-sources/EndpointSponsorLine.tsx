import { Trans } from '@lingui/react/macro';

import { useEndpointSponsor } from './use-hub-remaining';

/** "Organization: X · Team: Y" — who allocated this hub endpoint; nothing when neither is known. */
export function EndpointSponsorLine({ typeid }: { typeid: string }) {
  const { organization, team } = useEndpointSponsor(typeid);
  if (!organization && !team) return null;
  return (
    <span className="truncate text-xs text-muted-foreground" data-testid={`endpoint-sponsor-${typeid}`}>
      {organization && <Trans>Organization: {organization}</Trans>}
      {organization && team && ' · '}
      {team && <Trans>Team: {team}</Trans>}
    </span>
  );
}

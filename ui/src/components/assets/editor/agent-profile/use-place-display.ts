import { Deployment, type AgentPlace } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import { Laptop, type LucideIcon } from 'lucide-react';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';

export interface PlaceDisplay {
  label: string;
  Icon: LucideIcon;
}

/**
 * How an environment is named and drawn, once: `Development · local` on this
 * computer, `Cloud · <name>` otherwise. A cloud machine wears the Deployment
 * type's own icon; only the local environment overrides it.
 */
export function usePlaceDisplay(): (place: AgentPlace) => PlaceDisplay {
  const { t } = useLingui();
  return useCallback(
    (place: AgentPlace) =>
      place.is_local
        ? { label: t`Development · local`, Icon: Laptop }
        : { label: t`Cloud · ${place.deployment.name}`, Icon: iconForType(Deployment.type) },
    [t],
  );
}

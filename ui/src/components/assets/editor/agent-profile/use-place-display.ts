import { Deployment, type AgentPlace, type AutomationPlace } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import { Cloud, Laptop, type LucideIcon } from 'lucide-react';

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

/** The deployment name in an overview place's label (`Cloud · <name>`). The label is the backend's English. */
const deploymentName = (place: AutomationPlace): string => place.label.replace(/^Cloud\s*·\s*/, '') || place.label;

/**
 * How an automation's place is named and drawn, on every schedule surface: `This computer` (and `every
 * machine` for a row no machine is named on), `Cloud · <name>` for a cloud machine, `Flowpad cloud` for a
 * schedule the hub runs.
 */
export function usePlaceBadge(): (place: AutomationPlace) => PlaceDisplay {
  const { t } = useLingui();
  return useCallback(
    (place: AutomationPlace) => {
      if (place.kind === 'hub') return { label: t`Flowpad cloud`, Icon: Cloud };
      if (place.kind === 'cloud_machine')
        return { label: t`Cloud · ${deploymentName(place)}`, Icon: iconForType(Deployment.type) };
      return { label: place.every_machine ? t`This computer · every machine` : t`This computer`, Icon: Laptop };
    },
    [t],
  );
}

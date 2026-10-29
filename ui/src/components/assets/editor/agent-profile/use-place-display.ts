import { Deployment, type AgentPlace, type AutomationPlace } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';
import { Cloud, Laptop, type LucideIcon } from 'lucide-react';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';

export interface PlaceDisplay {
  label: string;
  Icon: LucideIcon;
}

/** What naming a place reads: whether it is this computer, and its Deployment's name. */
export type NamedPlace = Pick<AgentPlace, 'is_local'> & { deployment: Pick<AgentPlace['deployment'], 'name'> };

/**
 * How an environment is named and drawn, once: `Development · local` on this
 * computer, `Cloud · <name>` otherwise. A cloud machine wears the Deployment
 * type's own icon; only the local environment overrides it.
 */
export function usePlaceDisplay(): (place: NamedPlace) => PlaceDisplay {
  const { t } = useLingui();
  return useCallback(
    (place: NamedPlace) =>
      place.is_local
        ? { label: t`Development · local`, Icon: Laptop }
        : { label: t`Cloud · ${place.deployment.name}`, Icon: iconForType(Deployment.type) },
    [t],
  );
}

/** The parts of an automation's place its words are made from (never its English `label`). */
export type BadgePlace = Pick<AutomationPlace, 'kind' | 'every_machine' | 'deployment_id' | 'deployment_name'>;

/**
 * How an automation's place is named and drawn, on every schedule surface: `This computer` (and `every
 * machine` for a row no machine is named on), a cloud machine as {@link usePlaceDisplay} names it, `Flowpad
 * cloud` for a schedule the hub runs. A cloud machine's name is the place's `deployment_name`, else the
 * agent's place with that `deployment_id` (`places`).
 */
export function usePlaceBadge(places: AgentPlace[] = []): (place: BadgePlace) => PlaceDisplay {
  const { t } = useLingui();
  const display = usePlaceDisplay();
  return useCallback(
    (place: BadgePlace) => {
      if (place.kind === 'hub') return { label: t`Flowpad cloud`, Icon: Cloud };
      if (place.kind === 'cloud_machine') {
        const name =
          place.deployment_name ||
          places.find((p) => p.deployment.id === place.deployment_id)?.deployment.name ||
          place.deployment_id ||
          '';
        return display({ is_local: false, deployment: { name } });
      }
      return { label: place.every_machine ? t`This computer · every machine` : t`This computer`, Icon: Laptop };
    },
    [t, display, places],
  );
}

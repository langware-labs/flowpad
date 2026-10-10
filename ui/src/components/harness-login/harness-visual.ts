import type { HarnessStatus } from '@sdk';
import type { ComponentType } from 'react';

import { workerOf } from '@src/components/llm-sources/use-llm-sources';
import { lucideByName } from '@src/lib/lucide-by-name';
import { PROVIDER_META } from '@src/tabs/provider-meta';

/**
 * A harness's worker name and mark: the vendor's brand tint where there is one, else the icon
 * its capability spec registered. One place, so the modal row and the sign-in dialog cannot
 * draw the same assistant two ways.
 */
export function harnessVisual(
  h: HarnessStatus | undefined,
  kind: string,
): { worker: string; Icon: ComponentType<{ className?: string }> | undefined; iconClassName: string } {
  const worker = h?.worker_type ?? workerOf(kind);
  const meta = (PROVIDER_META as Partial<Record<string, (typeof PROVIDER_META)['claude']>>)[worker];
  return {
    worker,
    Icon: meta?.Icon ?? (h?.icon ? lucideByName(h.icon) : undefined),
    iconClassName: meta?.iconClassName ?? '',
  };
}

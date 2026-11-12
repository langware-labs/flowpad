/**
 * Device logins as endpoint rows: each vendor subscription (Claude / Codex / Copilot) is an
 * endpoint of its own on this machine, listed in the API keys table beside the stored keys.
 *
 * It has no key — the vendor CLI holds its own session — only what the user sets on it: the model
 * each size runs and any custom named models (`tiers`, written by `lm_keys/device`). This replaced
 * the per-(harness, provider) "Mapping" window; the backend migrated what that held onto these rows.
 */
import { LLMEndpoint, dataContext, lmKeysService, type DeviceEndpointWire } from '@sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { invalidateLlmFunding } from '@src/components/llm-sources/use-llm-sources';

const DEVICE_ENDPOINTS_KEY = ['lm-keys', 'device-endpoints'] as const;

export interface DeviceEndpoints {
  endpoints: LLMEndpoint[];
  /** The wire row behind each listed endpoint, by id: its harness and its full `tiers` map. */
  byId: ReadonlyMap<string, DeviceEndpointWire>;
  invalidate: () => void;
}

export function useDeviceEndpoints(enabled = true): DeviceEndpoints {
  const queryClient = useQueryClient();
  const on = enabled && !!dataContext.caps.localFiles; // a hub-only runtime has no device logins
  const { data } = useQuery({
    queryKey: DEVICE_ENDPOINTS_KEY,
    queryFn: () => lmKeysService.listDeviceEndpoints(),
    enabled: on,
  });
  const rows = useMemo(() => (on ? (data ?? []) : []), [on, data]);
  const endpoints = useMemo(
    () =>
      rows.map(
        (row) =>
          new LLMEndpoint({ id: row.id, name: row.name, provider: '', enabled: true, tiers: row.tiers } as never),
      ),
    [rows],
  );
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: DEVICE_ENDPOINTS_KEY });
    invalidateLlmFunding();
  }, [queryClient]);
  return { endpoints, byId, invalidate };
}

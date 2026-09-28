import { Trans, useLingui } from '@lingui/react/macro';
import { type Deployment, type EndpointHealth, type HealthState, type ServiceEndpoint, worstHealth } from '@sdk';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';

export const HEALTH_COLOR: Record<HealthState, string> = {
  alive: 'bg-green-500',
  starting: 'bg-amber-400',
  failing: 'bg-red-500',
  unknown: 'bg-muted-foreground',
};

/** One service's last known health — what its row recorded, or `unknown` before any check. */
function healthOf(endpoint: ServiceEndpoint, fresh: Record<string, EndpointHealth>): EndpointHealth | null {
  return fresh[endpoint.id] ?? endpoint.health ?? null;
}

/**
 * The services a deployment answers on, each with its health.
 *
 * Reads the last recorded check (the hub's sweep keeps it current for a cloud box); "Check now" runs
 * every service's check where it runs — this machine, or the hub for a cloud placement.
 */
export function DeploymentHealth({ deployment }: { deployment: Deployment }) {
  const { t } = useLingui();
  const [endpoints, setEndpoints] = useState<ServiceEndpoint[] | null>(null);
  const [fresh, setFresh] = useState<Record<string, EndpointHealth>>({});
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    deployment
      .endpoints()
      .then((rows) => live && setEndpoints(rows))
      .catch((e: unknown) => live && setError(errorMessage(e, t`Could not read this deployment's services`)));
    return () => {
      live = false;
    };
  }, [deployment, t]);

  const checkNow = useCallback(async () => {
    if (!endpoints?.length) return;
    setChecking(true);
    setError(null);
    try {
      const results = await Promise.all(endpoints.map((e) => e.healthCheck()));
      setFresh(Object.fromEntries(results.map((r) => [r.endpoint_id, r])));
    } catch (e) {
      setError(errorMessage(e, t`The health check did not answer`));
    } finally {
      setChecking(false);
    }
  }, [endpoints, t]);

  if (endpoints === null && !error) return null;
  // Declared by the deployment, served by no endpoint: "it should be running" is the declaration's promise.
  const served = new Set((endpoints ?? []).map((e) => e.name));
  const missing = (deployment.exposes ?? []).filter((d) => !served.has(d.name));
  const states: HealthState[] = [
    ...(endpoints ?? []).map((e) => healthOf(e, fresh)?.state ?? 'unknown'),
    ...missing.map((): HealthState => 'failing'),
  ];

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t px-2 py-1.5"
      data-testid={`deployment-health-${deployment.id}`}
    >
      <span className="text-xs text-muted-foreground">
        <Trans>Services</Trans>
      </span>
      {(endpoints ?? []).map((endpoint) => {
        const health = healthOf(endpoint, fresh);
        const state = health?.state ?? 'unknown';
        return (
          <span
            key={endpoint.id}
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
            title={health?.detail || state}
            data-testid={`endpoint-health-${endpoint.name}`}
            data-state={state}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${HEALTH_COLOR[state]}`} />
            {endpoint.name}
          </span>
        );
      })}
      {missing.map((declared) => (
        <span
          key={`declared-${declared.name}`}
          className="inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 text-xs"
          title={t`Declared by this deployment, but nothing serves it`}
          data-testid={`endpoint-health-${declared.name}`}
          data-state="failing"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${HEALTH_COLOR.failing}`} />
          {declared.name}
        </span>
      ))}
      {endpoints?.length === 0 && missing.length === 0 && (
        <span className="text-xs text-muted-foreground">
          <Trans>none</Trans>
        </span>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
      {!!endpoints?.length && (
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-1.5"
          disabled={checking}
          onClick={() => void checkNow()}
          title={t`Check every service now`}
          data-testid={`deployment-health-check-${deployment.id}`}
          data-state={worstHealth(states)}
        >
          {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      )}
    </div>
  );
}

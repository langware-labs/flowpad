import apiClient from '@sdk/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebappHealth, type WebappHealth } from '@src/components/display-toolbar/use-webapp-health';
import { classifyWebappSeverity, type WebappProbe, type WebappVerdict } from './classify';

/**
 * Everything we can learn about a shown web app, merged into one verdict.
 *
 * Two signals feed this. The browser can only ever answer "did a request to the
 * app throw" -- the guest is cross-origin, so its console, its HTTP status and
 * its exceptions are all invisible from here. The backend probe can answer the
 * rest, because it talks to the port directly. This hook owns the stateful part
 * of combining them; the verdict itself comes from the pure `classify` module.
 */

/**
 * How long a freshly-mounted app is given to come up before silence counts as
 * failure. A dev server that is still compiling refuses connections exactly like
 * one that is dead, and calling a booting app "broken" is both wrong and
 * expensive -- it would trigger an automatic repair of nothing. This is a
 * semantic grace period for a known-slow state transition, not a retry budget
 * widened to hide a flake.
 */
const BOOT_GRACE_MS = 10_000;

/** Minimum spacing between probes, so a flapping server cannot spam the backend. */
const PROBE_DEBOUNCE_MS = 2_000;

export interface WebappDiagnostics extends WebappVerdict {
  health: WebappHealth;
  probe: WebappProbe | null;
  /** Re-run the probe now (used by the toolbar refresh and after a repair). */
  refresh: () => void;
  /** Bumped whenever the app comes back from the dead, to force a frame reload. */
  reloadNonce: number;
}

interface Options {
  /** Process that owns the dev server; the probe action hangs off it. */
  processId: string | null | undefined;
  /** The get-host URL the iframe points at (also the liveness ping target). */
  host: string;
  port: string | null;
}

export function useWebappDiagnostics({ processId, host, port }: Options): WebappDiagnostics {
  const health = useWebappHealth(host);
  const [probe, setProbe] = useState<WebappProbe | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  // Plain state, not refs: these are inputs to the verdict, so they have to be
  // able to trigger a re-render and a re-classification on their own.
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [everLoaded, setEverLoaded] = useState(false);
  const [graceExpired, setGraceExpired] = useState(false);

  const lastProbeAt = useRef(0);
  const lastHealth = useRef<WebappHealth>('checking');

  const runProbe = useCallback(
    async (force = false) => {
      if (!processId || !port) return;
      const now = Date.now();
      if (!force && now - lastProbeAt.current < PROBE_DEBOUNCE_MS) return;
      lastProbeAt.current = now;
      try {
        const data = await apiClient.post<WebappProbe>(
          `/graph/agentic_process/${processId}/probe-webapp`,
          undefined,
          { params: { port } },
        );
        setProbe((data as unknown as WebappProbe) ?? null);
      } catch {
        // The probe is a diagnostic, not a dependency: if the backend cannot
        // answer we fall back to the liveness signal rather than showing an
        // error about the error.
        setProbe(null);
      }
    },
    [processId, port],
  );

  // Kept in a ref so the effects below can fire the probe without taking a
  // dependency on the callback's identity -- `processId` arrives asynchronously,
  // and re-running a forced probe on every identity change costs a second full
  // round trip that bypasses the debounce.
  const runProbeRef = useRef(runProbe);
  runProbeRef.current = runProbe;

  // A new app is a new subject: reset every accumulated judgement about the old
  // one, or a healthy app inherits its predecessor's failure count. Probing here
  // (rather than on mount) also means an app opened onto an already-broken
  // server explains itself without waiting for a liveness transition.
  useEffect(() => {
    setConsecutiveFailures(0);
    setEverLoaded(false);
    setGraceExpired(false);
    setProbe(null);
    lastProbeAt.current = 0;
    lastHealth.current = 'checking';
    void runProbeRef.current(true);

    const id = window.setTimeout(() => setGraceExpired(true), BOOT_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [host]);

  // Track liveness transitions. The interesting edges are down (start counting,
  // and probe for the reason) and up-after-down (the app recovered, so the
  // parked iframe is showing a stale error page and must be reloaded).
  useEffect(() => {
    const previous = lastHealth.current;
    lastHealth.current = health;

    if (health === 'up') {
      setConsecutiveFailures(0);
      setEverLoaded(true);
      if (previous === 'down') {
        setReloadNonce((n) => n + 1);
        void runProbeRef.current(true);
      }
    } else if (health === 'down') {
      setConsecutiveFailures((n) => n + 1);
      void runProbeRef.current();
    }
  }, [health]);

  const verdict = useMemo(
    () =>
      classifyWebappSeverity({
        health,
        probe,
        consecutiveFailures,
        everLoaded,
        withinGrace: !graceExpired,
      }),
    [health, probe, consecutiveFailures, everLoaded, graceExpired],
  );

  const refresh = useCallback(() => void runProbe(true), [runProbe]);

  return { ...verdict, health, probe, refresh, reloadNonce };
}

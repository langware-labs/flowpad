import { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { Capability, TypeId } from '@sdk';
import { useCapability, useEntity } from '@sdk/react/hooks';
import { RowProcess } from '@src/components/capabilities-view/CapabilitiesView';

import type { JourneyActSpec } from '@sdk';

/**
 * Live sub-panel under the CURRENT step for the capability-setup acts:
 * `setup_capability` tails the install agentic process's one-liner (the same
 * surface the capabilities view shows), `device_login` renders the one-time
 * code + verification link from the capability row's broadcast login_* fields.
 * Pure presentation — completion is still gated by the step's `await`.
 */
export function JourneyStepLive({ act }: { act: JourneyActSpec }) {
  if (act.kind === 'setup_capability' && act.capability) {
    return <SetupProgress kind={act.capability} />;
  }
  if (act.kind === 'device_login' && act.capability) {
    return <DeviceLoginPanel kind={act.capability} />;
  }
  return null;
}

function SetupProgress({ kind }: { kind: string }) {
  const { processId } = useCapability(kind, { autoCheck: false });
  if (!processId) return null;
  return (
    <div className="mt-1">
      <RowProcess processId={processId} />
    </div>
  );
}

function DeviceLoginPanel({ kind }: { kind: string }) {
  const { capability } = useCapability(kind, { autoCheck: false });
  const typeId = useMemo(() => {
    try {
      return capability?.id ? new TypeId(Capability.type, capability.id) : null;
    } catch {
      return null;
    }
  }, [capability?.id]);
  // Watch the row live: login_* fields arrive over WS as the PTY progresses.
  const { data: live } = useEntity<Capability>(typeId, { enabled: !!typeId, watch: true });
  if (!live?.login_state || live.login_state === 'idle') return null;
  if (live.login_state === 'authenticated') {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground" data-testid="journey-device-login-done">
        <Trans>Authenticated ✓</Trans>
      </p>
    );
  }
  if (live.login_state === 'error') {
    return (
      <p className="mt-1 text-[11px] text-destructive" data-testid="journey-device-login-error">
        {live.login_message || <Trans>Login failed — try again.</Trans>}
      </p>
    );
  }
  return (
    <div className="mt-1 space-y-1" data-testid="journey-device-login">
      {live.login_code && (
        <p className="font-mono text-sm font-semibold tracking-widest">{live.login_code}</p>
      )}
      {live.login_url && (
        <a
          href={live.login_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-primary underline underline-offset-2"
        >
          <Trans>Enter the code here</Trans>
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
      {!live.login_code && !live.login_url && (
        <p className="text-[11px] text-muted-foreground">{live.login_message || <Trans>Starting login…</Trans>}</p>
      )}
    </div>
  );
}

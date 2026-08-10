import { ComputeNode, TypeId } from '@sdk';
import { Button } from '@src/components/ui/button';
import { workspaceServiceUrl } from '@src/hooks/use-sandboxes';
import { ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * `/open-sandbox?node=<compute_node id>` — where a share invitation lands.
 *
 * It exists because the two obvious destinations are both worse. Sending the
 * recipient straight to `open-service` gives them a blank tab for as long as the
 * hub takes to resume the box and wait for it to answer — tens of seconds with
 * nothing on screen and no way to tell working from broken. Sending them to hub
 * home instead makes them hunt for a card and press Open, which is the one thing
 * the invitation already knows they want.
 *
 * So: say what is happening, then go. Same shell as `LaunchLanding` /
 * `InstallLanding` (the other two "you arrived from outside the app" pages).
 *
 * Unlike those two this asks for no confirmation. They accepted an invitation to
 * a specific sandbox; the destination is not attacker-chosen, and `open-service`
 * authorizes the caller anyway — a recipient without a role on the node gets a
 * 403 from the hub rather than a box.
 *
 * The redirect is a top-level `assign`, not `window.open`: this runs on load
 * rather than inside a click, and a popup blocker eats the latter.
 */
export default function OpenSandboxLanding() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const nodeId = (params.get('node') ?? '').trim();
  const [error, setError] = useState<string | null>(null);
  // Held in state rather than rebuilt during render: the fallback link below
  // would otherwise call `workspaceServiceUrl` on an id nothing has validated
  // yet, on the first paint, before the effect has had a chance to reject it.
  const [target, setTarget] = useState<string | null>(null);
  // StrictMode double-invokes effects; navigating twice would restart the box's
  // resume from scratch.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!nodeId) {
      setError(t`This link is missing the sandbox it should open.`);
      return;
    }
    let url: string;
    try {
      // Round-trips through TypeId so a malformed id fails HERE, with a
      // sentence, rather than becoming a hub URL that 404s.
      url = workspaceServiceUrl(new TypeId(ComputeNode.type, nodeId).id);
    } catch {
      setError(t`This link does not point at a sandbox.`);
      return;
    }
    setTarget(url);
    window.location.assign(url);
  }, [nodeId, t]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md text-center">
        {error ? (
          <>
            <p className="text-sm font-medium" data-testid="open-sandbox-error">
              {error}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans>Ask whoever shared it for a new link.</Trans>
            </p>
          </>
        ) : (
          <>
            <div
              className="mx-auto mb-5 h-10 w-10 animate-spin rounded-full border-b-2 border-muted-foreground/40"
              aria-hidden
            />
            <p className="text-sm font-medium" data-testid="open-sandbox-preparing">
              <Trans>Preparing your sandbox…</Trans>
            </p>
            {/* The wait is genuinely long — the hub resumes a paused machine and
                waits for the app to answer before it redirects. Saying so is the
                difference between "slow" and "stuck". */}
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans>This can take up to a minute if it was asleep.</Trans>
            </p>
            {/* A manual way through, for the case the automatic navigation is
                blocked or silently fails — the same fallback link the other two
                landing pages offer. */}
            {target && (
              <Button asChild size="sm" variant="ghost" className="mt-5 gap-1.5">
                <a href={target} data-testid="open-sandbox-open">
                  <ExternalLink className="h-3.5 w-3.5" />
                  <Trans>Open it now</Trans>
                </a>
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

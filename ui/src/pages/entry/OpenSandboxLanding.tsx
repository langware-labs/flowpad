import { ComputeNode, TypeId } from '@sdk';
import { Button } from '@src/components/ui/button';
import { StepList } from '@src/components/ui/step-list';
import { isLaunched, useSandboxes, workspaceServiceUrl } from '@src/hooks/use-sandboxes';
import { errorMessage, errorStatus } from '@src/lib/error-message';
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
 * IT ALSO LAUNCHES, when the box arriving here was never launched. A sandbox is
 * written down by `createSandbox` and provisioned by `launchSandbox`, and the two
 * are separate clicks — so a machine can be shared while it is still only a row.
 * Redirecting one of those to `open-service` produces the hub's 409, "this
 * machine has not been set up yet": a dead end at the end of an invitation, on
 * the one screen where the recipient has no card and no Launch button to fall
 * back to. The card on hub home has always branched on exactly this
 * (`isLaunched(d) ? Open : Launch`); this page now does the same, and runs the
 * launch itself rather than offering a second button — the click that got them
 * here already said what they wanted.
 *
 * Only an OWNER can launch: `ops` is absent from `compute_node`'s policy block,
 * so it resolves through `default_policy`'s `owner: ["*"]` and for nobody else.
 * That is exactly the difference between the share dialog's two modes — a plain
 * share grants `admin` (enough for `open-service`, not for `ops/setup`), while
 * the transfer checkbox grants `owner`. So a transferred box launches here, and
 * a merely-shared one says who has to launch it, rather than dying on a 403 the
 * recipient cannot act on.
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
  // Whether we are booting the machine rather than just opening it. Drives which
  // of the two waits is described, since they are minutes apart in length.
  const [launching, setLaunching] = useState(false);
  // StrictMode double-invokes effects; navigating twice would restart the box's
  // resume from scratch, and launching twice would orphan a VM.
  const started = useRef(false);

  // `launchSandbox` is where `ops/setup` → `workspace-ready` → the project setup
  // live, and a second copy of that sequence here would be one to keep in step
  // forever. `steps` is the identical checklist the launcher sees, which is the
  // point — arriving by invitation should look like launching it yourself.
  //
  // Deliberately NOT `sandboxes` from the same hook. This page used to find the
  // node in that list, and the list is the wrong instrument: it is gated on
  // `enabled: !!user`, and a DISABLED react-query reports `isLoading: false`
  // (v5 defines it as `isPending && isFetching`, and a disabled query never
  // fetches). So before auth resolved, "still loading" and "loaded, and this box
  // does not exist" were the same observation — and this page took the second
  // reading, redirected to `open-service`, and the recipient got the 409 this
  // page exists to prevent. Arriving straight from a sign-in round trip, which is
  // exactly what an invitation does, made that the COMMON path rather than a race.
  const { launchSandbox, steps } = useSandboxes();

  useEffect(() => {
    if (started.current) return;
    if (!nodeId) {
      started.current = true;
      setError(t`This link is missing the sandbox it should open.`);
      return;
    }
    let url: string;
    try {
      // Round-trips through TypeId so a malformed id fails HERE, with a
      // sentence, rather than becoming a hub URL that 404s.
      url = workspaceServiceUrl(new TypeId(ComputeNode.type, nodeId).id);
    } catch {
      started.current = true;
      setError(t`This link does not point at a sandbox.`);
      return;
    }
    setTarget(url);
    started.current = true;

    void (async () => {
      // ASK FOR THE NODE. One addressed GET, which either answers with the box or
      // fails — two outcomes that cannot be confused with each other, unlike an
      // empty list. It also needs no auth timing of its own: the request carries
      // the session the page was loaded with, and a 401 lands in the catch rather
      // than quietly reading as "no such sandbox".
      let node: ComputeNode | null = null;
      try {
        node = await ComputeNode.getById<ComputeNode>(nodeId);
      } catch {
        // Unreachable or refused: the hub is the authority on both, and
        // `open-service` will say so in a language the browser can render.
        window.location.assign(url);
        return;
      }
      if (!node || isLaunched(node)) {
        window.location.assign(url);
        return;
      }

      setLaunching(true);
      try {
        // `autoLogin: true` matches the launch dialog's default. The recipient of
        // a handover is the box's one person now, which is what the flag means.
        //
        // The return value is deliberately not branched on: `null` means the hook
        // refused because a launch was already in flight, and the box is on its
        // way up either way. Only a THROW means it is not coming.
        await launchSandbox(node, { autoLogin: true });
        window.location.assign(url);
      } catch (e) {
        setLaunching(false);
        // 403 is the one failure with a person attached to it: they hold `admin`
        // from a plain share, which opens a running box but cannot build one.
        // Naming the fix beats echoing "Forbidden" at someone who did nothing wrong.
        setError(
          errorStatus(e) === 403
            ? t`This sandbox has not been started yet, and only its owner can start it.`
            : errorMessage(e, t`This sandbox could not be started.`),
        );
      }
    })();
  }, [nodeId, launchSandbox, t]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md text-center">
        {error ? (
          <>
            <p className="text-sm font-medium" data-testid="open-sandbox-error">
              {error}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans>Ask whoever shared it to start it, or to send a new link.</Trans>
            </p>
          </>
        ) : launching ? (
          <>
            <p className="text-sm font-medium" data-testid="open-sandbox-launching">
              <Trans>Starting your sandbox…</Trans>
            </p>
            {/* The first boot is a different order of wait from an open: a VM is
                being created, FlowPad started inside it, and whatever the box was
                created with set up. The rows say which of those is happening, so
                a long wait reads as progress rather than as a hang. */}
            <p className="mb-5 mt-2 text-sm text-muted-foreground">
              <Trans>This is its first start, so it takes a few minutes.</Trans>
            </p>
            <StepList steps={steps} testId="open-sandbox-launch-steps" testIdPrefix="open-sandbox" />
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

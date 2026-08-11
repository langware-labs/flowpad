import {
  acceptInvitationOnHub,
  cloudManager,
  ComputeNode,
  fetchPendingInvitations,
  navigator as sdkNavigator,
  TypeId,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import { StepList } from '@src/components/ui/step-list';
import { isLaunched, useSandboxes, workspaceServiceUrl } from '@src/hooks/use-sandboxes';
import { errorMessage, errorStatus } from '@src/lib/error-message';
import { ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * `/compute_node/<id>` — where a share invitation lands.
 *
 * Addressed the way every other entry journey is: entity type, then id, in the
 * PATH. `flow_message/:messageId` is the same route doing the same job for a
 * conversation — land from an email, resolve the entity, go into it — and it is
 * four lines above this one in the router. This used to be
 * `/open-sandbox?node=<id>`, the only URL in the codebase carrying an
 * identifier in a query string.
 *
 * It does NOT collide with `/dock/hub/entity/compute_node/<id>`, the generic
 * record viewer. Those are a pair, and `flow_message` already has both: one
 * address to arrive at from outside the app, one to browse to from inside.
 *
 * Being the shape the hub already emits is the point. `_post_accept_landing_url`
 * ends in `build_entity_url(chosen_target.typeid)`, which produces exactly this
 * URL — so accepting a sandbox invitation now lands here on its own and the
 * `callback_override` that used to steer it is gone.
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
/**
 * Marks a load that has already been through the sign-in round trip.
 *
 * The loop guard, and it has to be in the URL: the trip goes out through the
 * provider and back, so nothing in memory survives it. Coming back still
 * unauthorized means signing in was not the answer, and the hub gets to explain
 * why rather than being asked a second time.
 */
const RETURNED_PARAM = 'signed-in';

/**
 * Accept the invitation to THIS sandbox, if one is waiting for the signed-in user.
 *
 * Returns whether anything was accepted, and never throws: every failure here —
 * offline, a hub that does not serve `pending`, an invitation that expired between
 * the listing and the accept — means the same thing to the caller, which is "carry
 * on and let the hub explain".
 *
 * Matched on the invitation's TARGET, not on its id, because the URL names a
 * machine and nothing else. A recipient with several pending invitations gets the
 * one for the box they are standing on and no other — accepting a stranger's
 * invitation because it happened to be first in the list would grant a role nobody
 * asked for.
 */

async function acceptPendingInvitationFor(nodeId: string): Promise<boolean> {
  try {
    const pending = await fetchPendingInvitations();
    const invite = pending.find((i) => i.target_type === ComputeNode.type && i.target_id === nodeId);
    if (!invite) return false;
    // The hub's own ceremony, not a re-implementation of it: `members/accept` is
    // where the role is granted, a transfer is re-authorized against the CURRENT
    // owner, the sender is stepped down and the cookie gate is retired. None of
    // that can be done from here, and a second spelling of it would drift.
    await acceptInvitationOnHub(invite.id);
    return true;
  } catch {
    return false;
  }
}

export default function OpenSandboxLanding() {
  const { t } = useLingui();
  const { nodeId: routeNodeId } = useParams();
  const nodeId = (routeNodeId ?? '').trim();
  const [params] = useSearchParams();
  const alreadyReturned = params.get(RETURNED_PARAM) === '1';
  // The router's location, not `window.location`: this page's address is the one
  // the ROUTER resolved, and the return address handed to the login has to be
  // that — the global is a different fact that merely usually agrees.
  const here = useLocation();
  const [error, setError] = useState<string | null>(null);
  // Held in state rather than rebuilt during render: the fallback link below
  // would otherwise call `workspaceServiceUrl` on an id nothing has validated
  // yet, on the first paint, before the effect has had a chance to reject it.
  const [target, setTarget] = useState<string | null>(null);
  // Whether we are booting the machine rather than just opening it. Drives which
  // of the two waits is described, since they are minutes apart in length.
  const [launching, setLaunching] = useState(false);
  // The handover step, which only a first-time recipient ever sees. Named on
  // screen because it is the one moment where something changes hands, and a
  // silent spinner through it reads as a stall.
  const [accepting, setAccepting] = useState(false);
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
        // TWO REASONS WEAR THE SAME 401, and they need opposite answers.
        //
        // NO SESSION ("missing or invalid token"). Sign them in and come BACK
        // HERE. Falling through to `open-service` instead is what broke every
        // unlaunched transfer: the hub builds the post-login callback from the url
        // that reached it, so forwarding first makes `open-service` the return
        // address — and the recipient lands on the one route that cannot launch a
        // box, which 409s. The launch page has to be the address they return to.
        // (Measured on staging: sign-in also completes the invitation accept, so
        // they come back holding the role.)
        if (!cloudManager.isLoggedIn && !alreadyReturned) {
          const back = new URL(`${here.pathname}${here.search}`, window.location.origin);
          back.searchParams.set(RETURNED_PARAM, '1');
          window.location.assign(sdkNavigator.getLoginWithCallbackUrl(back.toString()));
          return;
        }

        // A SESSION, BUT NO ROLE ("has no roles on compute_node-…"). Signing in
        // again would change nothing — they are already the right person. What is
        // missing is the acceptance, and the single most likely reason to be
        // standing on a sandbox's url with no role is an invitation not yet taken
        // up. That was the whole two-link problem: the emailed link performed the
        // handover and the pasted one could only arrive after it, so sending
        // someone the wrong one produced a "Wrong account" screen naming a problem
        // they did not have.
        //
        // `pending` is the only way to see it: invitations are saved with no owner,
        // so the recipient holds no role on the row either and an ordinary query
        // returns nothing for exactly the person it is addressed to.
        //
        // Terminates on its own. Accepting removes the row from `pending`, so a
        // second pass finds nothing and falls through — no flag, no counter.
        setAccepting(true);
        const accepted = await acceptPendingInvitationFor(nodeId);
        setAccepting(false);
        if (!accepted) {
          // Unreachable, or genuinely not theirs. The hub is the authority on
          // both, and `open-service` says so in a language the browser renders.
          window.location.assign(url);
          return;
        }
        try {
          node = await ComputeNode.getById<ComputeNode>(nodeId);
        } catch {
          window.location.assign(url);
          return;
        }
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
  }, [nodeId, alreadyReturned, here.pathname, here.search, launchSandbox, t]);

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
        ) : accepting ? (
          <>
            <div
              className="mx-auto mb-5 h-10 w-10 animate-spin rounded-full border-b-2 border-muted-foreground/40"
              aria-hidden
            />
            <p className="text-sm font-medium" data-testid="open-sandbox-accepting">
              <Trans>Accepting your invitation…</Trans>
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

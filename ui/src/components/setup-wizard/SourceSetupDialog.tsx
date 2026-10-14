import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type DataSource,
  OAuthStatus,
  type SetupNeed,
  type SetupNodeResult,
  type SetupTreeResult,
  oauthService,
} from '@sdk';
import { useOAuthFlowComplete } from '@sdk/react/hooks';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { errorMessage } from '@src/lib/error-message';
import { Button } from '@src/components/ui/button';
import { Dialog } from '@src/components/ui/dialog';
import { SteppedDialogContent } from '@src/components/ui/stepped-dialog';
import { AskForm } from '@src/components/ask/AskForm';
import { useSourceSetupRun } from '@src/components/project-setup/use-setup-run';
import { SetupTreeView } from '@src/components/project-setup/SetupTreeView';
import { useSourceSetupStore } from './source-setup-store';

/**
 * Set up ONE data source — the Setup button of a source that says "Setup required", for every driver.
 *
 * The run is the source's own node of its project's setup tree (`POST data_source/<id>/setup`): what its
 * driver needs (a connection to grant, credential values to type), then the driver's setup stages, or
 * Verify when it declares none. Nothing here knows a driver — the tree is derived from what the driver
 * declares. It starts on open (a run already going is joined), draws each question in place, and closes
 * itself once the run it followed ends with everything set up.
 */
export function SourceSetupDialog({ source, onClose }: { source: DataSource; onClose: () => void }) {
  const { t } = useLingui();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <SteppedDialogContent
        data-testid="source-setup-dialog"
        crumbs={[{ label: source.name || source.provider }, { label: t`Setup` }]}
      >
        <SourceSetupPanel source={source} onDone={onClose} />
      </SteppedDialogContent>
    </Dialog>
  );
}

/** The one mount of the dialog (`App`): whatever source `openSourceSetup()` was last called with. */
export function SourceSetupDialogRoot() {
  const { payload, setOpen } = useSourceSetupStore();
  // Closing clears the payload, so a mounted dialog is an open one.
  return payload && <SourceSetupDialog source={payload.source} onClose={() => setOpen(false)} />;
}

/** The first sign-in the tree is stuck on — a `connection:<provider>` node not set up — or null. */
export function pendingConnection(
  tree: SetupTreeResult | null,
  needs: SetupNeed[] = [],
): { provider: string; title: string } | null {
  const walk = (node: SetupNodeResult | null): SetupNodeResult | null => {
    if (!node) return null;
    for (const child of node.children) {
      const found = walk(child);
      if (found) return found;
    }
    return node.id.startsWith('connection:') && node.state !== 'done' && node.state !== 'skipped' ? node : null;
  };
  const node = walk(tree?.root ?? null);
  if (!node) return null;
  const provider = node.id.slice('connection:'.length);
  // The source names the sign-in it waits on (`setup_needs`); the node's label is only the fallback.
  const title = needs.find((n) => n.name === provider)?.title || node.label.replace(/ sign-in$/, '') || provider;
  return { provider, title };
}

/**
 * Set up one source in place: a question it is waiting on (a sign-in, or a value) drawn first, then its tree.
 * `lead`: say what the person is looking at — the add dialog's "X is added. It needs one thing from you…".
 */
export function SourceSetupPanel({
  source,
  onDone,
  lead = false,
  onListening,
}: {
  source: DataSource;
  onDone: () => void;
  lead?: boolean;
  /** Told when the run this screen watched ends with everything set up — the host's footer turns to Done. */
  onListening?: (listening: boolean) => void;
}) {
  const { t } = useLingui();
  const setup = useSourceSetupRun(source);
  const { start, running, tree } = setup;
  // Why the run could not even start (a source no project holds) — the server's own sentence.
  const [refused, setRefused] = useState('');
  const followed = useRef(false);
  const begun = useRef(false);

  const begin = () => {
    setRefused('');
    void start().catch((e: unknown) => setRefused(errorMessage(e, t`Setup could not start.`)));
  };

  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    begin();
    // Once per open: `begin` is rebuilt every render and must not restart the run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on the end of a run this screen watched — never on the tree an earlier run left behind.
  // In the add dialog (`lead`) it stays open on "listening" — the person presses Done.
  useEffect(() => {
    if (running) followed.current = true;
    else if (followed.current && tree?.state === 'done' && !lead) onDone();
  }, [running, tree, onDone, lead]);

  const stopped = !running && !setup.starting && tree !== null && tree.state !== 'done';
  // A sign-in the run stopped on: the person signs in HERE, in their browser; the run only checked it.
  const signIn = !running && !setup.starting ? pendingConnection(tree, source.setup_needs) : null;
  const [connecting, setConnecting] = useState(false);
  const name = source.name || source.provider;
  const connect = async () => {
    if (!signIn) return;
    setConnecting(true);
    try {
      await oauthService.connect(signIn.provider);
    } catch (e: unknown) {
      setConnecting(false);
      setRefused(errorMessage(e, t`Could not start the ${signIn.title} sign-in.`));
    }
  };
  // The grant landed (code flow, device flow, or a grant the hub already held): set up again — the
  // connection now checks out and the walk goes on to the source's own Verify.
  useOAuthFlowComplete(
    signIn?.provider ?? '',
    (msg) => {
      setConnecting(false);
      if (msg.status === OAuthStatus.SUCCESS) begin();
    },
    !!signIn,
  );
  const done = !running && tree?.state === 'done';
  useEffect(() => onListening?.(done), [done, onListening]);

  return (
    <div className="flex flex-col gap-4" data-testid="source-setup-panel">
      {lead && !done && (
        <p className="text-sm text-foreground" data-testid="source-setup-lead">
          {signIn ? (
            <Trans>
              {name} is added. It needs <span className="font-medium">one thing from you</span> before it can
              bring messages in.
            </Trans>
          ) : (
            <Trans>{name} is added. Setting it up…</Trans>
          )}
        </p>
      )}
      {lead && done && (
        <div
          className="flex items-center gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-foreground"
          data-testid="source-setup-listening"
        >
          <CheckCircle2 className="size-4 text-emerald-600" />
          <Trans>{name} is listening.</Trans>
        </div>
      )}
      {signIn && (
        <div className="rounded border p-3" data-testid="source-setup-sign-in">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-base font-medium">
                <Trans>Sign in to {signIn.title}</Trans>
              </h1>
              <p className="text-sm text-muted-foreground">
                <Trans>
                  So {name} can read your {signIn.title} messages and send your replies as you. You stay signed in.
                </Trans>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void connect()} disabled={connecting} data-testid="source-setup-connect">
                <Trans>Connect {signIn.title}</Trans>
              </Button>
              {connecting && (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <Trans>Waiting for you to approve on {signIn.title}…</Trans>
                </span>
              )}
            </div>
          </div>
        </div>
      )}
      {(running || setup.starting) && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="source-setup-running">
          <Loader2 className="size-4 animate-spin" />
          <Trans>Setting things up</Trans>
        </div>
      )}
      {refused && (
        <p
          className="rounded border-l-2 border-red-500 bg-red-500/15 px-3 py-2 text-sm text-foreground"
          data-testid="source-setup-refused"
        >
          {refused}
        </p>
      )}
      {setup.questionId && (
        <div className="rounded border p-3" data-testid="source-setup-question">
          <AskForm questionId={setup.questionId} showOp={false} onSettled={setup.settleQuestion} />
        </div>
      )}
      <SetupTreeView tree={tree} waiting={signIn ? `connection:${signIn.provider}` : ''} />
      {(stopped || refused) && !signIn && (
        <div>
          <Button data-testid="source-setup-retry" onClick={begin}>
            <Trans>Set up again</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}

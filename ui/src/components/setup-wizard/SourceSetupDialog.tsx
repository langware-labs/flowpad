import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { DataSource } from '@sdk';
import { Loader2 } from 'lucide-react';
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

function SourceSetupPanel({ source, onDone }: { source: DataSource; onDone: () => void }) {
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
  useEffect(() => {
    if (running) followed.current = true;
    else if (followed.current && tree?.state === 'done') onDone();
  }, [running, tree, onDone]);

  const stopped = !running && !setup.starting && tree !== null && tree.state !== 'done';

  return (
    <div className="flex flex-col gap-4" data-testid="source-setup-panel">
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
      <SetupTreeView tree={tree} />
      {(stopped || refused) && (
        <div>
          <Button data-testid="source-setup-retry" onClick={begin}>
            <Trans>Set up again</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}

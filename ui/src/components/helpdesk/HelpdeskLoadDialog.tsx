import { helpdeskEnsure, helpdeskRefresh, systemTools } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { StepList } from '@src/components/ui/step-list';
import { useStepFlow } from '@src/hooks/use-step-flow';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { errorMessage, errorStatus } from '@src/lib/error-message';
import { Trans, useLingui } from '@lingui/react/macro';
import { LifeBuoy } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';

/**
 * Opens the help desk, showing the work as a checked-steps list.
 *
 * The portal is a git repo the desk publishes, so "open the help desk" is not a
 * single navigation — it may have to clone, and should pull and index before
 * the content is trustworthy. Each step is one backend call, sequenced by
 * {@link useStepFlow}; a failure stops the chain and leaves its message on the
 * row so the user can see WHICH part failed (a spinner that silently gives up
 * is the thing this replaces).
 *
 * Steps run on open. On success we navigate to the portal project's home and
 * close; on failure the dialog stays put with a Retry.
 */

type HelpdeskStepId = 'check' | 'fetch' | 'index' | 'open';

const STEP_IDS: readonly HelpdeskStepId[] = ['check', 'fetch', 'index', 'open'];

interface HelpdeskLoadDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * The desk answers tickets but publishes no portal to browse, so there is
   * nothing to load — hand off to the ticket flow instead of showing a
   * checklist or an error. Also fires against any hub predating the portal
   * field, which is what keeps this button working on an un-upgraded hub.
   */
  onNoPortal: () => void;
}

export function HelpdeskLoadDialog({ open, onClose, onNoPortal }: HelpdeskLoadDialogProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  const labels: Record<HelpdeskStepId, string> = useMemo(() => ({
    check: t`Checking the help desk files`,
    fetch: t`Fetching the latest`,
    index: t`Indexing`,
    open: t`Opening the help desk`,
  }), [t]);

  const { steps, busy, run, patch, reset, runAll } = useStepFlow<HelpdeskStepId>(STEP_IDS, labels);
  const failed = steps.some((s) => s.status === 'error');

  const load = useCallback(async () => {
    reset();
    const { ok, value } = await runAll<'handed-off' | 'opened'>(async () => {
      // A — the checkout exists (clone on first run). Idempotent, so a repeat
      // open is cheap and reports "already present".
      const ensured = await run('check', async () => {
        const res = await helpdeskEnsure();
        patch('check', {
          detail: !res.has_portal ? t`no guides published` : res.cloned ? t`cloned` : t`already present`,
        });
        return res;
      });

      // No portal → nothing to fetch, index, or navigate to. Hand off to the
      // ticket flow: the desk still answers questions, which is what the user
      // clicked for. NOT an error — see `onNoPortal`.
      //
      // `=== false`, not `!has_portal`: a backend older than this build omits
      // the field entirely, and treating `undefined` as "no portal" would
      // degrade every user to the ticket flow even where a portal exists. Only
      // an explicit false means no portal; `project_id` (which old backends do
      // send) carries the rest.
      if (ensured.has_portal === false || !ensured.project_id) {
        onNoPortal();
        return 'handed-off';
      }
      const portalProjectId = ensured.project_id;

      // B — pull. Non-fatal by design: stale-but-present help content still
      // beats refusing to open the desk because the network is down.
      const pulled = await run('fetch', async () => {
        // A clone lands at origin's tip by definition, so pulling now is a
        // guaranteed no-op that still pays a subprocess + network round trip —
        // on the first open, already the slowest path.
        if (ensured.cloned) {
          patch('fetch', { detail: t`just cloned` });
          return false;
        }
        try {
          const res = await helpdeskRefresh();
          patch('fetch', { detail: res.message });
          return res.updated;
        } catch (e) {
          patch('fetch', { detail: errorMessage(e, t`could not fetch — showing local copy`) });
          // Unknown whether the remote moved — assume it did, so a failed pull
          // can never leave the index permanently behind the working tree.
          return true;
        }
      });
      const contentChanged = ensured.cloned || pulled;

      // C — index, but ONLY when there is something new to index.
      //
      // A no-op scoped index costs ~2.5-5s: it re-walks the 4 portal files,
      // skips all of them as fresh, and then spends the whole budget on an
      // orphan sweep over the WHOLE store (~1200 entities) that has nothing to
      // do with the help desk. On a repeat open where we neither cloned nor
      // pulled anything, the working tree is byte-identical to what was already
      // indexed, so that entire cost buys nothing — this is removing dead work,
      // not hiding slowness behind a wait.
      //
      // `never_indexed` is still consulted so the skip self-heals: if an
      // earlier pass lost the index race (409 below) or failed outright, the
      // next open indexes rather than skipping forever.
      await run('index', async () => {
        if (!contentChanged && !(await systemTools.projectNeverIndexed(portalProjectId))) {
          patch('index', { detail: t`up to date` });
          return;
        }
        // 409 = "an index is already running" and is EXPECTED, not a failure:
        // creating the portal Project in step A schedules a project-scoped
        // auto-index, and these steps fire back-to-back, so this call can lose
        // the single-flight race to it. That auto run covers the same subtree,
        // and the backend's own auto path treats identical contention as a
        // silent skip. Only 409 is absorbed; any other status still fails.
        try {
          await systemTools.fastScanProject(portalProjectId);
        } catch (e) {
          if (errorStatus(e) !== 409) throw e;
          patch('index', { detail: t`already running` });
        }
      });

      // D — URL-first: navigate and let the project loader do the rest.
      await run('open', () => {
        navigation.openDock(DockPointer.forHelpdesk(portalProjectId));
        return Promise.resolve();
      });
      return 'opened';
    });
    // `runAll` already knows how the pass ended, so read it here rather than
    // re-deriving it from `steps` in a second effect. A failed pass stays on
    // screen with its Retry; a hand-off already opened the ticket dialog.
    if (ok && value === 'opened') onClose();
  }, [navigation, onClose, onNoPortal, patch, reset, run, runAll, t]);

  // Auto-start on open.
  // Intentionally keyed on `open` alone: re-running on every `load` identity
  // change would restart the flow mid-flight.
  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md" data-testid="helpdesk-load-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LifeBuoy className="h-5 w-5 text-violet-600 dark:text-violet-400" />
            {failed ? <Trans>Couldn't open the help desk</Trans> : <Trans>Opening the help desk…</Trans>}
          </DialogTitle>
        </DialogHeader>

        <StepList steps={steps} testId="helpdesk-load-steps" testIdPrefix="helpdesk" />

        {failed && (
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>
              <Trans>Close</Trans>
            </Button>
            <Button onClick={() => void load()} disabled={busy} data-testid="helpdesk-load-retry">
              <Trans>Retry</Trans>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

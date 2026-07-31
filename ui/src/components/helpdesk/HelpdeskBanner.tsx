import { HELPDESK_PORTAL_UNAME, helpdeskReset, type Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DevOnly } from '@src/components/view-mode';
import { notify } from '@src/notifications';
import { Trans, useLingui } from '@lingui/react/macro';
import { LifeBuoy, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { HelpdeskRequestDialog } from './HelpdeskRequestDialog';

/**
 * Header strip on the helpdesk portal's project home.
 *
 * Carries the two affordances that belong to the desk rather than to a generic
 * project: opening a support ticket (the footer's old assistance
 * entry point, which moved here when the two footer buttons collapsed into
 * one), and a dev-only reset.
 *
 * Rendered by ProjectHome only when the project IS the portal checkout, so it
 * costs nothing on ordinary projects.
 */

/** Whether `project` IS the local helpdesk portal checkout.
 *
 *  Read straight off the entity the caller already holds. This deliberately
 *  does NOT ask the backend: the predicate is evaluated on every project home,
 *  for every project, and a round trip there would tax an unrelated surface
 *  (and answer a frame late, popping the banner in) to render nothing on all
 *  but one project. `helpdesk-ensure` stamps the uname for exactly this. */
export function isHelpdeskProject(project?: Pick<Project, 'uname'> | null): boolean {
  return project?.uname === HELPDESK_PORTAL_UNAME;
}

export function HelpdeskBanner() {
  const { t } = useLingui();
  const [askOpen, setAskOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const onReset = async () => {
    setResetting(true);
    try {
      await helpdeskReset();
      notify.success({
        title: t`Help desk files removed`,
        message: t`They will be downloaded again the next time you open the help desk.`,
      });
      setConfirmReset(false);
    } catch (err) {
      notify.error({
        title: t`Could not remove the help desk files`,
        message: errorMessage(err, t`Please try again.`),
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-violet-500/30 bg-violet-500/5 px-4 py-3"
      data-testid="helpdesk-banner"
    >
      <LifeBuoy className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          <Trans>Help desk</Trans>
        </p>
        <p className="text-xs text-muted-foreground">
          <Trans>Browse the guides below, or ask us directly.</Trans>
        </p>
      </div>

      <Button
        size="sm"
        onClick={() => setAskOpen(true)}
        className="bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
        data-testid="helpdesk-ask-button"
      >
        <Trans>Ask for help</Trans>
      </Button>

      {/* reserve={false} so the gap collapses outside dev mode. */}
      <DevOnly reserve={false}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setConfirmReset(true)}
          className="gap-1.5 text-destructive"
          title={t`Delete the local help desk files (dev)`}
          data-testid="helpdesk-delete-button"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <Trans>Delete</Trans>
        </Button>
      </DevOnly>

      <HelpdeskRequestDialog open={askOpen} onClose={() => setAskOpen(false)} />

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={(o: boolean) => !o && setConfirmReset(false)}
        title={t`Delete the local help desk files?`}
        description={t`This removes the downloaded help desk folder and its indexed entries from this machine. Nothing on the server changes, and everything is downloaded again the next time you open the help desk.`}
        confirmLabel={resetting ? t`Deleting…` : t`Delete`}
        onConfirm={() => void onReset()}
        variant="destructive"
      />
    </div>
  );
}

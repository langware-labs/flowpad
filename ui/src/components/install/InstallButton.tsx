import { useLingui } from '@lingui/react/macro';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import type { Project } from '@sdk';
import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { InstallSnippetDialog } from './InstallSnippetDialog';

/**
 * The hub's one-click Install on a published row. Asks the hub to relay the
 * row to the user's logged-in desktop(s); when none is connected, shows the
 * install snippet instead. Nothing is written from the hub.
 */
export function InstallButton({ project, typeid, name }: { project: Project; typeid: string; name: string }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [snippet, setSnippet] = useState(false);

  const click = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const result = await project.requestInstall(typeid);
      if (result.delivered > 0) {
        notify.success({ title: name || typeid, message: t`Sent to your desktop — confirm it there.` });
      } else {
        setSnippet(true);
      }
    } catch (error) {
      notify.error({ title: t`Could not send the install`, message: errorMessage(error, t`The hub did not accept the request.`) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => void click(e)}
        disabled={busy}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
        data-testid="install-button"
        title={t`Install this asset on your desktop`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
        {t`Install`}
      </button>
      <InstallSnippetDialog open={snippet} onOpenChange={setSnippet} />
    </>
  );
}

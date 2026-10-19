import type { Agent } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * Publish this computer's edits of `agent` into its project's hub repo (`agent.publish({force: true})`),
 * then `onPublished` — called after a refusal too, so the caller re-reads the version either way.
 *
 * The one publish control: the deploy checklist's version row and the Sharing section both render it.
 */
export function AgentPublishButton({
  agent,
  onPublished,
  className,
  testId,
}: {
  agent: Agent;
  onPublished?: () => void | Promise<void>;
  className?: string;
  testId: string;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);

  const publish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await agent.publish({ force: true });
      notify.success({ title: t`Published` });
    } catch (error) {
      notify.error({
        title: t`Could not publish`,
        message: errorMessage(error, t`Publish failed.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
      await onPublished?.();
    }
  };

  return (
    <Button size="sm" className={className} disabled={busy} onClick={() => void publish()} data-testid={testId}>
      {busy && <Loader2 className="me-1 h-3 w-3 animate-spin" />}
      {t`Publish`}
    </Button>
  );
}

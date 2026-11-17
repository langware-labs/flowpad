/**
 * The message classifier's page: the one automation that gives each arriving message its tag.
 *
 *   IF a message arrives → THEN classify it under [stream_inbox]
 *
 * It is Flowpad's own rule, so there is nothing to build here: a switch (classify arrivals or not) and
 * the way to the tag tree, which is where what it does is decided. No delete, no JSON, no try list.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft, Tags } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { useClassificationSettings } from '@src/components/tags/MessageTags';
import { useAutomation, useAutomationTrigger, useSetAutomationEnabled } from '@src/hooks/automations/useAutomations';
import { errorMessage } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { canSwitch } from './AutomationRow';
import { useAutomationWords } from './automation-words';
import { IfThenLine } from './IfThenLine';

export function ClassifierPage({ triggerId }: { triggerId: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const words = useAutomationWords();
  const { automation } = useAutomation(triggerId, { poll: false });
  const trigger = useAutomationTrigger(triggerId).data;
  const setEnabled = useSetAutomationEnabled();
  const { root } = useClassificationSettings();
  // While the change is on its way the switch shows what was asked; then the list's own answer.
  const enabled = (setEnabled.isPending ? setEnabled.variables?.enabled : automation?.enabled) ?? trigger?.enabled ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="classifier-page" data-automation-id={triggerId}>
      <header className="flex items-center gap-3 border-b border-border px-6 pb-3 pt-4">
        <button
          type="button"
          onClick={() => navigation.openDock(DockPointer.forAutomations())}
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="automation-back"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          <Trans>Automations</Trans>
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{automation?.name || trigger?.name}</h2>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={enabled}
            disabled={setEnabled.isPending || (!!automation && !canSwitch(automation))}
            onCheckedChange={(on) =>
              setEnabled.mutate(
                { triggerId, enabled: on },
                {
                  onError: (e) => notify.error({ title: t`Could not change it`, message: errorMessage(e, t`It did not work`), forceToast: true }),
                },
              )
            }
            aria-label={enabled ? t`Turn off` : t`Turn on`}
            data-testid="classifier-enabled"
          />
          <Trans>Enabled</Trans>
        </label>
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-start gap-4 overflow-auto px-6 py-5">
        <IfThenLine when={words.classifier.when} then={words.classifier.under(root)} />
        <p className="max-w-xl text-sm text-muted-foreground">
          <Trans>Each new incoming message gets one tag from your tag tree, or none when nothing fits. A tag can start automations.</Trans>
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => navigation.openDock(DockPointer.forTagGraph(null, { carry: { manage: 'stream_inbox' } }))}
          data-testid="classifier-edit-tags"
        >
          <Tags className="size-4" aria-hidden />
          <Trans>Edit tags</Trans>
        </Button>
      </div>
    </div>
  );
}

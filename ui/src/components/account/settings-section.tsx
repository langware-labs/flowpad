import { ActionInfo, dataContext, dataManager, QueryRequest, Wizard, type WizardResult } from '@sdk';
import apiClient from '@sdk/client';
import { SettingsCard, SettingRow } from '@src/components/settings/settings-card';
import { Button } from '@src/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Switch } from '@src/components/ui/switch';
import { setDev, useIsDev } from '@src/components/view-mode';
import { notify } from '@src/notifications';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** The shipped wizard that first-run setup runs (its `name`, see `LLM_SETUP_WIZARD` on the backend). */
const FIRST_RUN_WIZARD = 'llm-setup';

// Per-user UI preferences (show system skills, terminal, sound, …) now live in
// the dedicated Preferences screen (ViewType.PREFERENCES, registry-driven). This
// section keeps only the non-preference account/instance controls.
export function SettingsSection() {
  const [cliLogLevel, setCliLogLevel] = useState('info');
  const isDev = useIsDev();
  const { t } = useLingui();

  const { data: onboarding, refetch: refetchOnboarding } = useQuery({
    queryKey: ['onboarding-status'],
    queryFn: () => apiClient.get<{ onboarded: boolean }>('/api/v1/onboarding/status'),
    // Only changes via the Reset button below, which refetches explicitly.
    staleTime: Infinity,
  });
  const onboardingStatus = !onboarding ? '…' : onboarding.onboarded ? 'completed' : 'not completed';
  const [resettingOnboarding, setResettingOnboarding] = useState(false);
  const handleResetOnboarding = useCallback(async () => {
    setResettingOnboarding(true);
    try {
      await apiClient.post('/api/v1/onboarding/reset');
      await refetchOnboarding();
      notify.success({ title: t`Onboarding reset`, message: t`Welcome bookmark + feed entry re-created.` });
    } catch (err) {
      notify.error({ title: t`Reset failed`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setResettingOnboarding(false);
    }
  }, [refetchOnboarding, t]);

  // First-run setup, again: opens its popup blank. Nothing runs until the person presses the
  // popup's own Start — the same order the first-run trigger keeps — so its install questions
  // never land on top of a popup that has not been read yet.
  const [runningSetup, setRunningSetup] = useState(false);
  const handleRunSetup = useCallback(async () => {
    setRunningSetup(true);
    window.dispatchEvent(new Event('close-account-dialog'));
    try {
      // The shipped first-run wizard, found by its name; its `open` action shows the popup blank.
      const [setup] = await dataManager.query<Wizard>(
        new QueryRequest({ type: Wizard.type, query: { name: FIRST_RUN_WIZARD } }),
      );
      if (!setup) throw new Error(t`The setup wizard is not installed.`);
      await setup.open();
    } catch (err) {
      notify.error({
        title: t`Could not open setup`,
        message: err instanceof Error ? err.message : String(err),
        forceToast: true,
      });
    } finally {
      setRunningSetup(false);
    }
  }, [t]);

  // TEMPORARY — DEBUG ONLY, for testing the `llm-setup` wizard end to end.
  // Remove this button and handler once that work ships — see FLOWPAD-2171.
  const [removingTools, setRemovingTools] = useState(false);
  const handleRemoveTools = useCallback(async () => {
    setRemovingTools(true);
    try {
      // The route also runs the wizard right after removing — the wizard
      // page's icons are its LAST COMPLETED run's record, not a live check, so
      // without that this button would remove tools and leave everything
      // showing exactly as green as before.
      const answer = await apiClient.post<{ removed: string[]; not_found: string[]; wizard: WizardResult | null }>(
        '/api/v1/onboarding/debug/remove-tools',
      );
      notify.success({
        title: t`Tools removed, wizard re-checked`,
        message: t`removed: ${answer.removed.join(', ') || '–'} · not found: ${answer.not_found.join(', ') || '–'}`,
      });
    } catch (err) {
      notify.error({ title: t`Could not remove tools`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRemovingTools(false);
    }
  }, [t]);

  const computeNode = dataContext.computeNode;

  useEffect(() => {
    if (!computeNode?.typeId?.id) return;
    const action = new ActionInfo('fs-records', 'compute_node', computeNode.typeId.id, 'GET');
    action.subpath = 'cli_log_settings/local';
    void dataManager
      .callAction<unknown, { level?: string }>(action)
      .then((data) => {
        if (data?.level) setCliLogLevel(data.level);
      })
      .catch(() => {});
  }, [computeNode?.typeId?.id]);

  const handleLevelChange = useCallback(
    (level: string) => {
      if (!computeNode?.typeId?.id) return;
      setCliLogLevel(level);
      const action = new ActionInfo('fs-records', 'compute_node', computeNode.typeId.id, 'PUT');
      action.subpath = 'cli_log_settings/local';
      action.bodyParameters = { level };
      action.queryParameters = { _: '1' };
      void dataManager.callAction(action).catch(() => {});
    },
    [computeNode?.typeId?.id],
  );

  return (
    <SettingsCard>
      <SettingRow
        htmlFor="dev-mode"
        label={<Trans>Dev mode</Trans>}
        description={<Trans>Surface developer-only views and controls across the app.</Trans>}
        control={<Switch id="dev-mode" checked={isDev} onCheckedChange={setDev} />}
      />

      <SettingRow
        label={<Trans>Onboarding</Trans>}
        description={<Trans>Welcome bookmark + feed entry, seeded on first run. Status: {onboardingStatus}</Trans>}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleResetOnboarding()}
            disabled={resettingOnboarding}
          >
            {resettingOnboarding ? <Trans>Resetting…</Trans> : <Trans>Reset</Trans>}
          </Button>
        }
      />

      <SettingRow
        label={<Trans>Setup</Trans>}
        description={
          <Trans>Connect an LLM source, then install the tools Flowpad needs. Runs once on first launch.</Trans>
        }
        control={
          // Stacked, so the description on the left keeps its width instead of wrapping word by word.
          <div className="flex flex-col items-stretch gap-2">
            <Button size="sm" variant="outline" onClick={() => void handleRunSetup()} disabled={runningSetup}>
              {runningSetup ? <Trans>Running…</Trans> : <Trans>Run setup again</Trans>}
            </Button>
            {/* TEMPORARY DEBUG BUTTON, Dev mode only — remove before shipping, see FLOWPAD-2171. */}
            {isDev && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleRemoveTools()}
                disabled={removingTools}
                title="DEV ONLY — actually uninstalls jq/rg/claude/python(3)/git/node (brew uninstall, or deletes the binary), then re-runs the wizard so its page reflects the new state. Remove this button before shipping."
              >
                {removingTools ? <Trans>Resetting…</Trans> : <Trans>Reset</Trans>}
              </Button>
            )}
          </div>
        }
      />

      <SettingRow
        htmlFor="cli-log-level"
        label={<Trans>CLI Log Level</Trans>}
        description={<Trans>Debug level includes hook invocations.</Trans>}
        control={
          <Select value={cliLogLevel} onValueChange={handleLevelChange}>
            <SelectTrigger id="cli-log-level" className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="info">
                <Trans>Info</Trans>
              </SelectItem>
              <SelectItem value="debug">
                <Trans>Debug</Trans>
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SettingsCard>
  );
}

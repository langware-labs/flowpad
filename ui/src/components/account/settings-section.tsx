import { ActionInfo, dataContext, dataManager, isOk, type ReturnedValue, type WizardResult } from '@sdk';
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

  // First-run setup, run on demand from the top: an LLM source, then the `llm-setup` wizard.
  // Its trigger fires once per machine; this is the way to run it again. The backend runs both,
  // in the same order the trigger does.
  const [runningSetup, setRunningSetup] = useState(false);
  const handleRunSetup = useCallback(async () => {
    setRunningSetup(true);
    // Close the dialog right away, not once setup finishes: the wizard raises
    // its own questions and popups as it runs, and this dialog sitting on top
    // of them is exactly what "run setup again" should get out of the way of.
    window.dispatchEvent(new Event('close-account-dialog'));
    try {
      const answer = await apiClient.post<{ llm_source: ReturnedValue; wizard: WizardResult }>(
        '/api/v1/onboarding/setup',
      );
      const missing = [
        ...(isOk(answer.llm_source) ? [] : [t`LLM source`]),
        ...(isOk(answer.wizard) ? [] : [answer.wizard.detail || t`some tools`]),
      ];
      if (missing.length === 0) notify.success({ title: t`Setup finished`, message: t`Everything is in place.` });
      // The person just clicked and is waiting: this is the only word they get (`forceToast`).
      else
        notify.error({ title: t`Setup did not finish`, message: t`Not done: ${missing.join('; ')}`, forceToast: true });
    } catch (err) {
      notify.error({
        title: t`Setup did not finish`,
        message: err instanceof Error ? err.message : String(err),
        forceToast: true,
      });
    } finally {
      setRunningSetup(false);
    }
  }, [t]);

  // TEMPORARY — DEBUG ONLY, for testing the `llm-setup` wizard end to end.
  // Remove this button and handler once that work ships — see FLOWPAD-2171.
  const [hidingTools, setHidingTools] = useState(false);
  const handleHideTools = useCallback(async () => {
    setHidingTools(true);
    try {
      const answer = await apiClient.post<{ hidden: string[]; already_hidden: string[]; not_found: string[] }>(
        '/api/v1/onboarding/debug/hide-tools',
      );
      notify.success({
        title: t`Tools hidden`,
        message: t`hidden: ${answer.hidden.join(', ') || '–'} · already hidden: ${answer.already_hidden.join(', ') || '–'} · not found: ${answer.not_found.join(', ') || '–'}`,
      });
    } catch (err) {
      notify.error({ title: t`Could not hide tools`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setHidingTools(false);
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
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void handleRunSetup()} disabled={runningSetup}>
              {runningSetup ? <Trans>Running…</Trans> : <Trans>Run setup again</Trans>}
            </Button>
            {/* TEMPORARY DEBUG BUTTON — remove before shipping, see FLOWPAD-2171. */}
            <Button
              size="sm"
              onClick={() => void handleHideTools()}
              disabled={hidingTools}
              className="border-orange-500 bg-orange-500 text-white hover:bg-orange-600 hover:text-white"
              title="DEBUG ONLY — renames jq/rg/claude/python(3)/git/node off PATH (never uninstalls) so the wizard treats them as freshly missing. Remove this button before shipping."
            >
              {hidingTools ? <Trans>Hiding…</Trans> : <Trans>DEBUG: hide 6 tools</Trans>}
            </Button>
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

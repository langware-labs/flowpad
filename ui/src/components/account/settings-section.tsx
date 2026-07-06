import { ActionInfo, dataContext, dataManager } from '@sdk';
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
        description={
          <Trans>Welcome bookmark + feed entry, seeded on first run. Status: {onboardingStatus}</Trans>
        }
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
        htmlFor="cli-log-level"
        label={<Trans>CLI Log Level</Trans>}
        description={<Trans>Debug level includes hook invocations.</Trans>}
        control={
          <Select value={cliLogLevel} onValueChange={handleLevelChange}>
            <SelectTrigger id="cli-log-level" className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="info"><Trans>Info</Trans></SelectItem>
              <SelectItem value="debug"><Trans>Debug</Trans></SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SettingsCard>
  );
}

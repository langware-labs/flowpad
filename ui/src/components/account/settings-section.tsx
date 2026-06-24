import { useInstancePreferences } from '@sdk/react/hooks/use-instance-preferences';
import { ActionInfo, dataContext, dataManager, TerminalType } from '@sdk';
import apiClient from '@sdk/client';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Label } from '@src/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@src/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Switch } from '@src/components/ui/switch';
import { setDev, useIsDev } from '@src/components/view-mode';
import { notify } from '@src/notifications';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

export function SettingsSection() {
  const { preferences } = useInstancePreferences();
  const [cliLogLevel, setCliLogLevel] = useState('info');
  const isDev = useIsDev();

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
      notify.success({ title: 'Onboarding reset', message: 'Welcome bookmark + feed entry re-created.' });
    } catch (err) {
      notify.error({ title: 'Reset failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setResettingOnboarding(false);
    }
  }, [refetchOnboarding]);

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
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="dev-mode" className="cursor-pointer text-sm">
          Dev mode
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
            Surface developer-only views and controls across the app.
          </span>
        </Label>
        <Switch
          id="dev-mode"
          checked={isDev}
          onCheckedChange={setDev}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm">
          Onboarding
          <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
            Welcome bookmark + feed entry, seeded on first run. Status: {onboardingStatus}
          </span>
        </Label>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleResetOnboarding()}
          disabled={resettingOnboarding}
        >
          {resettingOnboarding ? 'Resetting…' : 'Reset'}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="show-system-skills"
          checked={preferences.showSystemSkills}
          onCheckedChange={(checked) => {
            preferences.showSystemSkills = checked === true;
          }}
        />
        <Label htmlFor="show-system-skills" className="cursor-pointer text-sm">
          Show system skills
        </Label>
      </div>

      <div>
        <Label className="mb-2 block text-sm font-medium">External Terminal</Label>
        <p className="mb-2 text-xs text-muted-foreground">
          The in-app terminal is always the primary shell. This setting controls whether a
          sidecar OS Terminal window is also opened.
        </p>
        <RadioGroup
          value={preferences.defaultTerminal}
          onValueChange={(value) => {
            preferences.defaultTerminal = value as TerminalType;
          }}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value={TerminalType.BUILTIN_XTERM} id="terminal-builtin" />
            <Label htmlFor="terminal-builtin" className="cursor-pointer text-sm">
              In-app only
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value={TerminalType.EXTERNAL_TERMINAL} id="terminal-external" />
            <Label htmlFor="terminal-external" className="cursor-pointer text-sm">
              Also open sidecar OS Terminal
            </Label>
          </div>
        </RadioGroup>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="buffer-sync-updates"
          checked={preferences.bufferSyncUpdates}
          onCheckedChange={(checked) => {
            preferences.bufferSyncUpdates = checked === true;
          }}
        />
        <Label htmlFor="buffer-sync-updates" className="cursor-pointer text-sm">
          Buffer terminal sync updates (prevents scroll jumps)
        </Label>
      </div>

      <div>
        <Label className="mb-2 block text-sm font-medium">CLI Log Level</Label>
        <Select value={cliLogLevel} onValueChange={handleLevelChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">
          Debug level includes hook invocations.
        </p>
      </div>
    </div>
  );
}

import { useSettings } from '@sdk/react/hooks/use-settings';
import { ActionInfo, dataContext, dataManager, TerminalType } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Label } from '@src/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@src/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { LogIn } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

export function SettingsSection() {
  const { settings } = useSettings();
  const [cliLogLevel, setCliLogLevel] = useState('info');

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
      <div className="flex items-center gap-2">
        <Checkbox
          id="show-system-skills"
          checked={settings.showSystemSkills}
          onCheckedChange={(checked) => {
            settings.showSystemSkills = checked === true;
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
          value={settings.defaultTerminal}
          onValueChange={(value) => {
            settings.defaultTerminal = value as TerminalType;
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

      <div>
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('close-account-dialog'));
            window.dispatchEvent(new CustomEvent('open-desktop-setup'));
          }}
        >
          <LogIn className="h-4 w-4" />
          Login to Anthropic
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="buffer-sync-updates"
          checked={settings.bufferSyncUpdates}
          onCheckedChange={(checked) => {
            settings.bufferSyncUpdates = checked === true;
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

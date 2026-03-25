import { AgentHook, Trigger, HookScope, AgentProvider, HookEventType } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import { ErrorMessage } from './constants';
import { useState, useEffect } from 'react';

interface HookFormProps {
  hook: AgentHook | null;
  triggers: Trigger[];
  onSave: (hook: AgentHook) => void;
  onCancel: () => void;
}

export function HookForm({ hook, onSave, onCancel }: HookFormProps) {
  const [formData, setFormData] = useState<Partial<AgentHook>>({
    name: '',
    description: '',
    provider: AgentProvider.CLAUDE_CODE,
    hook_scope: HookScope.USER,
    event: HookEventType.USER_PROMPT_SUBMIT,
    command: '',
    matcher: undefined,
    enabled: true,
  });

  const [matcherJson, setMatcherJson] = useState('');
  const [matcherError, setMatcherError] = useState('');

  useEffect(() => {
    if (hook) {
      setFormData({
        name: hook.name,
        description: hook.description,
        provider: hook.provider,
        hook_scope: hook.hook_scope,
        event: hook.event,
        command: hook.command,
        matcher: hook.matcher,
        enabled: hook.enabled,
      });
      setMatcherJson(hook.matcher ? JSON.stringify(hook.matcher, null, 2) : '');
    }
  }, [hook]);

  const handleChange = (field: keyof AgentHook, value: unknown) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleMatcherChange = (value: string) => {
    setMatcherJson(value);
    setMatcherError('');

    if (!value.trim()) {
      handleChange('matcher', undefined);
      return;
    }

    try {
      const parsed = JSON.parse(value);
      handleChange('matcher', parsed as Record<string, unknown> | undefined);
    } catch {
      setMatcherError(ErrorMessage.INVALID_JSON);
    }
  };

  const handleSave = () => {
    if (matcherError) {
      return;
    }

    const hookToSave = hook || new AgentHook();
    Object.assign(hookToSave, formData);
    onSave(hookToSave);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{hook ? 'Edit Agent Hook' : 'Create Agent Hook'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="Enter hook name"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formData.description || ''}
              onChange={(e) => handleChange('description', e.target.value)}
              placeholder="Enter hook description"
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider">Provider</Label>
            <Select value={formData.provider} onValueChange={(value) => handleChange('provider', value)}>
              <SelectTrigger id="provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AgentProvider.CLAUDE_CODE}>Claude Code</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scope">Scope *</Label>
            <Select value={formData.hook_scope} onValueChange={(value) => handleChange('hook_scope', value)}>
              <SelectTrigger id="scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HookScope.USER}>User</SelectItem>
                <SelectItem value={HookScope.PROJECT}>Project</SelectItem>
                <SelectItem value={HookScope.LOCAL}>Local</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="event">Event *</Label>
            <Select value={formData.event} onValueChange={(value) => handleChange('event', value)}>
              <SelectTrigger id="event">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HookEventType.USER_PROMPT_SUBMIT}>User Prompt Submit</SelectItem>
                <SelectItem value={HookEventType.PRE_TOOL_USE}>Pre Tool Use</SelectItem>
                <SelectItem value={HookEventType.POST_TOOL_USE}>Post Tool Use</SelectItem>
                <SelectItem value={HookEventType.SESSION_START}>Session Start</SelectItem>
                <SelectItem value={HookEventType.STOP}>Stop</SelectItem>
                <SelectItem value={HookEventType.NOTIFICATION}>Notification</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="command">Command</Label>
            <Input
              id="command"
              value={formData.command || ''}
              onChange={(e) => handleChange('command', e.target.value)}
              placeholder="Command to execute (optional for trace-only hooks)"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="matcher">Matcher (JSON)</Label>
            <Textarea
              id="matcher"
              value={matcherJson}
              onChange={(e) => handleMatcherChange(e.target.value)}
              placeholder='{"tool_name": "Read"}'
              rows={4}
              className="font-mono text-xs"
            />
            {matcherError && <p className="text-sm text-destructive">{matcherError}</p>}
          </div>

          <div className="flex items-center space-x-2">
            <Switch
              id="enabled"
              checked={formData.enabled}
              onCheckedChange={(checked) => handleChange('enabled', checked)}
            />
            <Label htmlFor="enabled">Enabled</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!!matcherError}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

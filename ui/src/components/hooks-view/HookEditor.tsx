import { Button } from '@src/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@src/components/ui/card';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Separator } from '@src/components/ui/separator';
import { Textarea } from '@src/components/ui/textarea';
import { Save, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';

const HOOK_EVENTS = {
  PreToolUse: { title: 'Pre Tool Use', supportsMatchers: true, icon: '⚡' },
  PostToolUse: { title: 'Post Tool Use', supportsMatchers: true, icon: '✅' },
  PermissionRequest: { title: 'Permission Request', supportsMatchers: true, icon: '🔐' },
  UserPromptSubmit: { title: 'User Prompt Submit', supportsMatchers: false, icon: '💬' },
  Stop: { title: 'Stop', supportsMatchers: false, icon: '🛑' },
  SubagentStop: { title: 'Subagent Stop', supportsMatchers: false, icon: '🤖' },
  SessionStart: { title: 'Session Start', supportsMatchers: true, icon: '🚀' },
  SessionEnd: { title: 'Session End', supportsMatchers: false, icon: '🏁' },
  Notification: { title: 'Notification', supportsMatchers: true, icon: '🔔' },
  PreCompact: { title: 'Pre Compact', supportsMatchers: true, icon: '📦' },
} as const;

const HOOK_EVENT_OPTIONS = Object.entries(HOOK_EVENTS).map(([key, meta]) => ({
  value: key,
  label: `${meta.icon} ${meta.title}`,
}));

interface HookEditorProps {
  isEditing: boolean;
  hookName: string;
  eventName: string;
  matcher: string;
  hookType: 'command' | 'prompt';
  command: string;
  prompt: string;
  timeout: string;
  onHookNameChange: (value: string) => void;
  onEventNameChange: (value: string) => void;
  onMatcherChange: (value: string) => void;
  onHookTypeChange: (value: 'command' | 'prompt') => void;
  onCommandChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onTimeoutChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function HookEditor({
  isEditing,
  hookName,
  eventName,
  matcher,
  hookType,
  command,
  prompt,
  timeout,
  onHookNameChange,
  onEventNameChange,
  onMatcherChange,
  onHookTypeChange,
  onCommandChange,
  onPromptChange,
  onTimeoutChange,
  onSave,
  onCancel,
}: HookEditorProps) {
  const { t } = useLingui();
  const supportsMatchers = HOOK_EVENTS[eventName as keyof typeof HOOK_EVENTS]?.supportsMatchers ?? false;
  const isSaveDisabled = !eventName || !hookName.trim() || (hookType === 'command' ? !command.trim() : !prompt.trim());

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{isEditing ? <Trans>Edit Hook</Trans> : <Trans>Add New Hook</Trans>}</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              <X className="mr-2 h-4 w-4" />
              <Trans>Cancel</Trans>
            </Button>
            <Button size="sm" onClick={onSave} disabled={isSaveDisabled}>
              <Save className="mr-2 h-4 w-4" />
              {isEditing ? <Trans>Update</Trans> : <Trans>Save</Trans>}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Hook Name */}
        <div className="space-y-2">
          <Label htmlFor="hook-name">
            <Trans>Hook Name *</Trans>
          </Label>
          <Input
            id="hook-name"
            value={hookName}
            onChange={(e) => onHookNameChange(e.target.value)}
            placeholder={t`e.g., "my-pre-tool-guard", "lint-on-save"`}
          />
          <p className="text-xs text-muted-foreground">
            <Trans>Unique identifier for this hook within the settings file.</Trans>
          </p>
        </div>

        <Separator />

        {/* Event Name */}
        <div className="space-y-2">
          <Label htmlFor="event-name">
            <Trans>Hook Event *</Trans>
          </Label>
          <Select value={eventName} onValueChange={onEventNameChange}>
            <SelectTrigger id="event-name">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOOK_EVENT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            <Trans>Select when this hook should run</Trans>
          </p>
        </div>

        <Separator />

        {/* Matcher (conditional) */}
        {supportsMatchers && (
          <div className="space-y-2">
            <Label htmlFor="matcher">
              <Trans>Matcher Pattern (optional)</Trans>
            </Label>
            <Input
              id="matcher"
              value={matcher}
              onChange={(e) => onMatcherChange(e.target.value)}
              placeholder={t`e.g., "Read", "Edit|Write", "*" (leave empty for all tools)`}
            />
            <p className="text-xs text-muted-foreground">
              <Trans>Tool pattern to match: exact name, regex pattern, or "*" for all. Case-sensitive.</Trans>
            </p>
          </div>
        )}

        {supportsMatchers && <Separator />}

        {/* Hook Type */}
        <div className="space-y-2">
          <Label htmlFor="hook-type">
            <Trans>Hook Type *</Trans>
          </Label>
          <Select value={hookType} onValueChange={(v) => onHookTypeChange(v as 'command' | 'prompt')}>
            <SelectTrigger id="hook-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="command">
                <Trans>🔧 Command - Execute bash script</Trans>
              </SelectItem>
              <SelectItem value="prompt">
                <Trans>🤖 Prompt - Query AI (Claude Haiku)</Trans>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Command/Prompt Content */}
        {hookType === 'command' ? (
          <div className="space-y-2">
            <Label htmlFor="command">
              <Trans>Bash Command *</Trans>
            </Label>
            <Textarea
              id="command"
              value={command}
              onChange={(e) => onCommandChange(e.target.value)}
              placeholder={t`e.g., /path/to/script.sh or if [[ "$tool_input" == *.md ]]; then echo '{"permissionDecision": "allow"}'; fi`}
              className="min-h-[120px] font-mono text-sm"
              rows={6}
            />
            <p className="text-xs text-muted-foreground">
              <Trans>Shell command to execute. Use $CLAUDE_PROJECT_DIR, $tool_name, $tool_input variables.</Trans>
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="prompt">
              <Trans>AI Prompt *</Trans>
            </Label>
            <Textarea
              id="prompt"
              value={prompt}
              onChange={(e) => onPromptChange(e.target.value)}
              placeholder={t`Should I allow this tool? Respond with JSON: ${'{permissionDecision: allow or deny}'}`}
              className="min-h-[120px] font-mono text-sm"
              rows={6}
            />
            <p className="text-xs text-muted-foreground">
              <Trans>Prompt sent to Claude Haiku for decision-making. Use ${'{variable}'} for interpolation.</Trans>
            </p>
          </div>
        )}

        {/* Timeout */}
        <div className="space-y-2">
          <Label htmlFor="timeout">
            <Trans>Timeout (seconds)</Trans>
          </Label>
          <Input
            id="timeout"
            type="number"
            value={timeout}
            onChange={(e) => onTimeoutChange(e.target.value)}
            placeholder={t`60`}
            min="1"
            max="600"
          />
          <p className="text-xs text-muted-foreground">
            <Trans>Maximum execution time (default: 60s, max: 600s)</Trans>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

import { Trigger, TriggerActionType } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import { ErrorMessage } from './constants';
import { useState, useEffect } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface TriggerFormProps {
  trigger: Trigger | null;
  hookId?: string; // If provided, auto-connect trigger to this hook after save
  onSave: (trigger: Trigger, hookId?: string) => void;
  onCancel: () => void;
}

export function TriggerForm({ trigger, hookId, onSave, onCancel }: TriggerFormProps) {
  const { t } = useLingui();
  const [formData, setFormData] = useState<Partial<Trigger>>({
    name: '',
    description: '',
    mask: {},
    action: { action_type: TriggerActionType.NOP },
    enabled: true,
  });

  const [maskJson, setMaskJson] = useState('');
  const [maskError, setMaskError] = useState('');

  useEffect(() => {
    if (trigger) {
      setFormData({
        name: trigger.name,
        description: trigger.description,
        mask: trigger.mask,
        action: trigger.action,
        enabled: trigger.enabled,
      });
      setMaskJson(JSON.stringify(trigger.mask, null, 2));
    }
  }, [trigger]);

  const handleChange = (field: keyof Trigger, value: unknown) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleMaskChange = (value: string) => {
    setMaskJson(value);
    setMaskError('');

    try {
      const parsed = JSON.parse(value || '{}');
      handleChange('mask', parsed as Record<string, unknown>);
    } catch {
      setMaskError(ErrorMessage.INVALID_JSON);
    }
  };

  const handleSave = () => {
    if (maskError) {
      return;
    }

    const triggerToSave = trigger || new Trigger();
    Object.assign(triggerToSave, formData);
    onSave(triggerToSave, hookId);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{trigger ? t`Edit Trigger` : t`Create Trigger`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name"><Trans>Name *</Trans></Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder={t`Enter trigger name`}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description"><Trans>Description</Trans></Label>
            <Textarea
              id="description"
              value={formData.description || ''}
              onChange={(e) => handleChange('description', e.target.value)}
              placeholder={t`Enter trigger description`}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mask"><Trans>Mask (JSON) *</Trans></Label>
            <p className="text-xs text-muted-foreground">
              <Trans>Define the conditions that must match for this trigger to fire</Trans>
            </p>
            <Textarea
              id="mask"
              value={maskJson}
              onChange={(e) => handleMaskChange(e.target.value)}
              placeholder='{"hook_event_name": "UserPromptSubmit"}'
              rows={6}
              className="font-mono text-xs"
            />
            {maskError && <p className="text-sm text-destructive">{maskError}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="actionType"><Trans>Action Type</Trans></Label>
            <Select
              value={formData.action?.action_type}
              onValueChange={(value) =>
                setFormData((prev) => ({
                  ...prev,
                  action: { action_type: value as TriggerActionType },
                }))
              }
            >
              <SelectTrigger id="actionType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TriggerActionType.NOP}><Trans>No Operation (Trace Only)</Trans></SelectItem>
                <SelectItem value={TriggerActionType.NOTIFY_ENTITY}><Trans>Notify Entity (Increment Counter)</Trans></SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center space-x-2">
            <Switch
              id="enabled"
              checked={formData.enabled}
              onCheckedChange={(checked) => handleChange('enabled', checked)}
            />
            <Label htmlFor="enabled"><Trans>Enabled</Trans></Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={handleSave} disabled={!!maskError}>
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

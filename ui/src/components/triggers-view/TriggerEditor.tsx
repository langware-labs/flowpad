import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';
import { ActionInfo, dataManager, Trigger, type ITrigger } from '@sdk';
import Editor from '@monaco-editor/react';
import { Pencil } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { scopeColor } from './scope-colors';

interface Props {
  trigger: ITrigger;
}

export function TriggerEditor({ trigger }: Props) {
  const { t } = useLingui();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const savedContentRef = useRef('');
  const { resolvedTheme } = useTheme();

  const isSystem = trigger.scope === 'system';
  const isReadOnly = isSystem && !unlocked;

  useEffect(() => {
    setUnlocked(false);
  }, [trigger.id]);

  useEffect(() => {
    if (!trigger.id) return;
    setLoading(true);
    setContent('');
    setError(null);
    const action = new ActionInfo('trigger-content', 'trigger', trigger.id, 'GET');
    dataManager.callAction<undefined, { content: string }>(action)
      .then((data) => {
        if (data && typeof (data as { content: string }).content === 'string') {
          const loadedContent = (data as { content: string }).content;
          savedContentRef.current = loadedContent;
          setContent(loadedContent);
        } else {
          setError(t`Failed to load trigger.py`);
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [trigger.id, t]);

  const handleSave = async () => {
    if (isReadOnly || !trigger.id) return;
    setSaving(true);
    try {
      const action = new ActionInfo('trigger-content', 'trigger', trigger.id, 'PUT');
      action.bodyParameters = { content };
      await dataManager.callAction(action);
      if (content !== savedContentRef.current) {
        savedContentRef.current = content;
        Trigger.markEditById(trigger.id);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Save failed`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${scopeColor(trigger.scope)}`}>
          {trigger.scope || 'user'}
        </span>
        <span className="font-mono text-sm font-medium">{trigger.displayName}</span>
        {/* Show /trigger.py only for hook triggers — non-hook types reach here
            only via fall-through and don't have a trigger.py file. */}
        {(trigger.trigger_type ?? 'hook') === 'hook' && (
          <span className="text-xs text-muted-foreground">/trigger.py</span>
        )}
        {(trigger.hook_events?.length ?? 0) > 0 && (
          <div className="flex gap-1">
            {trigger.hook_events!.map(ev => (
              <Badge key={ev} variant="outline" className="h-4 px-1 text-[9px]">{ev}</Badge>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {isSystem && !unlocked && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground"
              onClick={() => setConfirmOpen(true)}
              title={t`Edit system trigger`}
            >
              <Pencil className="h-3 w-3" />
              <Trans>Edit</Trans>
            </Button>
          )}
          {isSystem && unlocked && (
            <span className="text-[10px] text-amber-500"><Trans>Editing system trigger</Trans></span>
          )}
          {error && <span className="text-[10px] text-destructive">{error}</span>}
          {saved && <span className="text-[10px] text-green-500"><Trans>Saved</Trans></span>}
          {!isReadOnly && (
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || loading}>
              {saving ? t`Saving...` : t`Save`}
            </Button>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Trans>Loading...</Trans></div>
        ) : (
          <Editor
            height="100%"
            language="python"
            value={content}
            onChange={(val) => setContent(val ?? '')}
            theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
            options={{
              readOnly: isReadOnly,
              fontSize: 13,
              lineHeight: 20,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              padding: { top: 12, bottom: 12 },
              lineNumbers: 'on',
              folding: true,
              renderLineHighlight: 'all',
            }}
          />
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle><Trans>Edit a system trigger?</Trans></AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>System triggers power core Flowpad functionality. Editing them can cause parts of the app to behave unexpectedly. Proceed only if you understand what this trigger does.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel><Trans>Cancel</Trans></AlertDialogCancel>
            <AlertDialogAction onClick={() => setUnlocked(true)}>
              <Trans>Edit anyway</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

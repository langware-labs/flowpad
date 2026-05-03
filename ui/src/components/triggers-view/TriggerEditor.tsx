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
import { ActionInfo, dataManager, type ITrigger } from '@sdk';
import Editor from '@monaco-editor/react';
import { Pencil } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

interface Props {
  trigger: ITrigger;
}

export function TriggerEditor({ trigger }: Props) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
          setContent((data as { content: string }).content);
        } else {
          setError('Failed to load trigger.py');
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [trigger.id]);

  const handleSave = async () => {
    if (isReadOnly || !trigger.id) return;
    setSaving(true);
    try {
      const action = new ActionInfo('trigger-content', 'trigger', trigger.id, 'PUT');
      action.bodyParameters = { content };
      await dataManager.callAction(action);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const SCOPE_COLORS: Record<string, string> = {
    system: 'bg-muted text-muted-foreground',
    user: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    project: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SCOPE_COLORS[trigger.scope || 'user'] ?? SCOPE_COLORS['user']}`}>
          {trigger.scope || 'user'}
        </span>
        <span className="font-mono text-sm font-medium">{trigger.displayName}</span>
        <span className="text-xs text-muted-foreground">/trigger.py</span>
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
              title="Edit system trigger"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
          )}
          {isSystem && unlocked && (
            <span className="text-[10px] text-amber-500">Editing system trigger</span>
          )}
          {error && <span className="text-[10px] text-destructive">{error}</span>}
          {saved && <span className="text-[10px] text-green-500">Saved</span>}
          {!isReadOnly && (
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || loading}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>
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
            <AlertDialogTitle>Edit a system trigger?</AlertDialogTitle>
            <AlertDialogDescription>
              System triggers power core Flowpad functionality. Editing them can cause parts
              of the app to behave unexpectedly. Proceed only if you understand what this
              trigger does.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => setUnlocked(true)}>
              Edit anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

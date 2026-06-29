import { Button } from '@src/components/ui/button';
import Editor from '@monaco-editor/react';
import { Loader2, MessageSquarePlus, Save } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface EphemeralPromptInputProps {
  onSave: (content: string) => void;
  disabled?: boolean;
}

export function EphemeralPromptInput({ onSave, disabled }: EphemeralPromptInputProps) {
  const [content, setContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const { resolvedTheme } = useTheme();
  const { t } = useLingui();

  const handleSave = useCallback(() => {
    if (content.trim()) {
      setIsSaving(true);
      onSave(content.trim());
    }
  }, [content, onSave]);

  const handleEditorMount = useCallback(
    (
      editor: Parameters<NonNullable<React.ComponentProps<typeof Editor>['onMount']>>[0],
      monaco: Parameters<NonNullable<React.ComponentProps<typeof Editor>['onMount']>>[1],
    ) => {
      // Add Ctrl+Enter keybinding
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        const currentContent = editor.getValue().trim();
        if (currentContent) {
          setIsSaving(true);
          onSave(currentContent);
        }
      });

      // Focus the editor
      editor.focus();
    },
    [onSave],
  );

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <MessageSquarePlus className="h-6 w-6 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-medium"><Trans>New Prompt</Trans></h3>
          <p className="text-xs text-muted-foreground"><Trans>Enter instructions or select a file from the left panel</Trans></p>
        </div>
      </div>

      <div className="flex-1 overflow-hidden rounded-md border">
        <Editor
          height="100%"
          language="markdown"
          value={content}
          onChange={(value) => setContent(value ?? '')}
          onMount={handleEditorMount}
          theme={resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus'}
          options={{
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: 'on',
            padding: { top: 8, bottom: 8 },
            lineNumbers: 'on',
            folding: true,
            readOnly: disabled || isSaving,
            placeholder: t`Enter your instructions here...\n\nOne instruction per line.`,
          }}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground"><Trans>Tip: Press Ctrl+Enter to save</Trans></span>
        <Button onClick={handleSave} disabled={disabled || isSaving || !content.trim()} className="gap-2">
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {isSaving ? t`Saving...` : t`Save`}
        </Button>
      </div>
    </div>
  );
}

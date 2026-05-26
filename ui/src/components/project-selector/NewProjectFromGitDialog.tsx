import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useToast } from '@src/hooks/use-toast';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

export interface NewProjectFromGitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Async callback invoked on submit.
   *
   * `acceptSuggested` is set when the user has accepted a name suggestion
   * after a previous collision — pass it through as the target name override
   * so the backend uses it verbatim.
   *
   * Resolve with `{ ok: false, suggestedName }` to keep the dialog open and
   * render the "use `<suggested>`?" accept banner. Resolve with `{ ok: true }`
   * to let the dialog close. Throw to surface an error toast and stay open.
   */
  onCreate: (
    url: string,
    acceptSuggested?: string,
  ) => Promise<{ ok: true } | { ok: false; suggestedName: string; attemptedName: string }>;
}

export function NewProjectFromGitDialog({ open, onOpenChange, onCreate }: NewProjectFromGitDialogProps) {
  const { toast } = useToast();
  const [url, setUrl] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [suggestion, setSuggestion] = useState<{ suggestedName: string; attemptedName: string } | null>(null);

  useEffect(() => {
    if (open) {
      setUrl('');
      setIsSubmitting(false);
      setSuggestion(null);
    }
  }, [open]);

  const canSubmit = !!url.trim() && !isSubmitting;

  const submit = useCallback(
    async (acceptSuggested?: string) => {
      if (isSubmitting || !url.trim()) return;
      setIsSubmitting(true);
      try {
        const res = await onCreate(url.trim(), acceptSuggested);
        if (res.ok) {
          onOpenChange(false);
        } else {
          setSuggestion({ suggestedName: res.suggestedName, attemptedName: res.attemptedName });
        }
      } catch (err) {
        toast({
          title: err instanceof Error ? err.message : 'Failed to clone repository',
          variant: 'destructive',
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, url, onCreate, onOpenChange, toast],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clone project from git</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            placeholder="https://github.com/owner/repo.git"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (suggestion) setSuggestion(null);
            }}
            autoFocus
            spellCheck={false}
            className="font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) void submit();
            }}
          />
          {suggestion && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <div className="mb-1.5">
                <span className="font-mono">{suggestion.attemptedName}</span> already exists in the workspace.
              </div>
              <div className="flex items-center gap-2">
                <span>Use</span>
                <span className="font-mono font-medium">{suggestion.suggestedName}</span>
                <span>instead?</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-xs"
                  onClick={() => void submit(suggestion.suggestedName)}
                  disabled={isSubmitting}
                >
                  Use suggestion
                </Button>
              </div>
            </div>
          )}
          {isSubmitting && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Cloning…
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {isSubmitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Clone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NewProjectFromGitDialog;

import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';

/**
 * "Run" prompt popup: one optional textarea. Run is always enabled — an empty
 * prompt runs the skill with its generic "run the skill <name>" instruction
 * (see buildSkillTestPrompt).
 */
export function TestPromptDialog({
  open,
  onClose,
  assetName,
  onRun,
}: {
  open: boolean;
  onClose: () => void;
  assetName: string;
  onRun: (prompt: string) => void;
}) {
  const { t } = useLingui();
  const [text, setText] = useState('');

  useEffect(() => {
    if (open) setText('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle><Trans>Run “{assetName}”</Trans></DialogTitle>
          <DialogDescription>
            <Trans>A new Vibe session opens and runs the skill. Optionally describe what to use it for.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t`What should the skill be used for? (optional)`}
            rows={5}
            data-testid="test-skill-prompt-input"
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button
            data-testid="test-skill-run-button"
            onClick={() => {
              onRun(text);
              onClose();
            }}
          >
            <Trans>Run</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

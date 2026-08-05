import { capabilityManager, CapabilityKinds } from '@sdk';
import { useCapability } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * Harness capability picker.
 *
 * Opened when an interactive tab needs a harness that is not available on this
 * machine. Lists the supported harness capabilities, validates each row with
 * `useCapability`, links to the install homepage, and lets the user select an
 * available harness as the default `harness.reference_kind`.
 */
interface Props {
  /** Capability kinds to offer, or null when the dialog is closed. */
  kinds: string[] | null;
  onClose: () => void;
}

const HOMEPAGE_FALLBACKS: Record<string, string> = {
  [CapabilityKinds.ClaudeCode]: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
  [CapabilityKinds.Codex]: 'https://openai.com/codex/',
  [CapabilityKinds.Copilot]: 'https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli',
};

function CapabilityHarnessRow({
  kind,
  selected,
  onSelected,
}: {
  kind: string;
  selected: boolean;
  onSelected: () => void;
}) {
  const { capability, available, result, isLoading, test } = useCapability(kind);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { t } = useLingui();

  const title = capability?.name ?? kind;
  const description = capability?.description ?? '';
  const homepage = capability?.homepage_url ?? HOMEPAGE_FALLBACKS[kind] ?? null;

  const onUse = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await capabilityManager.setReferenceKind(CapabilityKinds.Harness, kind);
      onSelected();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-md border p-3" data-testid={`install-one-of-row-${kind}`}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">{title}</div>
          {selected && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" />
              <Trans>Default</Trans>
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">{kind}</div>
        {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
        {(message ?? result?.message) && (
          <div className="mt-1 text-xs text-amber-600 dark:text-amber-500">{message ?? result?.message}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          disabled={isLoading}
          onClick={() => void test()}
          aria-label={t`Re-check ${title}`}
          data-testid={`install-one-of-check-${kind}`}
        >
          {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
        {homepage && (
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8"
            asChild
            aria-label={t`Open ${title} install page`}
            data-testid={`install-one-of-link-${kind}`}
          >
            <a href={homepage} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="gap-1.5"
          disabled={!available || saving || selected}
          onClick={() => void onUse()}
          data-testid={`install-one-of-button-${kind}`}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {selected ? <Trans>Using</Trans> : <Trans>Use</Trans>}
        </Button>
      </div>
    </div>
  );
}

export function AskInstallOneOfDialog({ kinds, onClose }: Props) {
  // The controller keeps this dialog mounted while it is closed. Read the
  // persisted reference only: an executable harness probe belongs to the
  // launch/setup seam or an explicit row re-check, never cold app startup.
  const defaultHarness = useCapability(CapabilityKinds.Harness, { autoCheck: false });
  const selectedKind = defaultHarness.resolvedKind;

  return (
    <Dialog open={!!kinds?.length} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid="install-one-of-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Harness is required</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Select an available harness, or install one from its homepage and re-check it.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {(kinds ?? []).map((kind) => (
            <CapabilityHarnessRow key={kind} kind={kind} selected={selectedKind === kind} onSelected={onClose} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

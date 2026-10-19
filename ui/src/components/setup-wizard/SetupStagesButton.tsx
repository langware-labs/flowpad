import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { DataDriver, DataSource, SetupStageState } from '@sdk';
import { Plug, Unplug } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { SetupWizardDialog } from './SetupWizardDialog';

/**
 * A source's setup at a glance — one icon, complete (every stage done) or pending — and the way back into its setup
 * wizard. The stages themselves (`Test ✓ · Production`) are the tooltip. Renders nothing for a driver that declares no `setup_wizards`, so it can sit on every row.
 */
export function SetupStagesButton({ source, spec }: { source: DataSource; spec?: DataDriver | null }) {
  const { t } = useLingui();
  const declared = !!spec?.setup_wizards?.length;
  const [stages, setStages] = useState<SetupStageState[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!declared || open) return;
    let alive = true;
    void source
      .setupStages()
      .then((s) => alive && setStages(s))
      .catch(() => alive && setStages(null));
    return () => {
      alive = false;
    };
  }, [declared, open, source]);

  if (!declared) return null;
  const pending = stages?.find((s) => s.state === 'pending');
  const summary = (stages ?? []).map((s) => (s.state === 'done' ? `${s.label} ✓` : s.label)).join(' · ');
  // Unknown until the stages load: do not claim completion.
  const complete = stages !== null && !pending;
  const Icon = complete ? Plug : Unplug;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        title={pending ? t`Continue setup: ${pending.label}` : complete ? t`Setup complete (${summary})` : t`Setup`}
        aria-label={pending ? t`Finish setup` : complete ? t`Setup complete` : t`Setup`}
        data-testid={`source-setup-${source.id}`}
        data-setup-complete={complete}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Icon className={complete ? 'size-4 text-emerald-500' : 'size-4 text-amber-500'} />
      </Button>
      {open && (
        <SetupWizardDialog
          source={source}
          open
          onOpenChange={(next) => !next && setOpen(false)}
        />
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { DataDriver, DataSource, SetupStageState } from '@sdk';
import { Wand2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { SetupWizardDialog } from './SetupWizardDialog';

/**
 * A source's setup stages at a glance — `Test ✓ · Production` — and the way back into its setup
 * wizard. Renders nothing for a driver that declares no `setup_wizards`, so it can sit on every row.
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

  return (
    <>
      <Button
        size="sm"
        variant={pending ? 'secondary' : 'ghost'}
        className="h-7 gap-1.5 px-2 text-xs"
        title={pending ? t`Continue setup: ${pending.label}` : t`Setup`}
        data-testid={`source-setup-${source.id}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Wand2 className="size-3.5" />
        {summary || t`Setup`}
      </Button>
      {open && (
        <SetupWizardDialog
          source={source}
          title={spec?.title || source.name}
          open
          onOpenChange={(next) => !next && setOpen(false)}
        />
      )}
    </>
  );
}

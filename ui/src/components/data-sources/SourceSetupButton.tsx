/**
 * Two controls a source's row carries: **Setup** — the one action that finishes a source in setup,
 * whatever its driver — and the gear to the source's settings.
 */
import type { DataSource } from '@sdk';
import { Settings2, Wrench } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openSourceSetup } from '@src/components/setup-wizard/source-setup-store';
import { openSource } from './data-sources-pointer';

/** Setup — opens the source's own setup (what its driver needs, its stages, Verify), questions in place. */
export function SourceSetupButton({ source }: { source: DataSource }) {
  const { t } = useLingui();
  return (
    <Button
      size="sm"
      className="h-7 gap-1.5"
      data-testid={`source-setup-${source.id}`}
      onClick={(e) => {
        e.stopPropagation();
        openSourceSetup(source);
      }}
    >
      <Wrench className="size-3.5" />
      {t`Setup`}
    </Button>
  );
}

/** The source's settings page — a gear, for whoever wants more than Setup. */
export function SourceSettingsButton({ source, testId }: { source: DataSource; testId: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const name = source.name || source.provider;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="size-7 p-0"
      title={t`Settings`}
      aria-label={t`Open settings of ${name}`}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        openSource(navigation, source.id, 'settings');
      }}
    >
      <Settings2 className="size-4" />
    </Button>
  );
}

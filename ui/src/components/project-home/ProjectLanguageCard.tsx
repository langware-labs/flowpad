import type { Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Flag, LocalePicker } from '@src/components/locale/LocalePicker';
import { setLocale, useLocale, useSupportedLocales } from '@src/contexts/locale-context';
import { ChevronDown, Languages } from 'lucide-react';
import React, { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface ProjectLanguageCardProps {
  project: Project;
}

/**
 * The project's language setting — "which language is this project read in".
 *
 * Picking one calls the same `setLocale` the footer chip calls: it switches the
 * app language (catalog + `<html lang/dir>`) AND stamps the choice onto the
 * current project, so opening or switching into the project later re-applies it
 * (`applyProjectLocale`, from `loadProject`). This card only renders for the
 * ACTIVE project — ProjectHome gates its entity-bound cards on that — which is
 * why one `setLocale` call is the whole write path and the card never touches
 * `project.locale` itself.
 */
export const ProjectLanguageCard: React.FC<ProjectLanguageCardProps> = ({ project }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const activeCode = useLocale();
  const supportedLocales = useSupportedLocales();

  // The project's stored language; until it has been stamped (first load), the
  // active language is what this project will be read in.
  const selectedCode = project.locale ?? activeCode;
  const selectedInfo = supportedLocales.find((l) => l.code === selectedCode) ?? supportedLocales[0];

  const handleSelect = (code: string) => {
    setOpen(false);
    void setLocale(code);
  };

  // Nothing to choose between when the backend ships a single locale — same
  // rule as the footer chip.
  if (supportedLocales.length < 2 || !selectedInfo) return null;

  return (
    <div className="rounded-lg border border-border p-4" data-testid="project-language-card">
      <div className="mb-3 flex items-center gap-2">
        <Languages className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">
          <Trans>Language</Trans>
        </h3>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        <Trans>
          The language this project is worked in. Choosing one switches the app now, and switches back to it every time
          you open this project.
        </Trans>
      </p>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="justify-start gap-2"
            aria-label={t`Change this project's language`}
            data-testid="project-language-trigger"
          >
            <Flag code={selectedInfo.flag} className="text-base" />
            <span>{selectedInfo.nativeName}</span>
            <ChevronDown className="ms-auto h-4 w-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <LocalePicker selectedCode={selectedCode} onSelect={handleSelect} />
        </PopoverContent>
      </Popover>
    </div>
  );
};

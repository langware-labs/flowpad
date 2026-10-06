import React from 'react';
import { Cloud, FolderOpen, GitBranch, PackageCheck, PackagePlus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { WikiButton } from '@src/components/wiki-tip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import type { DependencyKind } from '@src/hooks/use-project-dependencies';

/** Where a dependency comes from. The sources are the same wherever they're
 *  offered — the "+" dialog in the Assets navigator, and the create-new
 *  surface's tiles. */
export type DependencySource = 'project' | 'browse' | 'git' | 'hub';

/** The wiki page behind every dependency surface — hoisted so the title is
 *  written once (a wikiword is resolved by page title at runtime, so a typo
 *  silently degrades into a "create this page" prompt rather than an error). */
export const DEPENDENCIES_WIKI = 'Dependencies';

export interface DependencySourceInfo {
  key: DependencySource;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** One-line explanation of where this source's folder comes from, shown on
   *  hover — a 10px tile label can't say it, and "Project" vs "Git repository"
   *  only reads as a choice once you know what each one pulls in. */
  tip: string;
  wikiword: string;
  testId: string;
}

/**
 * The dependency sources, resolved at render — the project icon comes from the
 * backend type registry (never hardcoded) and the labels are translated.
 *
 * "Folder on this computer" deliberately avoids "PC": on macOS and Linux that
 * word reads as Windows-only. "Computer" covers all three and needs no gloss.
 */
export function useDependencySources(): DependencySourceInfo[] {
  const { t } = useLingui();
  return [
    {
      key: 'project',
      Icon: iconForType('project'),
      label: t`Project`,
      tip: t`Another Flowpad project — this one depends on its folder`,
      wikiword: DEPENDENCIES_WIKI,
      testId: 'add-dependency-project',
    },
    {
      key: 'browse',
      Icon: FolderOpen,
      label: t`Folder on this computer`,
      tip: t`Pick any folder already on this machine`,
      wikiword: DEPENDENCIES_WIKI,
      testId: 'add-dependency-browse',
    },
    {
      key: 'git',
      Icon: GitBranch,
      label: t`Git repository`,
      tip: t`A git repo — cloned (or a local clone reused) wherever this project opens`,
      wikiword: DEPENDENCIES_WIKI,
      testId: 'add-dependency-git',
    },
    {
      key: 'hub',
      Icon: Cloud,
      label: t`Hub project`,
      tip: t`A project on the hub — fetched by its id wherever this project opens`,
      wikiword: DEPENDENCIES_WIKI,
      testId: 'add-dependency-hub',
    },
  ];
}

/**
 * DependencyKindChips — required/optional selector for a dependency about to
 * be added. Shared by the "+" dialog, the create-new surface and the help-desk
 * dialog so the wording and the semantics can't drift apart.
 */
export function DependencyKindChips({
  kind,
  onChange,
}: {
  kind: DependencyKind;
  onChange: (next: DependencyKind) => void;
}) {
  const { t } = useLingui();
  // A real tooltip, not the WikiTip hover card the tiles use: these two chips
  // are a *choice*, and the difference has to land the moment the pointer
  // arrives — a 500ms card that also has to be aimed at is too slow to explain
  // a radio pair. The wiki page stays one click away inside the tooltip (Radix
  // keeps hoverable content open), so nothing is lost. No native `title` either
  // — it would race this tooltip and show the same text twice.
  const options: {
    value: DependencyKind;
    icon: React.ReactNode;
    label: React.ReactNode;
    tip: string;
    buttonLabel: string;
  }[] = [
    {
      value: 'required',
      icon: <PackageCheck className="h-3 w-3" />,
      label: <Trans>Required</Trans>,
      tip: t`Fetched automatically wherever this project opens — Flowpad warns when it can't be.`,
      buttonLabel: t`What is a required dependency?`,
    },
    {
      value: 'optional',
      icon: <PackagePlus className="h-3 w-3" />,
      label: <Trans>Optional</Trans>,
      tip: t`Listed with the project, but fetched only when someone clicks Install.`,
      buttonLabel: t`What is an optional dependency?`,
    },
  ];

  return (
    <div className="flex items-center gap-1" role="radiogroup">
      {options.map((opt) => (
        <Tooltip key={opt.value} delayDuration={150}>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="radio"
              aria-checked={kind === opt.value}
              onClick={() => onChange(opt.value)}
              data-testid={`add-dependency-kind-${opt.value}`}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                kind === opt.value
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
              }`}
            >
              {opt.icon}
              {opt.label}
            </button>
          </TooltipTrigger>
          {/* pointer-events-auto: the content portals to <body>, which a modal
              Radix Dialog marks pointer-events:none — without it the W button
              renders inside a dialog but can't be clicked. */}
          <TooltipContent side="top" className="pointer-events-auto flex max-w-[260px] items-start gap-2">
            <span className="text-xs leading-snug text-muted-foreground">{opt.tip}</span>
            <WikiButton wikiword={DEPENDENCIES_WIKI} label={opt.buttonLabel} />
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

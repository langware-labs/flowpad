import React from 'react';
import { FolderOpen, GitBranch, Lock, Users } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { WikiButton } from '@src/components/wiki-tip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import type { ContextFolderScope } from '@src/hooks/use-project-context-folders';

/** Where a context folder comes from. The three sources are the same wherever
 *  they're offered — the "+" dialog in the Assets navigator, and the create-new
 *  surface's tiles. */
export type ContextFolderSource = 'project' | 'browse' | 'git';

/** Wiki pages behind the folder sources — hoisted so the title is written once
 *  (a wikiword is resolved by page title at runtime, so a typo silently degrades
 *  into a "create this page" prompt rather than an error). */
export const CONTEXT_FOLDERS_WIKI = 'Context folders';
export const GIT_CONTEXT_FOLDERS_WIKI = 'Git context folders';
export const PRIVATE_CONTEXT_FOLDERS_WIKI = 'Private context folders';
export const SHARED_CONTEXT_FOLDERS_WIKI = 'Shared context folders';

export interface ContextFolderSourceInfo {
  key: ContextFolderSource;
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
 * The context-folder sources, resolved at render — the project icon comes from
 * the backend type registry (never hardcoded) and the labels are translated.
 *
 * "Folder on this computer" deliberately avoids "PC": on macOS and Linux that
 * word reads as Windows-only. "Computer" covers all three and needs no gloss.
 */
export function useContextFolderSources(): ContextFolderSourceInfo[] {
  const { t } = useLingui();
  return [
    {
      key: 'project',
      Icon: iconForType('project'),
      label: t`Project`,
      tip: t`Another Flowpad project — its folder becomes context for this one`,
      wikiword: CONTEXT_FOLDERS_WIKI,
      testId: 'add-context-folder-project',
    },
    {
      key: 'browse',
      Icon: FolderOpen,
      label: t`Folder on this computer`,
      tip: t`Pick any folder already on this machine`,
      wikiword: CONTEXT_FOLDERS_WIKI,
      testId: 'add-context-folder-browse',
    },
    {
      key: 'git',
      Icon: GitBranch,
      label: t`Git repository`,
      tip: t`Clone a git repo (or reuse a local clone) as context`,
      wikiword: GIT_CONTEXT_FOLDERS_WIKI,
      testId: 'add-context-folder-git',
    },
  ];
}

/**
 * ContextFolderScopeChips — private/shared selector for a folder about to be
 * added. Shared by the "+" dialog and the create-new surface so the wording and
 * the semantics can't drift apart.
 */
export function ContextFolderScopeChips({
  scope,
  onChange,
}: {
  scope: ContextFolderScope;
  onChange: (next: ContextFolderScope) => void;
}) {
  const { t } = useLingui();
  // A real tooltip, not the WikiTip hover card the tiles use: these two chips
  // are a *choice*, and the difference has to land the moment the pointer
  // arrives — a 500ms card that also has to be aimed at is too slow to explain
  // a radio pair. The wiki page stays one click away inside the tooltip (Radix
  // keeps hoverable content open), so nothing is lost. No native `title` either
  // — it would race this tooltip and show the same text twice.
  const options: {
    value: ContextFolderScope;
    icon: React.ReactNode;
    label: React.ReactNode;
    tip: string;
    wikiword: string;
    buttonLabel: string;
  }[] = [
    {
      value: 'private',
      icon: <Lock className="h-3 w-3" />,
      label: <Trans>Private</Trans>,
      tip: t`Stays on this machine only — the folder is never sent to anyone, even people this project is shared with.`,
      wikiword: PRIVATE_CONTEXT_FOLDERS_WIKI,
      buttonLabel: t`What is a private context folder?`,
    },
    {
      value: 'shared',
      icon: <Users className="h-3 w-3" />,
      label: <Trans>Shared</Trans>,
      tip: t`Travels with the project — everyone it is shared with gets this folder as context too.`,
      wikiword: SHARED_CONTEXT_FOLDERS_WIKI,
      buttonLabel: t`What is a shared context folder?`,
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
              aria-checked={scope === opt.value}
              onClick={() => onChange(opt.value)}
              data-testid={`add-context-folder-scope-${opt.value}`}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                scope === opt.value
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
            <WikiButton wikiword={opt.wikiword} label={opt.buttonLabel} />
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

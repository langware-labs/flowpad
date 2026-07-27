import React from 'react';
import { FolderOpen, GitBranch, Lock, Users } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { WikiTip } from '@src/components/wiki-tip';
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
  wikiword: string;
  testId: string;
}

/**
 * The context-folder sources, resolved at render — the project icon comes from
 * the backend type registry (never hardcoded) and the labels are translated.
 */
export function useContextFolderSources(): ContextFolderSourceInfo[] {
  const { t } = useLingui();
  return [
    {
      key: 'project',
      Icon: iconForType('project'),
      label: t`Project folder`,
      wikiword: CONTEXT_FOLDERS_WIKI,
      testId: 'add-context-folder-project',
    },
    {
      key: 'browse',
      Icon: FolderOpen,
      label: t`Open folder`,
      wikiword: CONTEXT_FOLDERS_WIKI,
      testId: 'add-context-folder-browse',
    },
    {
      key: 'git',
      Icon: GitBranch,
      label: t`Git folder`,
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
  // No `title` on the chips: a native tooltip would race the WikiTip's hover
  // card. The one-liner rides in the card instead, next to the W button.
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
      tip: t`Only on this machine — never shared`,
      wikiword: PRIVATE_CONTEXT_FOLDERS_WIKI,
      buttonLabel: t`What is a private context folder?`,
    },
    {
      value: 'shared',
      icon: <Users className="h-3 w-3" />,
      label: <Trans>Shared</Trans>,
      tip: t`Everyone the project is shared with gets it`,
      wikiword: SHARED_CONTEXT_FOLDERS_WIKI,
      buttonLabel: t`What is a shared context folder?`,
    },
  ];

  return (
    <div className="flex items-center gap-1" role="radiogroup">
      {options.map((opt) => (
        <WikiTip
          key={opt.value}
          wikiword={opt.wikiword}
          label={opt.tip}
          buttonLabel={opt.buttonLabel}
        >
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
        </WikiTip>
      ))}
    </div>
  );
}

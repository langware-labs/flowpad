import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';
import { FolderOpen, Pencil } from 'lucide-react';
import { useCallback } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export type ScopeKind = 'user' | 'project' | 'folder';

export interface Scope {
  kind: ScopeKind;
  /** Selected project when kind === 'project'. */
  project: Project | null;
  /** Absolute folder picked by the OS dialog when kind === 'folder'. */
  folderPath: string | null;
}

export interface ScopeSelectionProps {
  scope: Scope;
  onScopeChange: (next: Scope) => void;
  mount: string;
  mounts: string[];
  onMountChange: (next: string) => void;
  /** Path text shown in the editable input. */
  path: string;
  onPathChange: (path: string) => void;
  /** Opens the OS folder picker and returns the picked absolute path or null. */
  onPickFolder: () => Promise<string | null>;
  /** Opens the project picker (currently OpenProjectComponent). */
  onOpenProjectPicker: () => void;
  /** Scope chips available for this asset type. Omitted means all scopes. */
  allowedScopes?: readonly ScopeKind[];
}

/* Both tables are module-level, so their wording is held as lazy `msg`
 * descriptors and resolved with `t` inside the component — an eager macro out
 * here would bind the language at import and never follow a locale switch.
 * The harness NAMES (Claude Code, Codex, Copilot) stay literal: they are
 * products, not words to translate. */
const SCOPE_OPTIONS: { value: ScopeKind; label: MessageDescriptor }[] = [
  { value: 'user', label: msg`User` },
  { value: 'project', label: msg`Project` },
  { value: 'folder', label: msg`Folder` },
];

export function ScopeSelection({
  scope,
  onScopeChange,
  mount,
  mounts,
  onMountChange,
  path,
  onPathChange,
  onPickFolder,
  onOpenProjectPicker,
  allowedScopes,
}: ScopeSelectionProps) {
  const { t } = useLingui();
  // Resolved here rather than in the table: `ScopeBar` wants plain strings, and
  // resolving at render is what lets the chips re-label on a locale switch.
  const scopeOptions: ScopeBarOption<ScopeKind>[] = (
    allowedScopes ? SCOPE_OPTIONS.filter((option) => allowedScopes.includes(option.value)) : SCOPE_OPTIONS
  ).map(({ value, label }) => ({ value, label: t(label) }));

  const handleScopeChange = useCallback(
    (next: ScopeKind) => {
      if (next === scope.kind) return;
      if (allowedScopes && !allowedScopes.includes(next)) return;
      onScopeChange({ ...scope, kind: next });
    },
    [allowedScopes, scope, onScopeChange],
  );

  const handleBrowseFolder = useCallback(async () => {
    const picked = await onPickFolder();
    if (picked) {
      onScopeChange({ ...scope, kind: 'folder', folderPath: picked });
    }
  }, [onPickFolder, onScopeChange, scope]);

  const projectLabel = scope.project?.displayName ?? scope.project?.name ?? null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <ScopeBar value={scope.kind} options={scopeOptions} onChange={handleScopeChange} />
        {scope.kind === 'project' && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenProjectPicker}
            className="h-7 max-w-[220px] gap-1.5 text-xs"
            title={t`Switch project`}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{projectLabel ?? t`Select project`}</span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Button>
        )}
        {scope.kind === 'folder' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleBrowseFolder()}
            className="h-7 gap-1.5 text-xs"
            title={t`Choose folder…`}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <Trans>Browse…</Trans>
          </Button>
        )}
      </div>

      {mounts.length > 1 && scope.kind !== 'folder' && (
        <select aria-label={t`Asset folder`} value={mount} onChange={(e) => onMountChange(e.target.value)}
          className="rounded border bg-background p-2 font-mono text-xs">
          {mounts.map((path) => <option key={path} value={path}>{path}</option>)}
        </select>
      )}

      <Input
        value={path}
        onChange={(e) => onPathChange(e.target.value)}
        placeholder={t`Path`}
        className="font-mono text-xs"
        spellCheck={false}
      />
    </div>
  );
}

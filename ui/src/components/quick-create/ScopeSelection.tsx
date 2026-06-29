import type { Project } from '@sdk';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { ScopeBar, type ScopeBarOption } from '@src/components/ui/scope-bar';
import { cn } from '@src/lib/utils';
import { CircleSlash, FolderOpen, Layers, Pencil } from 'lucide-react';
import { useCallback } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

export type ScopeKind = 'user' | 'project' | 'folder';
export type HarnessKind = 'all' | 'claude' | 'codex' | 'copilot' | 'none';

export interface Scope {
  kind: ScopeKind;
  /** Selected project when kind === 'project'. */
  project: Project | null;
  /** Absolute folder picked by the OS dialog when kind === 'folder'. */
  folderPath: string | null;
}

interface ScopeSelectionProps {
  scope: Scope;
  onScopeChange: (next: Scope) => void;
  harness: HarnessKind;
  onHarnessChange: (next: HarnessKind) => void;
  /** Path text shown in the editable input. */
  path: string;
  onPathChange: (path: string) => void;
  /** Opens the OS folder picker and returns the picked absolute path or null. */
  onPickFolder: () => Promise<string | null>;
  /** Opens the project picker (currently OpenProjectComponent). */
  onOpenProjectPicker: () => void;
}

const SCOPE_OPTIONS: ScopeBarOption<ScopeKind>[] = [
  { value: 'user', label: 'User' },
  { value: 'project', label: 'Project' },
  { value: 'folder', label: 'Folder' },
];

const HARNESS_OPTIONS: { value: HarnessKind; title: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'all', title: 'All harnesses', Icon: Layers },
  { value: 'claude', title: 'Claude Code', Icon: ClaudeIcon },
  { value: 'codex', title: 'Codex', Icon: CodexIcon },
  { value: 'copilot', title: 'Copilot', Icon: CopilotIcon },
  { value: 'none', title: 'None (project root)', Icon: CircleSlash },
];

export function ScopeSelection({
  scope,
  onScopeChange,
  harness,
  onHarnessChange,
  path,
  onPathChange,
  onPickFolder,
  onOpenProjectPicker,
}: ScopeSelectionProps) {
  const { t } = useLingui();

  const handleScopeChange = useCallback(
    (next: ScopeKind) => {
      if (next === scope.kind) return;
      onScopeChange({ ...scope, kind: next });
    },
    [scope, onScopeChange],
  );

  const handleBrowseFolder = useCallback(async () => {
    const picked = await onPickFolder();
    if (picked) {
      onScopeChange({ ...scope, kind: 'folder', folderPath: picked });
    }
  }, [onPickFolder, onScopeChange, scope]);

  const projectLabel = scope.project?.displayName ?? scope.project?.name ?? null;
  const harnessDisabled = scope.kind === 'folder';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <ScopeBar value={scope.kind} options={SCOPE_OPTIONS} onChange={handleScopeChange} />
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

      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"><Trans>Harness path</Trans></span>
        <div className="flex items-center gap-1" role="radiogroup" aria-label={t`Harness path`}>
          {HARNESS_OPTIONS.map(({ value, title, Icon }) => {
            const active = value === harness;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={title}
                title={title}
                disabled={harnessDisabled}
                onClick={() => onHarnessChange(value)}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  harnessDisabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>
      </div>

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

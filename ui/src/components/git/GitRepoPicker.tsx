import React, { useEffect, useState } from 'react';
import { Cloud, GitBranch, Plus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { GitRemoteField, type GitRemoteValue } from '@src/components/git/GitRemoteField';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';

/**
 * Where a git flow's repository lives.
 *
 * `branch` rides along on the existing-repo path: without it a flow clones (or
 * pushes to) whatever the remote's HEAD points at. Absent means "the remote's
 * default branch" — a choice the user made, not one we guessed.
 *
 * `flowpad` is the hub-managed repository ("Flowpad git") — for someone with no
 * GitHub at all.
 */
export type GitTarget =
  | { mode: 'existing'; url: string; branch?: string }
  | { mode: 'new'; name: string }
  | { mode: 'flowpad' };

export type GitTargetMode = GitTarget['mode'];

export interface GitRepoPickerProps {
  /** Which choices to offer, in order. Default: existing + new. */
  modes?: readonly GitTargetMode[];
  /** Fired on every edit; `null` while the current choice is incomplete. */
  onChange: (target: GitTarget | null) => void;
  /** True while the branch list owns the body (it has its own Back). */
  onStepChange?: (inPicker: boolean) => void;
  /** Enter in a text field — the host's submit. */
  onEnter?: () => void;
  nameSeed?: string;
  urlLabel?: string;
  urlPlaceholder?: string;
  initialUrl?: string;
  initialBranch?: string;
  /** Off while the host is closed, so nothing is fetched. */
  enabled?: boolean;
  testIdPrefix: string;
}

const DEFAULT_MODES: readonly GitTargetMode[] = ['existing', 'new'];

/**
 * THE repository chooser: an existing repo (pasted, or browsed on GitHub, with
 * its branch), a brand-new one, or "Flowpad git". Every git surface — set up
 * Git, clone, add a Git package, add a help desk — embeds this, and it is the
 * only place a "Connect GitHub" button is rendered (via `GitRemoteField`, which
 * starts the device flow the global `GitHubDeviceFlowModal` shows).
 */
export function GitRepoPicker({
  modes = DEFAULT_MODES,
  onChange,
  onStepChange,
  onEnter,
  nameSeed = '',
  urlLabel,
  urlPlaceholder,
  initialUrl = '',
  initialBranch,
  enabled = true,
  testIdPrefix,
}: GitRepoPickerProps): React.ReactElement {
  const { t } = useLingui();
  const [mode, setMode] = useState<GitTargetMode>(modes[0] ?? 'existing');
  const [remote, setRemote] = useState<GitRemoteValue>({ url: initialUrl, branch: initialBranch ?? null });
  const [name, setName] = useState(nameSeed);
  const [inBranchPicker, setInBranchPicker] = useState(false);

  useEffect(() => {
    onStepChange?.(inBranchPicker);
  }, [inBranchPicker, onStepChange]);

  useEffect(() => {
    if (mode === 'flowpad') onChange({ mode });
    else if (mode === 'new') onChange(name.trim() ? { mode, name: name.trim() } : null);
    else
      onChange(
        remote.url.trim()
          ? { mode, url: remote.url.trim(), ...(remote.branch ? { branch: remote.branch } : {}) }
          : null,
      );
  }, [mode, name, remote, onChange]);

  const options: Record<GitTargetMode, { icon: React.ReactNode; label: React.ReactNode; title: string }> = {
    existing: {
      icon: <GitBranch className="h-3 w-3" />,
      label: <Trans>Existing repo</Trans>,
      title: t`Use a repository that already exists`,
    },
    new: {
      icon: <Plus className="h-3 w-3" />,
      label: <Trans>New repo</Trans>,
      title: t`Create a brand-new repository`,
    },
    flowpad: {
      icon: <Cloud className="h-3 w-3" />,
      label: <Trans>Flowpad git</Trans>,
      title: t`Hosted by Flowpad — use it when you have no GitHub`,
    },
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {!inBranchPicker && modes.length > 1 && (
        <div className="flex items-center justify-center gap-1" role="radiogroup">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              title={options[m].title}
              onClick={() => setMode(m)}
              data-testid={`${testIdPrefix}-mode-${m}`}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                mode === m
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
              }`}
            >
              {options[m].icon}
              {options[m].label}
            </button>
          ))}
        </div>
      )}

      <div className="grid min-w-0 gap-1.5 py-1">
        {mode === 'existing' && (
          <GitRemoteField
            value={remote}
            onChange={setRemote}
            onStepChange={setInBranchPicker}
            urlLabel={urlLabel}
            urlPlaceholder={urlPlaceholder}
            testIdPrefix={testIdPrefix}
            onEnter={onEnter}
            enabled={enabled}
            autoFocus
          />
        )}
        {mode === 'new' && (
          <>
            <Label htmlFor={`${testIdPrefix}-name`}>
              <Trans>Repository name</Trans>
            </Label>
            <Input
              id={`${testIdPrefix}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={nameSeed || t`my-context`}
              autoComplete="off"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) onEnter?.();
              }}
              data-testid={`${testIdPrefix}-name`}
            />
          </>
        )}
        {mode === 'flowpad' && (
          <p className="text-xs text-muted-foreground" data-testid={`${testIdPrefix}-flowpad-note`}>
            <Trans>Flowpad keeps the repository for you. No GitHub account needed.</Trans>
          </p>
        )}
      </div>
    </div>
  );
}

export default GitRepoPicker;

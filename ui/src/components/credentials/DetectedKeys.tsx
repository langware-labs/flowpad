import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { PackagePlus } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import type { DetectedGroup } from '@src/components/credentials-view/credential-rows';

/**
 * Keys found in a `.env.local` that no credential declares yet.
 *
 * Listed, never used: only a declared variable reaches a process. Selecting
 * several and packing them makes one credential of them — the values stay
 * exactly where they are.
 */
export function DetectedKeys({
  groups,
  onPack,
}: {
  groups: DetectedGroup[];
  onPack: (group: DetectedGroup, keys: string[]) => void;
}) {
  if (!groups.length) return null;
  return (
    <div className="mt-6 max-w-5xl space-y-4" data-testid="detected-keys">
      {groups.map((group) => (
        <DetectedGroupCard key={`${group.scope}:${group.projectId ?? ''}`} group={group} onPack={onPack} />
      ))}
    </div>
  );
}

function DetectedGroupCard({
  group,
  onPack,
}: {
  group: DetectedGroup;
  onPack: (group: DetectedGroup, keys: string[]) => void;
}) {
  const { t } = useLingui();
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const allKeys = group.keys.map((k) => k.key);
  // Derived, so a key that was packed or left the file drops out on its own.
  const picked = allKeys.filter((k) => selected.has(k));
  const allSelected = picked.length > 0 && picked.length === allKeys.length;

  const toggle = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <section className="rounded-md border" data-testid={`detected-group-${group.scope}`}>
      <header className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
        <Checkbox
          checked={allSelected}
          onCheckedChange={(on) => setSelected(on ? new Set(allKeys) : new Set())}
          aria-label={t`Select all`}
          data-testid={`detected-select-all-${group.scope}`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {group.scope === 'user' ? (
              <Trans>Found in .env.local in your home folder</Trans>
            ) : (
              <Trans>Found in this project's .env.local</Trans>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={group.path ?? undefined}>
            <Trans>Not used by any credential yet. Pack the keys that belong together into one credential.</Trans>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5"
          disabled={picked.length === 0}
          onClick={() => onPack(group, picked)}
          data-testid={`detected-pack-${group.scope}`}
        >
          <PackagePlus className="h-3.5 w-3.5" />
          {picked.length > 0 ? <Trans>Pack {picked.length} into a credential</Trans> : <Trans>Pack into a credential</Trans>}
        </Button>
      </header>
      <ul className="divide-y">
        {group.keys.map((k) => (
          <li key={k.key} className="flex items-center gap-3 px-3 py-1.5">
            <Checkbox
              id={`detected-${group.scope}-${k.key}`}
              checked={selected.has(k.key)}
              onCheckedChange={(on) => toggle(k.key, on === true)}
              data-testid={`detected-key-${group.scope}-${k.key}`}
            />
            <label htmlFor={`detected-${group.scope}-${k.key}`} className="flex-1 cursor-pointer font-mono text-xs">
              {k.key}
            </label>
            <span className="text-xs text-muted-foreground">
              <Trans>line {k.line}</Trans>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

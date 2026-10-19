import * as React from 'react';
import type { CredentialManifestVar } from '@sdk';
import { VariableDetails } from './VariableDetails';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { DetectedGroup } from '@src/components/credentials-view/credential-rows';

export interface DetectedKeyDetails {
  key: string;
  value: string;
  spec?: CredentialManifestVar;
}

type SaveDetails = (group: DetectedGroup, details: DetectedKeyDetails[]) => Promise<void>;

/** Edit details once; the backend finds or creates the credential for each key. */
export function DetectedKeys({ groups, onSave }: { groups: DetectedGroup[]; onSave: SaveDetails }) {
  if (!groups.length) return null;
  return (
    <div className="mt-6 max-w-5xl space-y-4" data-testid="detected-keys">
      {groups.map((group) => (
        <DetectedGroupCard key={`${group.scope}:${group.projectId ?? ''}:${group.path ?? ''}`} group={group} onSave={onSave} />
      ))}
    </div>
  );
}

function DetectedGroupCard({ group, onSave }: { group: DetectedGroup; onSave: SaveDetails }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [details, setDetails] = React.useState<Record<string, string>>({});
  const [specs, setSpecs] = React.useState<Record<string, CredentialManifestVar>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [added, setAdded] = React.useState<DetectedKeyDetails[]>([]);
  const updateAdded = (index: number, patch: Partial<DetectedKeyDetails>) =>
    setAdded((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const rows = [...group.keys.filter(({ key, spec }) => !spec || details[key] || specs[key])
        .map(({ key }) => ({ key, value: details[key] ?? '', spec: specs[key] })), ...added];
      if (new Set([...group.keys, ...added].map(({ key }) => key)).size !== group.keys.length + added.length) {
        setError(t`Each variable needs a unique name.`);
        return;
      }
      await onSave(group, rows);
      setAdded([]);
      setDetails({});
      setSpecs({});
    } catch (cause) {
      setError(errorMessage(cause, t`Could not save environment variables. Your edits are still here; try again.`));
    } finally {
      setSaving(false);
    }
  };
  const fileName = group.name;
  return (
    <form onSubmit={(event) => void save(event)} className="rounded-md border" data-testid={`detected-group-${group.scope}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-3 py-2">
        <h3 className="text-sm font-medium"><Trans>Environment variables</Trans></h3>
        <span className="text-xs text-muted-foreground" title={group.path ?? undefined}>{fileName}</span>
      </header>
      <div className="hidden grid-cols-2 gap-3 border-b px-3 py-1 text-xs text-muted-foreground sm:grid" aria-hidden="true">
        <span><Trans>Name</Trans></span>
        <span><Trans>Value</Trans></span>
      </div>
      <fieldset disabled={saving} className="divide-y">
        {group.keys.map(({ key, line, spec }) => (
          <div key={key} className="grid grid-cols-2 items-center gap-x-3 gap-y-1 px-3 py-1">
            <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
              <span className="break-all font-mono">{key}</span>
              {group.path && (
                <button type="button" className="shrink-0 text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  aria-label={t`Open ${key} in ${fileName} at line ${line}`}
                  title={`${group.path}:${line}`}
                  onClick={() => navigation.openFile(group.path!, { line })}>
                  <Trans>line {line}</Trans>
                </button>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <Input className="h-7 text-xs" type={(specs[key]?.secret ?? spec?.secret ?? true) ? "password" : "text"} autoComplete="new-password" value={details[key] ?? ''}
                placeholder={t`Unchanged`} aria-label={t`Value for ${key}`}
                onChange={(event) => setDetails((previous) => ({ ...previous, [key]: event.target.value }))} />
              <VariableDetails name={key} spec={{ ...spec, ...specs[key] }} disabled={saving}
                onChange={(patch) => setSpecs((previous) => ({ ...previous, [key]: { ...previous[key], ...patch } }))} />
            </div>
          </div>
        ))}
        {added.map((row, index) => (
          <div key={index} className="grid grid-cols-2 items-center gap-3 px-3 py-1">
            <Input className="h-7 font-mono text-xs" value={row.key} required pattern="[A-Za-z_][A-Za-z0-9_]*"
              placeholder={t`NAME`} aria-label={t`New variable name ${index + 1}`}
              onChange={(event) => updateAdded(index, { key: event.target.value })} />
            <div className="flex min-w-0 items-center gap-2">
              <Input className="h-7 text-xs" type={row.spec?.secret === false ? "text" : "password"} autoComplete="new-password" value={row.value} required
                placeholder={t`Value`} aria-label={t`New variable value ${index + 1}`}
                onChange={(event) => updateAdded(index, { value: event.target.value })} />
              <VariableDetails name={row.key || t`New variable ${index + 1}`} spec={row.spec ?? {}} disabled={saving}
                onChange={(patch) => updateAdded(index, { spec: { ...row.spec, ...patch } })} />
              <button type="button" className="px-1 text-muted-foreground hover:text-foreground"
                aria-label={t`Remove new variable ${index + 1}`} onClick={() => setAdded((rows) => rows.filter((_, i) => i !== index))}>×</button>
            </div>
          </div>
        ))}
      </fieldset>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
        <Button type="button" variant="ghost" size="sm" className="h-7" disabled={saving}
          onClick={() => setAdded((rows) => [...rows, { key: '', value: '' }])}>
          <Trans>Add variable</Trans>
        </Button>
        {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
        <Button type="submit" size="sm" className="h-7" disabled={saving || (!group.keys.length && !added.length)}>
          {saving ? <Trans>Saving…</Trans> : <Trans>Save details</Trans>}
        </Button>
      </footer>
    </form>
  );
}

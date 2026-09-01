/**
 * The models reachable through an endpoint — the union of its roots' catalogs
 * after the effective allow/deny filters — with a filter box and the root each
 * comes from.
 */
import type { LLMEndpoint } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useState } from 'react';

import { Input } from '@src/components/ui/input';

import { useLlmEndpointModels } from './use-llm-endpoints';

export function ModelsList({ endpointId, all }: { endpointId: string; all: readonly LLMEndpoint[] }) {
  const { t } = useLingui();
  const [needle, setNeedle] = useState('');
  const { data, isLoading, error } = useLlmEndpointModels(endpointId);
  const names = useMemo(() => new Map(all.map((e) => [e.id, e.name])), [all]);
  const rows = useMemo(() => {
    const q = needle.trim().toLowerCase();
    return (data ?? []).filter((m) => !q || m.id.toLowerCase().includes(q));
  }, [data, needle]);

  return (
    <div className="space-y-3" data-testid="models-list">
      <div className="flex items-center gap-3">
        <Input
          value={needle}
          placeholder={t`Filter models…`}
          onChange={(e) => setNeedle(e.target.value)}
          className="max-w-xs"
        />
        <span className="text-xs text-muted-foreground">
          {data ? t`${rows.length} of ${data.length}` : isLoading ? '…' : ''}
        </span>
        {error && (
          <span className="text-xs text-destructive">
            <Trans>Could not load models.</Trans>
          </span>
        )}
      </div>
      <ul className="divide-y rounded-md border text-sm">
        {rows.length === 0 && !isLoading && (
          <li className="px-3 py-6 text-center text-muted-foreground">
            <Trans>No models.</Trans>
          </li>
        )}
        {rows.map((m) => (
          <li key={`${m.root_id}:${m.id}`} className="flex items-center justify-between gap-2 px-3 py-1.5">
            <code className="truncate font-mono text-xs">{m.id}</code>
            <span className="shrink-0 text-xs text-muted-foreground">{names.get(m.root_id) ?? m.root_id}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

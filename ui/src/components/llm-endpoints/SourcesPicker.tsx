/**
 * A chain's ordered sources. Order IS the fallback order, so the rows carry
 * up/down rather than being a sorted set. Candidates exclude the endpoint
 * itself and anything already picked; a native select keeps this trivially
 * testable and keyboard-friendly.
 */
import type { LLMEndpoint } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@src/components/ui/button';
import { Label } from '@src/components/ui/label';

import { endpointTypeId } from './endpoint-catalog';

export interface SourcesPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Every endpoint the user can see; the picker offers those not already picked. */
  all: readonly LLMEndpoint[];
  /** The endpoint being edited (excluded from candidates). */
  selfId?: string;
  disabled?: boolean;
}

export function SourcesPicker({ value, onChange, all, selfId, disabled }: SourcesPickerProps) {
  const { t } = useLingui();
  const [pending, setPending] = useState('');
  const byTypeId = new Map(all.map((e) => [endpointTypeId(e.id), e]));
  const selfTypeId = selfId ? endpointTypeId(selfId) : undefined;
  const candidates = all.filter((e) => {
    const tid = endpointTypeId(e.id);
    return tid !== selfTypeId && !value.includes(tid);
  });

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const add = () => {
    if (!pending) return;
    onChange([...value, pending]);
    setPending('');
  };

  return (
    <div className="space-y-1.5" data-testid="sources-picker">
      <Label>
        <Trans>Sources (fallback order)</Trans>
        <span className="ms-1 text-destructive">*</span>
      </Label>
      <ol className="space-y-1">
        {value.map((tid, i) => {
          const source = byTypeId.get(tid);
          return (
            <li
              key={tid}
              data-testid={`source-row-${tid}`}
              className="flex items-center gap-2 rounded border border-border/60 bg-muted/20 px-2 py-1 text-sm"
            >
              <span className="w-5 text-xs text-muted-foreground">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate">
                {source ? source.name : tid}
                {source && (
                  <span className="ms-2 text-xs text-muted-foreground">
                    {source.kind === 'root' ? source.provider : t`chain`}
                  </span>
                )}
                {!source && (
                  <span className="ms-2 text-xs text-destructive">
                    <Trans>not visible to you</Trans>
                  </span>
                )}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t`Move up`}
                disabled={disabled || i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t`Move down`}
                disabled={disabled || i === value.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t`Remove source`}
                disabled={disabled}
                onClick={() => onChange(value.filter((v) => v !== tid))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          );
        })}
      </ol>
      <div className="flex gap-2">
        <select
          className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          value={pending}
          disabled={disabled || candidates.length === 0}
          onChange={(e) => setPending(e.target.value)}
          aria-label={t`Add a source`}
          data-testid="source-select"
        >
          <option value="">{candidates.length ? t`Add a source…` : t`No other endpoints`}</option>
          {candidates.map((e) => (
            <option key={e.id} value={endpointTypeId(e.id)}>
              {e.name} ({e.kind === 'root' ? e.provider : t`chain`})
            </option>
          ))}
        </select>
        <Button type="button" variant="outline" disabled={disabled || !pending} onClick={add} data-testid="source-add">
          <Trans>Add</Trans>
        </Button>
      </div>
    </div>
  );
}

/**
 * The endpoint a new allocation draws from.
 *
 * One parent, chosen once. The hub makes the link a `source_llmendpoint` relationship written only
 * by `allocate`, which is addressed TO the endpoint being drawn from — so there is nothing to
 * reorder and nothing to change afterwards. This replaces an ordered multi-source picker: that
 * shape came from a client-writable `sources` field the hub removed, because a list checked against
 * nothing let anyone who could merely spend a pool hang an uncapped sibling off it.
 *
 * A native select keeps this trivially testable and keyboard-friendly.
 */
import type { LLMEndpoint } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { Label } from '@src/components/ui/label';

import { endpointTypeId } from './endpoint-catalog';

export interface SourcePickerProps {
  /** The chosen parent's typeid, or '' for none yet. */
  value: string;
  onChange: (next: string) => void;
  /** Every endpoint the user can see; all of them are candidates to draw from. */
  all: readonly LLMEndpoint[];
  disabled?: boolean;
}

export function SourcePicker({ value, onChange, all, disabled }: SourcePickerProps) {
  const { t } = useLingui();

  return (
    <div className="space-y-1.5" data-testid="source-picker">
      <Label htmlFor="llm-source">
        <Trans>Draws from</Trans>
        <span className="ms-1 text-destructive">*</span>
      </Label>
      <select
        id="llm-source"
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        value={value}
        disabled={disabled || all.length === 0}
        onChange={(e) => onChange(e.target.value)}
        data-testid="source-select"
      >
        <option value="">{all.length ? t`Choose an endpoint…` : t`No endpoints to draw from`}</option>
        {all.map((e) => (
          <option key={e.id} value={endpointTypeId(e.id)}>
            {e.name} ({e.kind === 'root' ? e.provider : t`chain`})
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        <Trans>Fixed once created, and you must be able to administer it — this endpoint spends its budget.</Trans>
      </p>
    </div>
  );
}

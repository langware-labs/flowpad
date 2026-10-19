/**
 * `from → to` rows for `filters.aliases` and `filters.model_map`. One editor,
 * two titles — the shape is identical and only the hub's interpretation differs.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Plus, X } from 'lucide-react';

import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';

import type { MappingRow } from './filters-limits-forms';

export interface AliasesEditorProps {
  title: string;
  rows: MappingRow[];
  onChange: (rows: MappingRow[]) => void;
  disabled?: boolean;
  testId?: string;
}

export function AliasesEditor({ title, rows, onChange, disabled, testId }: AliasesEditorProps) {
  const { t } = useLingui();
  const update = (i: number, patch: Partial<MappingRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1" data-testid={testId}>
      <Label>{title}</Label>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={t`From`}
            value={row.from}
            disabled={disabled}
            placeholder={t`from`}
            onChange={(e) => update(i, { from: e.target.value })}
          />
          <span className="text-muted-foreground">→</span>
          <Input
            aria-label={t`To`}
            value={row.to}
            disabled={disabled}
            placeholder={t`to`}
            onChange={(e) => update(i, { to: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t`Remove row`}
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7"
        disabled={disabled}
        onClick={() => onChange([...rows, { from: '', to: '' }])}
      >
        <Plus className="me-1 h-3.5 w-3.5" />
        <Trans>Add row</Trans>
      </Button>
    </div>
  );
}

import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Loader2 } from 'lucide-react';
import React, { useState } from 'react';

interface ProvideValueInlineProps {
  /** Used only for test ids and the aria label — the caller owns the write. */
  envVar: string;
  prompt?: string;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * The inline "type the value here" wizard. Lifted out of ProjectHome's Secrets
 * card so several surfaces could provide a value the same way; both of those
 * surfaces have since been retired, and the sole consumer is now the Connections
 * table's setup panel (`connections-manager/credential-rows-view.tsx`).
 *
 * It never reads a value back and never receives one — providing is one-way. The
 * caller decides where the value goes (`provide-secret` routes it to the
 * declaration's designated store).
 */
export const ProvideValueInline: React.FC<ProvideValueInlineProps> = ({
  envVar,
  prompt,
  onSubmit,
  onCancel,
}) => {
  const { t } = useLingui();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="password"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') onCancel();
        }}
        placeholder={prompt || t`Enter value`}
        aria-label={t`Value for ${envVar}`}
        className="h-7 max-w-xs text-xs"
        data-testid={`env-value-input-${envVar}`}
      />
      <Button
        size="sm"
        className="h-7"
        disabled={busy || !value.trim()}
        onClick={() => void submit()}
        data-testid={`env-value-save-${envVar}`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trans>Save</Trans>}
      </Button>
      <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>
        <Trans>Cancel</Trans>
      </Button>
    </div>
  );
};

/**
 * Rename a token source in place: a pencil beside its name, an input on click, saved through the
 * hub's `rename` (its holder may name their own budget; only an admin may `update` it).
 */
import { llmEndpointsService, type LLMEndpoint } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { Pencil } from 'lucide-react';
import { useState } from 'react';

export function RenameButton({ endpoint, onRenamed }: { endpoint: LLMEndpoint; onRenamed: () => void }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!endpoint.canRename) return null;

  const save = async () => {
    if (draft === null) return;
    const name = draft.trim();
    if (name === endpoint.name) return setDraft(null);
    setBusy(true);
    try {
      await llmEndpointsService.rename(endpoint.id, name);
      onRenamed();
    } finally {
      setBusy(false);
      setDraft(null);
    }
  };

  if (draft !== null) {
    return (
      <input
        autoFocus
        disabled={busy}
        value={draft}
        aria-label={t`Name`}
        placeholder={t`Name (optional)`}
        data-testid={`rename-input-${endpoint.id}`}
        className="ms-1 h-6 min-w-0 flex-1 rounded border bg-background px-1.5 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      title={t`Rename`}
      data-testid={`rename-${endpoint.id}`}
      className="ms-1.5 shrink-0 text-muted-foreground opacity-60 hover:text-foreground hover:opacity-100"
      onClick={() => setDraft(endpoint.name)}
    >
      <Pencil className="h-3 w-3" />
    </button>
  );
}

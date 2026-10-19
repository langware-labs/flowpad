import { useLingui } from '@lingui/react/macro';
import { Plus } from 'lucide-react';

/**
 * The green "+ New" pill a chat header leads with (Vibe's build chat, the
 * Flowpad Assistant) — one look for "start a fresh conversation" wherever the
 * panel's `leadingSlot` hosts it.
 */
export function NewSessionPill({
  onClick,
  disabled,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  /** Tooltip, e.g. "New build" / "New chat". */
  title: string;
}) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid="entity-execution-new"
      className="inline-flex h-6 items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-2 text-xs font-medium text-green-600 transition-colors hover:bg-green-500/20 hover:text-green-700 disabled:cursor-not-allowed disabled:opacity-60 dark:text-green-400 dark:hover:text-green-300"
    >
      <Plus className="h-3 w-3" />
      {t`New`}
    </button>
  );
}

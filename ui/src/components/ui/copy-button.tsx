import { copyToClipboard } from '@sdk';
import { cn } from '@src/lib/utils';
import { Check, Copy, type LucideIcon } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';

/**
 * "Copied!" flash state. Every copy affordance in the app owns the same
 * `const [copied, setCopied]` + `setTimeout(reset)` pair; this is that pair,
 * for the surfaces whose button chrome is too specific for `<CopyButton>`.
 */
export function useCopied(resetMs = 1500): { copied: boolean; copy: (value: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (value: string) => {
      await copyToClipboard(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );

  return { copied, copy };
}

interface CopyButtonProps {
  /** Text to copy, or a getter for content that is only known at click time. */
  value: string | (() => string);
  testId?: string;
  className?: string;
  /** title + aria-label. */
  title?: string;
  /** Idle-state glyph. Defaults to the clipboard. */
  icon?: LucideIcon;
  iconClassName?: string;
  /** Class for the check glyph, for the surfaces that tint it green. */
  copiedIconClassName?: string;
  /** Text after the glyph; `copiedLabel` replaces it during the flash. */
  label?: ReactNode;
  copiedLabel?: ReactNode;
  /** Content rendered BEFORE the glyph (e.g. the path in a path row). */
  children?: ReactNode;
  /** For copy buttons sitting inside a clickable row. */
  stopPropagation?: boolean;
  resetMs?: number;
}

/**
 * The one copy button. Icon flips to a check for `resetMs`, then back.
 *
 * Callers keep their own chrome through `className` / `icon` / `label` rather
 * than each re-deriving the copied-state timer.
 */
export function CopyButton({
  value,
  testId,
  className,
  title,
  icon: Idle = Copy,
  iconClassName = 'h-3 w-3',
  copiedIconClassName,
  label,
  copiedLabel,
  children,
  stopPropagation = false,
  resetMs,
}: CopyButtonProps) {
  const { copied, copy } = useCopied(resetMs);

  return (
    <button
      type="button"
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        void copy(typeof value === 'function' ? value() : value);
      }}
      title={title}
      aria-label={title}
      data-testid={testId}
      className={cn('flex items-center gap-1', className)}
    >
      {children}
      {copied ? (
        <Check className={cn(iconClassName, 'shrink-0', copiedIconClassName)} />
      ) : (
        <Idle className={cn(iconClassName, 'shrink-0')} />
      )}
      {label !== undefined && (copied ? (copiedLabel ?? label) : label)}
    </button>
  );
}

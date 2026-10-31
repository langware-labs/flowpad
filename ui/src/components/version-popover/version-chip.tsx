import { useLingui } from '@lingui/react/macro';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';

interface VersionChipProps extends ComponentPropsWithoutRef<'button'> {
  version: string;
  /** Shows the amber "update available" dot. */
  updateAvailable?: boolean;
}

/** The footer's `v<version>` chip — one look for the desktop and the hub popovers. */
export const VersionChip = forwardRef<HTMLButtonElement, VersionChipProps>(function VersionChip(
  { version, updateAvailable, ...props },
  ref,
) {
  const { t } = useLingui();
  const label = t`Flowpad version`;
  return (
    <button
      ref={ref}
      type="button"
      className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={label}
      aria-label={label}
      {...props}
    >
      <span>v{version}</span>
      {updateAvailable && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label={t`Update available`} />}
    </button>
  );
});

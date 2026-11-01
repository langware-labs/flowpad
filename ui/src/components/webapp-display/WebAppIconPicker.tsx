import { useLingui } from '@lingui/react/macro';
import { WebApp } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { IconPicker } from '@src/components/ui/icon-picker';
import { cn } from '@src/lib/utils';
import { WebAppIcon } from './WebAppIcon';

/** The app's icon as a button that opens the icon picker; `null` clears it back to the type's icon. */
export function WebAppIconPicker({
  app,
  onChange,
  disabled,
  className,
  iconClassName,
  testId,
}: {
  app: WebApp;
  onChange: (icon: string | undefined) => void;
  disabled?: boolean;
  className?: string;
  iconClassName?: string;
  testId?: string;
}) {
  const { t } = useLingui();
  // `app.icon` falls back to the type's glyph; the picker shows only the app's own choice.
  const own = app.icon === WebApp.icon ? null : app.icon;
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={t`Change icon`}
          data-testid={testId}
          className={cn('flex shrink-0 items-center justify-center', className)}
        >
          <WebAppIcon app={app} className={iconClassName} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <IconPicker value={own} onChange={(icon) => onChange(icon ?? undefined)} />
      </PopoverContent>
    </Popover>
  );
}

import { Card } from '@src/components/ui/card';
import { Label } from '@src/components/ui/label';
import { ReactNode } from 'react';

/**
 * Shared settings-row layout used by the Preferences screen and the account
 * Settings dialog so both read as one consistent surface: a grouped card of rows,
 * each binding its control to its label.
 */

/**
 * A grouped settings card — a bordered, translucent container whose direct children
 * ({@link SettingRow}) are separated by hairline dividers.
 */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card
      className={`divide-y divide-border/60 overflow-hidden border-border/70 bg-card/30 shadow-sm ${className ?? ''}`}
    >
      {children}
    </Card>
  );
}

/**
 * One settings row inside a {@link SettingsCard}. By default the control sits in a
 * tight right column beside its label (toggles, selects, numbers, short inputs);
 * `block` stacks a full-width control under the label (multi-line editors). The whole
 * row shares one hover surface so the control always reads as part of its label.
 *
 * `label`/`description` accept any node, so both plain strings (registry prefs) and
 * `<Trans>` elements (the i18n'd account settings) work.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  control,
  block = false,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  control: ReactNode;
  block?: boolean;
}) {
  const header = (
    <div className="min-w-0">
      <Label htmlFor={htmlFor} className="cursor-pointer text-sm font-medium text-foreground">
        {label}
      </Label>
      {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
    </div>
  );

  if (block) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-muted/30">
        {header}
        {control}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4 transition-colors hover:bg-muted/30">
      {header}
      <div className="flex shrink-0 items-center">{control}</div>
    </div>
  );
}

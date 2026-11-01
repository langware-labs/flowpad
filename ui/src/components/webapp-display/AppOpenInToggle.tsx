import { useLingui } from '@lingui/react/macro';
import { SegmentedControl } from '@src/components/ui/segmented-control';

export type AppOpenIn = 'flowpad' | 'browser';

/** Where a click on the app opens it — a Flowpad tab (the default) or the system browser. Reads an app or its manifest. */
export function appOpenIn(app: { open_in?: unknown }): AppOpenIn {
  return app.open_in === 'browser' ? 'browser' : 'flowpad';
}

/** The `webapp.json` patch for a choice: the default is no key at all. */
export const openInPatch = (value: AppOpenIn) => ({ open_in: value === 'flowpad' ? undefined : value });

export function AppOpenInToggle({
  value,
  onChange,
  disabled,
}: {
  value: AppOpenIn;
  onChange: (value: AppOpenIn) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  return (
    <SegmentedControl
      options={[
        ['flowpad', t`Flowpad tab`],
        ['browser', t`Browser`],
      ]}
      value={value}
      onChange={onChange}
      disabled={disabled}
      ariaLabel={t`Opens in`}
      testId="app-open-in"
    />
  );
}

import { Trans, useLingui } from '@lingui/react/macro';
import { sdkConfig } from '@sdk/config/index';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { VersionChip } from '@src/components/version-popover/version-chip';

interface HubReleaseLabelProps {
  /** The hub's own release, from `bootstrap.env.version`. Null until the hub ships it. */
  hubVersion: string | null;
}

/**
 * The hub footer's version chip — the same chip as the desktop's `VersionPopover`,
 * but its popover is read-only: every desktop action (version/check, pip upgrade,
 * restart) is desk-only.
 *
 * The popover lists two numbers, because they are two different releases: `hub`
 * is the package serving this page, `ui` is the flow_sdk release THIS bundle was
 * built from — which the hub cannot know, since the frontend is deployed
 * independently of it.
 */
export function HubReleaseLabel({ hubVersion }: HubReleaseLabelProps) {
  const { t } = useLingui();
  const chipVersion = sdkConfig.ui_version || hubVersion;
  if (!chipVersion) return null;

  const rows = [
    [t`Hub`, hubVersion],
    [t`UI`, sdkConfig.ui_version],
  ].filter(([, value]) => value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <VersionChip version={chipVersion} data-testid="hub-release-label" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 p-3">
        <h3 className="mb-2 text-sm font-semibold">
          <Trans>Flowpad</Trans>
        </h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="hub-release-details">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

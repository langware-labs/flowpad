import { useLingui } from '@lingui/react/macro';
import { sdkConfig } from '@sdk/config/index';

interface HubReleaseLabelProps {
  /** The hub's own release, from `bootstrap.env.version`. Null until the hub ships it. */
  hubVersion: string | null;
}

/**
 * The hub footer's release label — the read-only stand-in for `VersionPopover`,
 * whose every action (version/check, pip upgrade, restart) is desk-only.
 *
 * Two numbers, because they are two different releases and showing only one
 * would be a lie about the other: `hub` is the package serving this page, `ui`
 * is the flow_sdk release THIS bundle was built from — which the hub cannot
 * know, since the frontend is deployed independently of it. On the desktop the
 * two are the same number, which is why the desk footer shows a single version.
 */
export function HubReleaseLabel({ hubVersion }: HubReleaseLabelProps) {
  const { t } = useLingui();

  const label = [hubVersion && `hub ${hubVersion}`, sdkConfig.ui_version && `ui ${sdkConfig.ui_version}`]
    .filter(Boolean)
    .join(' · ');
  if (!label) return null;

  return (
    <span
      data-testid="hub-release-label"
      title={t`Hub release, and the UI build serving it`}
      className="shrink-0 whitespace-nowrap px-1 text-[10px] text-muted-foreground"
    >
      {label}
    </span>
  );
}

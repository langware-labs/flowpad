import { Trans, useLingui } from '@lingui/react/macro';
import { Check, Globe } from 'lucide-react';
import { browserProfileManager, useSelectedBrowserProfile, type Browser } from '@src/lib/browser-profiles';
import {
  DropdownMenuItem, DropdownMenuPortal, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@src/components/ui/dropdown-menu';
import { BrowserProfileItems, ProfileLabel } from './BrowserProfileItems';

/** The same remembered profile and current selection on every settings surface. */
export function BrowserProfileMenu({ browsers, testIdPrefix }: { browsers: Browser[]; testIdPrefix: string }) {
  const { t } = useLingui();
  const selected = useSelectedBrowserProfile();
  const profile = browserProfileManager.profile(browsers, selected);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={testIdPrefix} className="items-start gap-2 text-xs">
        <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className="font-medium"><Trans>Browser profile</Trans></span>
          <span className="truncate text-[11px] text-muted-foreground">
            {profile ? <ProfileLabel profile={profile} /> : selected ? `${selected.browser} / ${selected.profile}` : t`System default`}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="max-h-80 max-w-sm overflow-y-auto">
          <DropdownMenuItem onSelect={() => browserProfileManager.select(null)} data-testid={`${testIdPrefix}-default`}>
            <Check className={`mr-2 h-4 w-4 ${selected ? 'invisible' : ''}`} />
            <Trans>System default</Trans>
          </DropdownMenuItem>
          <BrowserProfileItems
            browsers={browsers}
            onSelect={(browser, profile) => browserProfileManager.select({ browser, profile })}
            isSelected={(browser, profile) => selected?.browser === browser && selected.profile === profile}
            testIdPrefix={testIdPrefix}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

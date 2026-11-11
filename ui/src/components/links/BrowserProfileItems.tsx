import { Check } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@src/components/ui/dropdown-menu';
import type { Browser, BrowserProfile } from '@src/lib/browser-profiles';

/** Every installed browser's profiles as menu items, grouped under the browser's name. */
export function BrowserProfileItems({
  browsers,
  onSelect,
  testIdPrefix,
  isSelected,
}: {
  browsers: Browser[];
  onSelect: (browser: string, profile: string) => void;
  testIdPrefix: string;
  /** Marks the chosen profile with a check (a setting, as opposed to a one-off open). */
  isSelected?: (browser: string, profile: string) => boolean;
}) {
  return (
    <>
      {browsers.map((browser, i) => (
        <div key={browser.id} role="group" aria-label={browser.name}>
          {i > 0 && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{browser.name}</DropdownMenuLabel>
          {browser.profiles.map((profile) => (
            <DropdownMenuItem
              key={profile.id}
              onSelect={() => onSelect(browser.id, profile.id)}
              data-testid={`${testIdPrefix}-${browser.id}-${profile.id}`}
              title={profile.email ?? profile.name}
            >
              {isSelected && (
                <Check className={`mr-2 h-4 w-4 ${isSelected(browser.id, profile.id) ? '' : 'invisible'}`} />
              )}
              <ProfileLabel profile={profile} />
            </DropdownMenuItem>
          ))}
        </div>
      ))}
    </>
  );
}

/** A profile's name, then its email when that says more. */
export function ProfileLabel({ profile }: { profile: BrowserProfile }) {
  return (
    <span className="truncate">
      {profile.name}
      {profile.email && profile.email !== profile.name && (
        <span className="text-muted-foreground"> — {profile.email}</span>
      )}
    </span>
  );
}

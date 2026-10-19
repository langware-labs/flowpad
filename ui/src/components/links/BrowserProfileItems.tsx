import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@src/components/ui/dropdown-menu';
import type { Browser } from '@src/lib/browser-profiles';

/** Every installed browser's profiles as menu items, grouped under the browser's name. */
export function BrowserProfileItems({
  browsers,
  onSelect,
  testIdPrefix,
}: {
  browsers: Browser[];
  onSelect: (browser: string, profile: string) => void;
  testIdPrefix: string;
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
              <span className="truncate">
                {profile.name}
                {profile.email && profile.email !== profile.name && (
                  <span className="text-muted-foreground"> — {profile.email}</span>
                )}
              </span>
            </DropdownMenuItem>
          ))}
        </div>
      ))}
    </>
  );
}

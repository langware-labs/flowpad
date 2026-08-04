import { Avatar, AvatarFallback, AvatarImage } from '@src/components/ui/avatar';
import { User as UserIcon } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

/**
 * Who you are signed in AS, above the things you can do.
 *
 * Three lines, each independently optional: name, title, email. A deployed
 * agent holds its own credential, so this is the only place the box tells you
 * it is the agent and not the person who launched it — hence a real profile
 * rather than a bare name.
 *
 * Split out of `user-dropdown` because that component needs a dozen hooks to
 * mount and this needs none: the identity block is pure presentation, so it can
 * be rendered and asserted on directly.
 */

export interface UserMenuHeaderProps {
  /** Falls back to the email, then to a generic label. */
  name?: string | null;
  /** `title` is a BASE-entity field (flow_sdk `Entity`, hub `Entity`, and
   *  `APIEntity` in ts_sdk), so it needs no per-type plumbing. Absent → the
   *  line is skipped and the email moves up. */
  title?: string | null;
  email?: string | null;
  /** A photo URL renders as the avatar image AND, blurred, as the backdrop. */
  pictureUrl?: string | null;
  /** A glyph (lucide name or emoji) when there is no photo. */
  pictureIcon?: ReactNode;
  /** Initials, used when there is neither. */
  initials?: string | null;
}

export function UserMenuHeader({ name, title, email, pictureUrl, pictureIcon, initials }: UserMenuHeaderProps) {
  // Suppressed when the name line IS the email (a user with no name falls back
  // to it), so the address never appears twice.
  const emailLine = name ? email : null;
  const backdrop = pictureUrl
    ? {
        // Quoted: the value comes off the wire, and a bare url() would let a
        // crafted `picture` close the function and inject further CSS.
        backgroundImage: `url(${JSON.stringify(pictureUrl)})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        filter: 'blur(12px) saturate(1.2)',
        transform: 'scale(1.2)',
      }
    : undefined;

  return (
    <div className="relative overflow-hidden rounded-t-md" data-testid="user-menu-header">
      <div
        className="h-14 w-full bg-gradient-to-br from-primary/30 via-primary/10 to-transparent"
        style={backdrop}
        aria-hidden
      />
      <div className="flex items-center gap-3 px-3 pb-3 pt-2">
        <Avatar className="h-10 w-10 shrink-0 ring-2 ring-background">
          {pictureUrl && <AvatarImage src={pictureUrl} alt={name ?? ''} />}
          <AvatarFallback className="text-base">
            {pictureIcon ?? initials ?? <UserIcon className="h-5 w-5" />}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" data-testid="user-menu-name">
            {name ?? email ?? <Trans>Signed in</Trans>}
          </div>
          {title && (
            <div className="truncate text-xs text-muted-foreground" data-testid="user-menu-title">
              {title}
            </div>
          )}
          {emailLine && (
            <div className="truncate text-xs text-muted-foreground/80" data-testid="user-menu-email">
              {emailLine}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

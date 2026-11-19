import { Trans, useLingui } from '@lingui/react/macro';
import { BreadcrumbChevron } from '@src/components/ui/breadcrumb';
import { Star } from 'lucide-react';
import { Fragment } from 'react';
import type { FavoritesCrumb } from './use-favorites-level';

/**
 * The bookmarks panel's header: where the level below it sits in the favorites
 * tree. The star is the project list; below it the star shrinks to an icon so
 * a project and a folder name fit the panel's width.
 */
export function FavoritesBreadcrumb({ crumbs, goTo }: { crumbs: FavoritesCrumb[]; goTo: (depth: number) => void }) {
  const { t } = useLingui();
  if (crumbs.length === 0) {
    return (
      <span className="flex items-center gap-1">
        <Star className="h-3.5 w-3.5" aria-hidden />
        <Trans>Bookmarks</Trans>
      </span>
    );
  }
  const crumbClass =
    'rounded-sm font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
  const separator = <BreadcrumbChevron className="h-3 w-3 shrink-0 text-muted-foreground" />;
  return (
    <nav aria-label={t`Bookmarks path`} className="flex min-w-0 items-center gap-1" data-testid="bookmarks-breadcrumb">
      <button
        type="button"
        onClick={() => goTo(0)}
        aria-label={t`All bookmarks`}
        title={t`All bookmarks`}
        className={`flex h-6 w-6 shrink-0 items-center justify-center ${crumbClass}`}
      >
        <Star className="h-3.5 w-3.5" aria-hidden />
      </button>
      {crumbs.map((crumb, i) => (
        <Fragment key={crumb.id}>
          {separator}
          {i === crumbs.length - 1 ? (
            <span className="min-w-0 truncate" aria-current="location">
              {crumb.label}
            </span>
          ) : (
            <button type="button" onClick={() => goTo(i + 1)} className={`min-w-0 truncate px-1 ${crumbClass}`}>
              {crumb.label}
            </button>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

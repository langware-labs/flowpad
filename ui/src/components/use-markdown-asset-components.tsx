import type { Components } from 'react-markdown';
import { useMemo } from 'react';
import type { TypeId } from '@sdk';
import { fsStore } from '@sdk/stores/fsStore';
import { hrefPath, isExternalHref, resolveDocRelativePath } from './markdown-asset-links';

/**
 * `MarkdownView` overrides for markdown that lives inside a project folder.
 *
 * Two element types carry document-relative targets that the base renderer
 * cannot resolve, because it only ever sees a string:
 *
 * - **`img`** — `![](./shot.png)` resolves against the SPA route and 404s.
 *   Rewritten to the `fs` download URL for the owning project, the same
 *   absolute-URL channel `MediaViewer` uses.
 * - **`a`** — the base renderer hardcodes `target="_blank"`, so `[next](./b.md)`
 *   opens a blank tab. In-repo links are handed to `onNavigate` instead, and
 *   only genuinely external ones keep the new-tab treatment.
 *
 * Anything with a scheme, protocol-relative, or a bare `#anchor` is left exactly
 * as authored — see `isExternalHref`.
 */
export function useMarkdownAssetComponents({
  projectTypeId,
  docPath,
  onNavigate,
}: {
  /** The project owning the file — pass it explicitly. Helpers that fall back
   *  to the "active" project are wrong here: the portal renders while some
   *  other project may be active. */
  projectTypeId: TypeId | null;
  /** The article being rendered, relative to the project root. Relative targets
   *  resolve against ITS directory, not the project root. */
  docPath: string;
  /** In-repo link click. Omit to render such links as plain text — better than
   *  a link that navigates nowhere. */
  onNavigate?: (resolvedPath: string) => void;
}): Partial<Components> {
  // `fsStore.getState().getDownloadUrl` rather than `useFS(...)`: `useFS`
  // returns a fresh object literal every render, so putting it in the dep array
  // means this memo NEVER hits — and `react-markdown` compares `components` by
  // identity, so a new object re-renders the whole article tree on every
  // render. The store method is the same pure delegate `useFS` wraps.
  return useMemo<Partial<Components>>(() => {
    /** The repo-relative path a target resolves to, or null to leave it be. */
    const resolve = (raw?: string): string | null => {
      if (!raw || !projectTypeId || isExternalHref(raw)) return null;
      return resolveDocRelativePath(docPath, hrefPath(raw));
    };

    return {
      img: ({ src, alt, title }) => {
        const hit = typeof src === 'string' ? resolve(src) : null;
        return (
          <img
            src={hit ? fsStore.getState().getDownloadUrl(projectTypeId!, hit) : src}
            alt={alt ?? ''}
            title={title}
            // Articles are authored without knowing the pane size. Cap BOTH
            // axes: `max-w-full` alone still lets a tall or intrinsically
            // sizeless asset (an SVG with no width) fill the viewport and push
            // the prose off screen.
            className="my-4 h-auto max-h-80 w-auto max-w-full rounded-md border border-border"
          />
        );
      },

      a: ({ href, children }) => {
        const hit = resolve(href);
        // An in-repo link with nowhere to send it renders as plain text — a
        // link that navigates nowhere is worse than no link.
        if (hit && !onNavigate) return <>{children}</>;
        return (
          <a
            href={href}
            className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
            {...(hit
              ? {
                  onClick: (e: React.MouseEvent) => {
                    e.preventDefault();
                    onNavigate?.(hit);
                  },
                }
              : { target: '_blank', rel: 'noopener noreferrer' })}
          >
            {children}
          </a>
        );
      },
    };
  }, [projectTypeId, docPath, onNavigate]);
}

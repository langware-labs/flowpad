import { Trans } from '@lingui/react/macro';
import React, { lazy } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { WikiLabel } from '@src/components/wiki-tip';

/**
 * True when the browser can mint a WebGL context right now. `@sigma/node-image`
 * (pulled in by GraphView's module graph) calls
 * `canvas.getContext('webgl').getParameter(...)` at module evaluation, so the
 * sigma chunk must never be imported when this returns false — gate the lazy
 * import on it, don't just branch inside the mounted view.
 */
export function isWebglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
    return gl != null;
  } catch {
    return false;
  }
}

/**
 * Lazy-load a WebGL-dependent (sigma-bearing) view, falling back to
 * {@link WebglUnavailableView} when the browser cannot mint a WebGL context.
 *
 * This exists because the guard used to be repeated at each `lazy(...)` call
 * site, and two sigma-bearing views added later (`TagGraphView`,
 * `GenericSubgraphView` — both reaching `GraphView` transitively) were written
 * without it. They evaluated the sigma chunk at import time on any WebGL-less
 * client and crashed their React subtree, while their two guarded neighbours
 * degraded gracefully. One seam that cannot be skipped beats a convention that
 * has already been missed twice: route EVERY graph view through this.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own constraint is ComponentType<any>; narrowing it here rejects every real view.
export function lazyWebglView<T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy<T>(() =>
    isWebglAvailable() ? load() : Promise.resolve({ default: WebglUnavailableView as unknown as T }),
  );
}

/** Rendered in place of a graph surface when WebGL is unavailable. */
export function WebglUnavailableView() {
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="webgl-unavailable-view">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border bg-muted/30 p-6 text-center text-sm">
        <AlertTriangle className="h-7 w-7 text-destructive" />
        <div>
          <h2 className="text-base font-semibold text-foreground">
            <Trans>Graph view needs WebGL</Trans>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            <Trans>
              Your browser could not create a WebGL context, so the graph cannot render. This usually means graphics
              acceleration is disabled or the GPU process crashed.
            </Trans>
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            <WikiLabel wikiword="How to enable WebGL" />
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          <RefreshCw className="me-1 h-3.5 w-3.5" />
          <Trans>Retry</Trans>
        </Button>
      </div>
    </div>
  );
}

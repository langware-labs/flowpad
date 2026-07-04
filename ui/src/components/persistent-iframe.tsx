import { Button } from '@src/components/ui/button';
import { Card, CardContent, CardHeader } from '@src/components/ui/card';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

interface PersistentIframeProps {
  src: string;
  cacheKey?: number;
  className?: string;
  onLoad?: () => void;
  onError?: (error: Error) => void;
  onErrorRetry?: () => void;
}

export interface PersistentIframeHandle {
  refresh: () => void;
  /** Post a message to the guest document (parent→iframe channel). */
  postToGuest: (message: unknown) => void;
}

// Global iframe registry that keeps iframes in fixed DOM locations
class IframeRegistry {
  private static instance: IframeRegistry;
  private iframes = new Map<string, HTMLIFrameElement>();
  private containers = new Map<string, HTMLDivElement>();
  private loadingStates = new Map<string, boolean>();
  private errorStates = new Map<string, boolean>();
  private currentTargets = new Map<string, HTMLElement>();
  private resizeObservers = new Map<string, ResizeObserver>();

  static getInstance(): IframeRegistry {
    if (!IframeRegistry.instance) {
      IframeRegistry.instance = new IframeRegistry();
    }
    return IframeRegistry.instance;
  }

  private createPortalContainer(): HTMLDivElement {
    const container = document.createElement('div');
    container.className = 'fixed top-0 left-0 pointer-events-none';
    container.style.width = '100vw';
    container.style.height = '100vh';
    document.body.appendChild(container);
    return container;
  }

  getOrCreateIframe(
    src: string,
    config: {
      onLoad?: () => void;
      onError?: (error: Error) => void;
    },
  ): { iframe: HTMLIFrameElement; container: HTMLDivElement } {
    const key = src;

    if (!this.iframes.has(key)) {
      // Create portal container that stays in a fixed DOM location
      const container = this.createPortalContainer();

      // Create iframe wrapper
      const iframeWrapper = document.createElement('div');
      iframeWrapper.className = 'absolute opacity-0 pointer-events-none transition-opacity duration-200';

      // Create iframe
      const iframe = document.createElement('iframe');
      iframe.className = 'w-full h-full border-0';
      iframe.sandbox =
        'allow-scripts allow-same-origin allow-forms allow-modals allow-orientation-lock allow-pointer-lock allow-presentation allow-popups-to-escape-sandbox allow-popups allow-downloads allow-storage-access-by-user-activation';
      iframe.allow =
        'accelerometer; autoplay; camera; encrypted-media; fullscreen; geolocation; gyroscope; microphone; midi; clipboard-read; clipboard-write; payment; usb; xr-spatial-tracking; screen-wake-lock; magnetometer; gamepad; picture-in-picture; display-capture';

      // Set initial loading state
      this.loadingStates.set(key, true);
      this.errorStates.set(key, false);

      const loadTimeout = setTimeout(() => {
        console.warn('iframe load timeout', key);
        this.loadingStates.set(key, false);
        this.errorStates.set(key, true);
        config.onError?.(new Error(`Failed to load iframe: ${src}`));
      }, 20000);

      // Add event listeners
      iframe.onload = () => {
        clearTimeout(loadTimeout);
        this.loadingStates.set(key, false);
        this.errorStates.set(key, false);
        config.onLoad?.();
      };

      iframe.onerror = () => {
        console.warn('iframe error', key);
        clearTimeout(loadTimeout);
        this.loadingStates.set(key, false);
        this.errorStates.set(key, true);
        config.onError?.(new Error(`Failed to load iframe: ${src}`));
      };

      iframe.src = src;

      iframeWrapper.appendChild(iframe);
      container.appendChild(iframeWrapper);

      this.iframes.set(key, iframe);
      this.containers.set(key, iframeWrapper);
    }

    return {
      iframe: this.iframes.get(key)!,
      container: this.containers.get(key)!,
    };
  }

  private updateIframePosition(src: string, targetElement: HTMLElement) {
    const container = this.containers.get(src);
    if (!container) return;

    const rect = targetElement.getBoundingClientRect();
    const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;

    container.style.left = `${rect.left + scrollX}px`;
    container.style.top = `${rect.top + scrollY}px`;
    container.style.width = `${rect.width}px`;
    container.style.height = `${rect.height}px`;
  }

  showIframeAt(src: string, targetElement: HTMLElement): boolean {
    this.getOrCreateIframe(src, {});
    const container = this.containers.get(src);

    if (container && targetElement) {
      // Store current target
      this.currentTargets.set(src, targetElement);

      // Position iframe over the target
      this.updateIframePosition(src, targetElement);

      // Show iframe
      container.className = 'absolute opacity-100 pointer-events-auto transition-opacity duration-200';

      // Set up resize observer to keep position updated
      const resizeObserver = new ResizeObserver(() => {
        this.updateIframePosition(src, targetElement);
      });

      resizeObserver.observe(targetElement);
      resizeObserver.observe(document.body); // Watch for layout changes

      // Clean up previous observer
      const oldObserver = this.resizeObservers.get(src);
      if (oldObserver) {
        oldObserver.disconnect();
      }

      this.resizeObservers.set(src, resizeObserver);

      // Update position on scroll
      const handleScroll = () => this.updateIframePosition(src, targetElement);
      window.addEventListener('scroll', handleScroll, { passive: true });
      window.addEventListener('resize', handleScroll, { passive: true });

      // Store cleanup function
      const cleanup = () => {
        window.removeEventListener('scroll', handleScroll);
        window.removeEventListener('resize', handleScroll);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (container as any).__cleanup = cleanup;

      return true;
    }
    return false;
  }

  hideIframe(src: string): void {
    const container = this.containers.get(src);
    if (container) {
      container.className = 'absolute opacity-0 pointer-events-none transition-opacity duration-200';

      // Clean up observers and event listeners
      const resizeObserver = this.resizeObservers.get(src);
      if (resizeObserver) {
        resizeObserver.disconnect();
        this.resizeObservers.delete(src);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleanup = (container as any).__cleanup;
      if (cleanup) {
        cleanup();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (container as any).__cleanup;
      }

      this.currentTargets.delete(src);
    }
  }

  getLoadingState(src: string): boolean {
    return this.loadingStates.get(src) ?? false;
  }

  getErrorState(src: string): boolean {
    return this.errorStates.get(src) ?? false;
  }

  isVisible(src: string): boolean {
    const container = this.containers.get(src);
    return container?.classList.contains('opacity-100') ?? false;
  }

  cleanup(src: string): void {
    this.hideIframe(src);

    const container = this.containers.get(src);
    if (container?.parentElement) {
      container.parentElement.remove(); // Remove the portal container
    }

    this.containers.delete(src);
    this.iframes.delete(src);
    this.loadingStates.delete(src);
    this.errorStates.delete(src);
    this.currentTargets.delete(src);

    const resizeObserver = this.resizeObservers.get(src);
    if (resizeObserver) {
      resizeObserver.disconnect();
      this.resizeObservers.delete(src);
    }
  }

  refresh(src: string): void {
    const iframe = this.iframes.get(src);
    if (iframe) {
      iframe.src = src;
    }
  }

  postToGuest(src: string, message: unknown): void {
    const iframe = this.iframes.get(src);
    iframe?.contentWindow?.postMessage(message, '*');
  }
}

const registry = IframeRegistry.getInstance();

const PersistentIframe = forwardRef<PersistentIframeHandle, PersistentIframeProps>(
  ({ src, cacheKey, onLoad, onError, onErrorRetry }, ref) => {
    const { t } = useLingui();
    const containerRef = useRef<HTMLDivElement>(null);
    const [, forceUpdate] = useState({});

    // Force re-render to get updated loading/error states
    const triggerUpdate = useCallback(() => forceUpdate({}), []);

    const {
      data: isPreFetchedSourceNotAvailable,
      isLoading: isPreFetchedSourceLoading,
      isError: isPreFetchedSourceError,
      refetch: refetchSource,
    } = useQuery({
      queryKey: ['preFetchedSource', cacheKey, src],
      queryFn: async () => {
        try {
          const res = await fetch(src, { method: 'GET', credentials: 'include', redirect: 'manual' });
          if (res.status >= 400) {
            const text = await res.text();
            onError?.(new Error(text));
            return true; // Not available
          }
          return false; // Available
        } catch {
          // Network error (connection refused, etc.)
          onError?.(new Error(t`Unable to connect to webapp`));
          return true; // Not available
        }
      },
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: false, // Don't retry on network errors
    });
    const cacheKeyRef = useRef(cacheKey);

    const refreshIframe = useCallback(() => {
      void refetchSource();
      registry.refresh(src);
    }, [src, refetchSource]);

    // Expose refresh + guest-post methods to parent via ref
    useImperativeHandle(
      ref,
      () => ({
        refresh: refreshIframe,
        postToGuest: (message: unknown) => registry.postToGuest(src, message),
      }),
      [refreshIframe, src],
    );

    useEffect(() => {
      if (cacheKeyRef.current !== cacheKey) {
        refreshIframe();
        cacheKeyRef.current = cacheKey;
      }
    }, [cacheKey, refreshIframe]);

    // Get current iframe states
    const isIframeLoading = registry.getLoadingState(src);
    const isIframeError = registry.getErrorState(src);
    const isIframeVisible = registry.isVisible(src);

    const isLoading = isPreFetchedSourceLoading || isIframeLoading;
    const isError = isPreFetchedSourceNotAvailable || isPreFetchedSourceError || isIframeError;

    const showIframe = useCallback(() => {
      if (containerRef.current && !isError) {
        registry.showIframeAt(src, containerRef.current);
        triggerUpdate();
      }
    }, [src, isError, triggerUpdate]);

    const hideIframe = useCallback(() => {
      registry.hideIframe(src);
      triggerUpdate();
    }, [src, triggerUpdate]);

    const retryOnError = useCallback(() => {
      void refetchSource();
      registry.refresh(src);
      onErrorRetry?.();
    }, [onErrorRetry, refetchSource, src]);

    // Initialize iframe when component mounts
    useEffect(() => {
      const config = {
        onLoad: () => {
          onLoad?.();
          triggerUpdate();
        },
        onError: (error: Error) => {
          onError?.(error);
          triggerUpdate();
        },
      };

      registry.getOrCreateIframe(src, config);
    }, [src, onLoad, onError, triggerUpdate]);

    // Auto-show iframe when ready and container is available
    useEffect(() => {
      if (!isError && !isLoading && containerRef.current && !isIframeVisible) {
        showIframe();
      }
    }, [isError, isLoading, isIframeVisible, showIframe]);

    // Hide iframe when there's an error
    useEffect(() => {
      if (isError) {
        hideIframe();
      }
    }, [isError, hideIframe]);

    // Handle component unmount
    useEffect(() => {
      return () => {
        hideIframe();
      };
    }, [hideIframe]);

    const renderContent = () => {
      if (isLoading) {
        return (
          <div className="flex h-full w-full items-center justify-center bg-background">
            <div className="flex flex-col items-center space-y-4">
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-foreground" />
              <div className="text-center">
                <p className="text-sm font-medium text-foreground"><Trans>Loading server...</Trans></p>
                <div className="mt-2 w-64 rounded-full bg-muted">
                  <div className="h-2 animate-pulse rounded-full bg-primary" style={{ width: '100%' }} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground"><Trans>This may take up to 20 seconds</Trans></p>
              </div>
            </div>
          </div>
        );
      }

      if (isError) {
        return (
          <div className="flex h-full w-full items-center justify-center bg-muted/30">
            <Card className="max-w-sm border-none bg-transparent text-center shadow-none">
              <CardHeader className="pb-2">
                <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-muted-foreground"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </div>
                <p className="text-lg font-semibold text-foreground"><Trans>Webapp Not Available</Trans></p>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  <Trans>The webapp server is not running. Start the services to view the app.</Trans>
                </p>
                <Button variant="outline" size="sm" onClick={retryOnError}>
                  <Trans>Retry Connection</Trans>
                </Button>
              </CardContent>
            </Card>
          </div>
        );
      }

      return null;
    };

    return (
      <div className="relative h-full w-full" ref={containerRef}>
        {renderContent()}
      </div>
    );
  },
);

PersistentIframe.displayName = 'PersistentIframe';

export default PersistentIframe;

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

interface PersistentIframeProps {
  src: string;
  cacheKey?: number;
  className?: string;
  testId?: string;
  onLoad?: () => void;
  onError?: (error: Error) => void;
}

export interface PersistentIframeHandle {
  refresh: () => void;
  /** Post a message to the guest document (parent→iframe channel). */
  postToGuest: (message: unknown) => void;
}

type IframeOwner = symbol;

// Global iframe registry that keeps iframes in fixed DOM locations
class IframeRegistry {
  private static instance: IframeRegistry;
  private iframes = new Map<string, HTMLIFrameElement>();
  private containers = new Map<string, HTMLDivElement>();
  private loadingStates = new Map<string, boolean>();
  private errorStates = new Map<string, boolean>();
  private ownerTargets = new Map<string, Map<IframeOwner, HTMLElement>>();
  private activeOwners = new Map<string, IframeOwner>();
  private resizeObservers = new Map<string, ResizeObserver>();
  private positionCleanups = new Map<string, () => void>();

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
      testId?: string;
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
      if (config.testId) iframe.dataset.testid = config.testId;
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
    } else if (config.testId) {
      this.iframes.get(key)!.dataset.testid = config.testId;
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

  private clearPositionTracking(src: string): void {
    const resizeObserver = this.resizeObservers.get(src);
    if (resizeObserver) {
      resizeObserver.disconnect();
      this.resizeObservers.delete(src);
    }

    this.positionCleanups.get(src)?.();
    this.positionCleanups.delete(src);
  }

  private activateIframe(src: string, targetElement: HTMLElement, owner: IframeOwner): boolean {
    const container = this.containers.get(src);

    if (container && targetElement) {
      this.activeOwners.set(src, owner);
      this.clearPositionTracking(src);

      // Position iframe over the target
      this.updateIframePosition(src, targetElement);

      // Show iframe
      container.className = 'absolute opacity-100 pointer-events-auto transition-opacity duration-200';

      // Set up resize observer to keep position updated
      const resizeObserver = new ResizeObserver(() => {
        if (this.activeOwners.get(src) === owner) {
          this.updateIframePosition(src, targetElement);
        }
      });

      resizeObserver.observe(targetElement);
      resizeObserver.observe(document.body); // Watch for layout changes
      this.resizeObservers.set(src, resizeObserver);

      // Update position on scroll
      const handleScroll = () => {
        if (this.activeOwners.get(src) === owner) {
          this.updateIframePosition(src, targetElement);
        }
      };
      window.addEventListener('scroll', handleScroll, { passive: true });
      window.addEventListener('resize', handleScroll, { passive: true });

      this.positionCleanups.set(src, () => {
        window.removeEventListener('scroll', handleScroll);
        window.removeEventListener('resize', handleScroll);
      });

      return true;
    }
    return false;
  }

  showIframeAt(src: string, targetElement: HTMLElement, owner: IframeOwner): boolean {
    this.getOrCreateIframe(src, {});

    // Already active over this exact target — the observers/listeners are in
    // place and the position is current, so skip the teardown-and-rebuild.
    if (this.activeOwners.get(src) === owner && this.ownerTargets.get(src)?.get(owner) === targetElement) {
      return true;
    }

    const targets = this.ownerTargets.get(src) ?? new Map<IframeOwner, HTMLElement>();
    targets.delete(owner);
    targets.set(owner, targetElement);
    this.ownerTargets.set(src, targets);

    return this.activateIframe(src, targetElement, owner);
  }

  private hideContainer(src: string): void {
    const container = this.containers.get(src);
    if (container) {
      container.className = 'absolute opacity-0 pointer-events-none transition-opacity duration-200';
    }
    this.clearPositionTracking(src);
  }

  hideIframe(src: string, owner: IframeOwner): void {
    const targets = this.ownerTargets.get(src);
    const wasActiveOwner = this.activeOwners.get(src) === owner;

    targets?.delete(owner);
    if (targets?.size === 0) {
      this.ownerTargets.delete(src);
    }

    // A retiring component must not hide an iframe already claimed by its
    // same-URL replacement.
    if (!wasActiveOwner) return;

    const fallback = targets
      ? Array.from(targets.entries())
          .reverse()
          .find(([, target]) => target.isConnected)
      : undefined;
    if (fallback) {
      const [fallbackOwner, fallbackTarget] = fallback;
      this.activateIframe(src, fallbackTarget, fallbackOwner);
      return;
    }

    this.activeOwners.delete(src);
    this.hideContainer(src);
  }

  getLoadingState(src: string): boolean {
    return this.loadingStates.get(src) ?? false;
  }

  getErrorState(src: string): boolean {
    return this.errorStates.get(src) ?? false;
  }

  cleanup(src: string): void {
    this.ownerTargets.delete(src);
    this.activeOwners.delete(src);
    this.hideContainer(src);

    const container = this.containers.get(src);
    if (container?.parentElement) {
      container.parentElement.remove(); // Remove the portal container
    }

    this.containers.delete(src);
    this.iframes.delete(src);
    this.loadingStates.delete(src);
    this.errorStates.delete(src);
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
  ({ src, cacheKey, testId, onLoad, onError }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const ownerRef = useRef<IframeOwner>(Symbol('persistent-iframe-owner'));
    const [, forceUpdate] = useState({});

    // Force re-render to get updated loading/error states
    const triggerUpdate = useCallback(() => forceUpdate({}), []);

    // NOTE: there used to be a pre-flight availability probe here --
    // `fetch(src, { redirect: 'manual' })`, treating `status >= 400` as "not
    // available". It could never work. `src` is the backend's `get-host` action,
    // which answers 307, and `redirect: 'manual'` turns that into an OPAQUE
    // REDIRECT whose status is always 0 -- measured identical whether the dev
    // server behind it was alive or refusing connections. It therefore reported
    // "available" unconditionally, and its `catch` for connection-refused was
    // unreachable. Availability is now decided by `useWebappDiagnostics`, which
    // asks the backend to probe the port directly. This component is purely the
    // mechanism: it mounts a frame and reports load state.
    const cacheKeyRef = useRef(cacheKey);

    const refreshIframe = useCallback(() => {
      registry.refresh(src);
    }, [src]);

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



    const showIframe = useCallback(() => {
      if (containerRef.current && !isIframeError) {
        registry.showIframeAt(src, containerRef.current, ownerRef.current);
        triggerUpdate();
      }
    }, [src, isIframeError, triggerUpdate]);

    const hideIframe = useCallback(() => {
      registry.hideIframe(src, ownerRef.current);
      triggerUpdate();
    }, [src, triggerUpdate]);

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
        testId,
      };

      registry.getOrCreateIframe(src, config);
    }, [src, onLoad, onError, testId, triggerUpdate]);

    // Auto-show iframe when ready and container is available
    useEffect(() => {
      if (!isIframeError && !isIframeLoading && containerRef.current) {
        showIframe();
      }
    }, [isIframeError, isIframeLoading, showIframe]);

    // Hide iframe when there's an error
    useEffect(() => {
      if (isIframeError) {
        hideIframe();
      }
    }, [isIframeError, hideIframe]);

    // Handle component unmount
    useEffect(() => {
      return () => {
        hideIframe();
      };
    }, [hideIframe]);

    // Renders nothing of its own: this component is the MECHANISM (a registry-
    // parked iframe positioned over this slot), not a surface. Loading and error
    // presentation belong to `WebappDisplay`, which is the only thing that can
    // actually tell whether the guest is healthy — a cross-origin frame reports
    // a refused navigation as a successful `onload`, so anything decided here
    // would be guesswork competing with the real verdict.
    return (
      <div className="relative h-full w-full" ref={containerRef} data-testid={testId ? `${testId}-host` : undefined} />
    );
  },
);

PersistentIframe.displayName = 'PersistentIframe';

export default PersistentIframe;

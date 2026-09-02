import { useCallback, useEffect, useRef, useState } from 'react';

interface UseAutoScrollOptions {
  offset?: number;
  smooth?: boolean;
  content?: React.ReactNode;
}

export function useAutoScroll({ offset = 20, smooth = false, content }: UseAutoScrollOptions = {}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastContentHeight = useRef(0);
  const hasMounted = useRef(false);
  const hasUserInteracted = useRef(false);

  const [isAtBottom, setIsAtBottom] = useState(true);

  const checkIsAtBottom = useCallback(
    (el: HTMLElement) => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      return distance <= offset;
    },
    [offset],
  );

  const scrollToBottom = useCallback(
    (instant = false) => {
      const el = scrollRef.current;
      if (!el) return;
      const targetScrollTop = el.scrollHeight - el.clientHeight;

      // `scrollTo` is the smooth-animation path; assigning `scrollTop` is the
      // same destination without it. jsdom implements the property but not the
      // method, so a chat pane mounting under vitest threw
      // "el.scrollTo is not a function" and took the whole suite down with it
      // (CI only — whether jsdom has the method varies by patch version).
      // Falling back keeps the scroll itself working rather than skipping it,
      // which an optional call (`el.scrollTo?.(…)`) would silently do.
      if (instant || typeof el.scrollTo !== 'function') {
        el.scrollTop = targetScrollTop;
      } else {
        el.scrollTo({ top: targetScrollTop, behavior: smooth ? 'smooth' : 'auto' });
      }
    },
    [smooth],
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setIsAtBottom(checkIsAtBottom(el));
  }, [checkIsAtBottom]);

  // Initial mount scroll
  useEffect(() => {
    if (!hasMounted.current && scrollRef.current) {
      scrollToBottom(true);
      hasMounted.current = true;
    }
  }, [scrollToBottom]);

  // Listen for scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = (e: Event) => {
      // Avoid turning off initial auto-follow due to non-user scroll events (e.g. layout/content changes).
      // Once the user scrolls (trusted event), we switch to strict "only if at bottom" behavior.
      if ((e as UIEvent).isTrusted) {
        hasUserInteracted.current = true;
      } else if (!hasUserInteracted.current) {
        return;
      }
      handleScroll();
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [handleScroll]);

  // New content scroll logic
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const currentHeight = el.scrollHeight;
    if (currentHeight !== lastContentHeight.current) {
      lastContentHeight.current = currentHeight;
      if (!hasUserInteracted.current || isAtBottom) {
        requestAnimationFrame(() => scrollToBottom());
      }
    }
  }, [content, isAtBottom, scrollToBottom]);

  // ResizeObserver fallback (optional)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (isAtBottom) scrollToBottom(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isAtBottom, scrollToBottom]);

  const disableAutoScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    hasUserInteracted.current = true;
    const atBottom = checkIsAtBottom(el);
    if (!atBottom) {
      setIsAtBottom(false);
    }
  }, [checkIsAtBottom]);

  return {
    scrollRef,
    isAtBottom,
    scrollToBottom,
    disableAutoScroll,
  };
}

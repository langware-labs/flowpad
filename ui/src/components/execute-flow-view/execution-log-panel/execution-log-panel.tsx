import { useEffect, useRef } from 'react';

export function ExecutionLogPanel() {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new content is added
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const observer = new MutationObserver(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });

    observer.observe(scrollContainer, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Initial scroll to bottom
    scrollContainer.scrollTop = scrollContainer.scrollHeight;

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={scrollContainerRef} className="h-full overflow-y-auto overflow-x-hidden">
      {/* Trace section removed */}
    </div>
  );
}

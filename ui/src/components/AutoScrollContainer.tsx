import * as React from 'react';
import { ArrowDown } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useAutoScroll } from '@src/hooks/use-auto-scroll';

interface AutoScrollContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  smooth?: boolean;
}

export interface AutoScrollContainerHandle {
  scrollToBottom: () => void;
  /** Scroll down for new content only if the reader is already at the bottom. */
  follow: () => void;
}

const AutoScrollContainer = React.forwardRef<AutoScrollContainerHandle, AutoScrollContainerProps>(
  ({ className, children, smooth = false, ...props }, ref) => {
    const { t } = useLingui();
    const { scrollRef, isAtBottom, hasNewContent, scrollToBottom, follow, disableAutoScroll } = useAutoScroll({
      smooth,
      content: children,
    });

    React.useImperativeHandle(ref, () => ({
      scrollToBottom,
      follow,
    }));

    return (
      <div data-testid="auto-scroll-container" className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onWheel={disableAutoScroll}
          onTouchMove={disableAutoScroll}
          className={`flex-1 overflow-y-auto p-4 ${className}`}
          {...props}
        >
          {children}
        </div>

        {!isAtBottom && hasNewContent && (
          <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 transform">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 rounded-full shadow-md"
              data-testid="new-messages-indicator"
              onClick={() => scrollToBottom()}
            >
              <ArrowDown className="size-4" />
              <Trans>New messages</Trans>
            </Button>
          </div>
        )}
        {!isAtBottom && !hasNewContent && (
          <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 transform">
            <Button
              size="icon"
              variant="outline"
              className="rounded-full shadow-md"
              aria-label={t`Scroll to bottom`}
              onClick={() => scrollToBottom()}
            >
              <ArrowDown className="size-4" />
            </Button>
          </div>
        )}
      </div>
    );
  },
);

AutoScrollContainer.displayName = 'AutoScrollContainer';

export { AutoScrollContainer };

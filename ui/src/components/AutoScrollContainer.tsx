import * as React from 'react';
import { ArrowDown } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useAutoScroll } from '@src/hooks/use-auto-scroll';

interface AutoScrollContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  smooth?: boolean;
}

export interface AutoScrollContainerHandle {
  scrollToBottom: () => void;
}

const AutoScrollContainer = React.forwardRef<AutoScrollContainerHandle, AutoScrollContainerProps>(
  ({ className, children, smooth = false, ...props }, ref) => {
    const { t } = useLingui();
    const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll } = useAutoScroll({
      smooth,
      content: children,
    });

    React.useImperativeHandle(ref, () => ({
      scrollToBottom,
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

        {!isAtBottom && (
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

import * as React from 'react';
import { cn } from '../../lib/utils';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion';
import { Button } from './button';
import { Card } from './card';

const ContentCard = React.forwardRef<
  React.ElementRef<typeof Card>,
  React.ComponentPropsWithoutRef<typeof Card> & {
    clickable?: boolean;
    disabled?: boolean;
    collapsible?: boolean;
    defaultOpen?: boolean;
  }
>(
  (
    { className, clickable = true, disabled = false, collapsible = false, defaultOpen = false, children, ...props },
    ref,
  ) => {
    const [isOpen, setIsOpen] = React.useState(defaultOpen);

    React.useEffect(() => {
      setIsOpen(defaultOpen);
    }, [defaultOpen]);

    if (!collapsible) {
      return (
        <Card
          ref={ref}
          className={cn(
            'max-w-[85%] rounded-lg border bg-background p-3 shadow-sm transition-colors',
            clickable && 'cursor-pointer hover:bg-muted/50',
            disabled && 'cursor-not-allowed opacity-60 hover:bg-background',
            className,
          )}
          {...props}
        >
          {children}
        </Card>
      );
    }

    return (
      <Accordion
        type="single"
        collapsible
        value={isOpen ? 'content' : ''}
        onValueChange={(value) => setIsOpen(value === 'content')}
      >
        <AccordionItem value="content" className="border-0 p-0">
          <Card
            ref={ref}
            className={cn(
              'max-w-[85%] rounded-lg border bg-background shadow-sm transition-colors',
              clickable && 'cursor-pointer hover:bg-muted/50',
              disabled && 'cursor-not-allowed opacity-60 hover:bg-background',
              className,
            )}
            {...props}
          >
            <AccordionTrigger
              className={cn(
                'w-full px-3 py-3 hover:no-underline cursor-inherit',
                disabled && 'cursor-not-allowed opacity-60',
              )}
              disabled={disabled}
            >
              {/* Render children but filter out ContentCardCollapsibleContent */}
              {React.Children.map(children, (child) => {
                if (React.isValidElement(child) && child.type === ContentCardCollapsibleContent) {
                  return null; // Don't render ContentCardCollapsibleContent in trigger
                }
                return child;
              })}
            </AccordionTrigger>
            {/* Render ContentCardCollapsibleContent outside the trigger */}
            {React.Children.map(children, (child) => {
              if (React.isValidElement(child) && child.type === ContentCardCollapsibleContent) {
                return child; // Render ContentCardCollapsibleContent here
              }
              return null;
            })}
          </Card>
        </AccordionItem>
      </Accordion>
    );
  },
);
ContentCard.displayName = 'ContentCard';

const ContentCardContainer = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center gap-3 max-w-[calc(100%-16px)]', className)} {...props} />
  ),
);
ContentCardContainer.displayName = 'ContentCardContainer';

const ContentCardIcon = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} className={cn('flex h-8 w-8 items-center justify-center rounded-lg bg-muted', className)} {...props}>
      {children}
    </div>
  ),
);
ContentCardIcon.displayName = 'ContentCardIcon';

const ContentCardBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('min-w-0 flex-1', className)} {...props} />,
);
ContentCardBody.displayName = 'ContentCardBody';

const ContentCardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('flex items-center gap-2', className)} {...props} />,
);
ContentCardHeader.displayName = 'ContentCardHeader';

const ContentCardTitle = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => <span ref={ref} className={cn('text-sm font-medium', className)} {...props} />,
);
ContentCardTitle.displayName = 'ContentCardTitle';

const ContentCardStatus = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => <span ref={ref} className={cn('', className)} {...props} />,
);
ContentCardStatus.displayName = 'ContentCardStatus';

const ContentCardSubtext = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('truncate font-mono text-sm text-muted-foreground', className)} {...props} />
  ),
);
ContentCardSubtext.displayName = 'ContentCardSubtext';

const ContentCardAction = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center space-x-2', className)} {...props} />
  ),
);
ContentCardAction.displayName = 'ContentCardAction';

const ContentCardActionButton = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof Button>>(
  ({ className, variant = 'outline', size = 'default', ...props }, ref) => (
    <Button
      variant={variant}
      size={size}
      ref={ref}
      className={cn('flex items-center space-x-1', className)}
      {...props}
    />
  ),
);
ContentCardActionButton.displayName = 'ContentCardActionButton';

const ContentCardCollapsibleContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <AccordionContent ref={ref} className={cn('max-h-[32rem] overflow-y-auto', className)} {...props} />
  ),
);
ContentCardCollapsibleContent.displayName = 'ContentCardCollapsibleContent';

export {
  ContentCard,
  ContentCardAction,
  ContentCardActionButton,
  ContentCardBody,
  ContentCardCollapsibleContent,
  ContentCardContainer,
  ContentCardHeader,
  ContentCardIcon,
  ContentCardStatus,
  ContentCardSubtext,
  ContentCardTitle,
};

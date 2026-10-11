/**
 * A dialog that walks a person through steps IN PLACE: each step replaces the body, a breadcrumb on top says
 * where they are, and an earlier crumb takes them back to that step.
 *
 * Why not one scrolling form: choosing a provider used to append its choices, then its form, then its setup
 * below a grid already used — a person scrolled past twenty tiles to reach the next question. Here the body has
 * a fixed height and scrolls inside, so a step swapping in never makes the dialog jump.
 *
 * Generic: the caller owns the step state and passes the trail. Nothing here knows about data sources.
 */
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { forwardRef } from 'react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@src/components/ui/breadcrumb';
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { cn } from '@src/lib/utils';

export interface StepCrumb {
  label: ReactNode;
  /** Going back to this step. The last crumb (where the person is) takes none. */
  onClick?: () => void;
}

/** The trail: earlier steps are buttons that go back, the last one is the current page (the dialog's title). */
export function StepCrumbs({ crumbs }: { crumbs: StepCrumb[] }) {
  return (
    <Breadcrumb data-testid="step-crumbs">
      <BreadcrumbList className="text-base sm:gap-1.5">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return [
            i > 0 && <BreadcrumbSeparator key={`sep-${i}`} />,
            <BreadcrumbItem key={`crumb-${i}`}>
              {last || !crumb.onClick ? (
                <BreadcrumbPage className={cn(last && 'font-semibold')} data-testid={`step-crumb-${i}`}>
                  {crumb.label}
                </BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <button type="button" data-testid={`step-crumb-${i}`} onClick={crumb.onClick}>
                    {crumb.label}
                  </button>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>,
          ];
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

type ContentProps = ComponentPropsWithoutRef<typeof DialogContent>;

/** ``DialogContent`` laid out as steps: the trail as its title, an optional line under it, a body of fixed height
 *  that scrolls inside, and a footer that stays put. */
export const SteppedDialogContent = forwardRef<
  HTMLDivElement,
  Omit<ContentProps, 'title'> & { crumbs: StepCrumb[]; description?: ReactNode; footer?: ReactNode }
>(({ crumbs, description, footer, children, className, ...props }, ref) => (
  <DialogContent ref={ref} className={cn('flex h-[min(640px,85vh)] flex-col gap-4 sm:max-w-lg', className)} {...props}>
    <DialogHeader>
      {/* The trail IS the title: a screen reader hears where the person is, a sighted person sees how they got there. */}
      <DialogTitle asChild>
        <div>
          <StepCrumbs crumbs={crumbs} />
        </div>
      </DialogTitle>
      {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only" />}
    </DialogHeader>
    <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1" data-testid="step-body">
      {children}
    </div>
    {footer && <DialogFooter>{footer}</DialogFooter>}
  </DialogContent>
));
SteppedDialogContent.displayName = 'SteppedDialogContent';

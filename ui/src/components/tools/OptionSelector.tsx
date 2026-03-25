import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { Check } from 'lucide-react';
import React from 'react';

export interface SelectorOption<T> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  tooltip?: string;
}

interface OptionSelectorProps<T> {
  value: T;
  options: SelectorOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  triggerIcon?: React.ReactNode;
  detectedValue?: T | null;
  className?: string;
  maxLabelLength?: number;
  triggerTooltip?: string;
}

function OptionSelector<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  triggerIcon,
  detectedValue,
  className,
  maxLabelLength = 6,
  triggerTooltip,
}: OptionSelectorProps<T>) {
  const currentOption = options.find((opt) => opt.value === value);
  const fullLabel = currentOption?.label || value;
  const displayLabel = fullLabel.length > maxLabelLength ? `${fullLabel.slice(0, maxLabelLength)}..` : fullLabel;

  const triggerButton = (
    <DropdownMenuTrigger
      className={cn(
        'h-auto w-min rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      disabled={disabled}
    >
      <div className="flex items-center">
        {triggerIcon && <span className="mr-1 flex h-3 w-3 items-center justify-center">{triggerIcon}</span>}
        {displayLabel}
      </div>
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {triggerTooltip || fullLabel.length > maxLabelLength ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
            <TooltipContent>
              <p>{triggerTooltip || fullLabel}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        triggerButton
      )}
      <DropdownMenuContent align="start" className="min-w-0">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-2 outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
            )}
            title={option.tooltip}
          >
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {option.icon && <span className="flex h-4 w-4 items-center justify-center">{option.icon}</span>}
                <span>{option.label}</span>
              </div>
              {(value === option.value || detectedValue === option.value) && (
                <Check className="h-4 w-4 flex-shrink-0 stroke-[3] text-emerald-600" />
              )}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default OptionSelector;

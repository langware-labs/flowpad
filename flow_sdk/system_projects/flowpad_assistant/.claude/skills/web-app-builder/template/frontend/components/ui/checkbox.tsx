import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Checkbox, shadcn-shaped.
 *
 * Native `<input type="checkbox">` rather than `@radix-ui/react-checkbox`,
 * which is NOT in this template's dependencies. It keeps the usual
 * `checked` / `onCheckedChange` surface so code written against the shadcn
 * component works unchanged, and `onChange` still fires for anything expecting
 * the DOM event.
 */
export interface CheckboxProps extends Omit<React.ComponentProps<"input">, "type"> {
  onCheckedChange?: (checked: boolean) => void;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, onCheckedChange, onChange, ...props }, ref) => (
    <input
      type="checkbox"
      ref={ref}
      className={cn(
        "peer h-4 w-4 shrink-0 cursor-pointer rounded-sm border border-primary shadow accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      onChange={(event) => {
        onChange?.(event);
        onCheckedChange?.(event.target.checked);
      }}
      {...props}
    />
  ),
);
Checkbox.displayName = "Checkbox";

export { Checkbox };

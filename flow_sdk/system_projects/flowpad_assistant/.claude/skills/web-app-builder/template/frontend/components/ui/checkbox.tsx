import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Native `<input type="checkbox">` — `@radix-ui/react-checkbox` is not a template
 * dependency. It keeps shadcn's `onCheckedChange`, but NOT shadcn's styling
 * contract: colour the checked state with `accent-*`, not `data-[state=checked]:*`.
 */
function Checkbox({
  className,
  onCheckedChange,
  onChange,
  ...props
}: React.ComponentProps<"input"> & { onCheckedChange?: (checked: boolean) => void }) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
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
  );
}

export { Checkbox };

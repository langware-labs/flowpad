import * as React from "react";

import { cn } from "@/lib/utils";

/** Native `<label>` — `@radix-ui/react-label` is not a template dependency. */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}

export { Label };

---
id: 681a5494-683d-5f30-bb29-7af5e4795c5e
---

# Adding a New Component

Guide for creating reusable UI components in the frontend.

## Component Location

Place components based on their purpose:

| Type | Location | Example |
|------|----------|---------|
| UI primitives (buttons, cards) | `src/components/ui/` | `button.tsx`, `card.tsx` |
| Feature components | `src/components/` | `user-profile.tsx` |
| Page-specific components | `src/components/[feature]/` | `src/components/dashboard/stats-card.tsx` |

## Component Template

Create a new file following this pattern:

```typescript
import * as React from "react";
import { cn } from "@/lib/utils";

export interface ComponentNameProps
  extends React.HTMLAttributes<HTMLDivElement> {
  // Add custom props here
  variant?: "default" | "secondary";
}

const ComponentName = React.forwardRef<HTMLDivElement, ComponentNameProps>(
  ({ className, variant = "default", ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          // Base styles
          "rounded-lg border p-4",
          // Variant styles
          variant === "secondary" && "bg-secondary",
          className
        )}
        {...props}
      />
    );
  }
);
ComponentName.displayName = "ComponentName";

export { ComponentName };
```

## Key Patterns

### Use the `cn` utility for class merging

```typescript
import { cn } from "@/lib/utils";

// Merges Tailwind classes correctly, handles conflicts
className={cn("base-class", conditional && "conditional-class", className)}
```

### Use `forwardRef` for DOM access

Enables parent components to access the underlying DOM element.

### Export interface for type safety

Consumers get full TypeScript support when using the component.

## Calling Backend APIs

Components fetch data from backend using relative `/api/*` paths:

```typescript
import { useState, useEffect } from "react";

interface DataType {
  id: number;
  name: string;
}

function MyComponent() {
  const [data, setData] = useState<DataType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/items");
      if (!response.ok) throw new Error("Failed to fetch");
      const result = await response.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  return <div>{data?.name}</div>;
}
```

### POST/PUT/DELETE requests

```typescript
const createItem = async (data: { name: string }) => {
  const response = await fetch("/api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error("Failed to create");
  return response.json();
};
```

## Workflow Checklist

Copy and track progress:

```
Component Creation:
- [ ] Create component file in appropriate location
- [ ] Define TypeScript interface for props
- [ ] Implement component with forwardRef pattern
- [ ] Use cn() for className handling
- [ ] Add API fetch logic if needed
- [ ] Export component and types
- [ ] Import and use in parent component
```

## Example: Status Badge Component

```typescript
// src/components/ui/status-badge.tsx
import * as React from "react";
import { cn } from "@/lib/utils";

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  status: "online" | "offline" | "pending";
}

const statusStyles = {
  online: "bg-green-500",
  offline: "bg-red-500",
  pending: "bg-yellow-500",
};

const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ className, status, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center gap-2 rounded-full px-2 py-1 text-sm",
          className
        )}
        {...props}
      >
        <span className={cn("h-2 w-2 rounded-full", statusStyles[status])} />
        {status}
      </span>
    );
  }
);
StatusBadge.displayName = "StatusBadge";

export { StatusBadge };
```

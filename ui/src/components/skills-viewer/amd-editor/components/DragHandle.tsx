import { GripVertical } from 'lucide-react';

interface DragHandleProps {
  className?: string;
}

export function DragHandle({ className = '' }: DragHandleProps) {
  return (
    <div
      className={`cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 ${className}`}
    >
      <GripVertical className="h-4 w-4" />
    </div>
  );
}

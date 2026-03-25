import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { cn } from '@src/lib/utils';
import { ChevronRight, Braces } from 'lucide-react';

interface VariablesInspectorProps {
  variables: Record<string, unknown>;
  title?: string;
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Tree view for inspecting variables with expandable nested objects
 */
export function VariablesInspector({
  variables,
  title = 'Variables',
  defaultOpen = false,
  className,
}: VariablesInspectorProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const entries = Object.entries(variables);
  const count = entries.length;

  if (count === 0) {
    return null;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 rounded px-2 py-1 text-sm hover:bg-muted/50">
        <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
        <Braces className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">({count})</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-6">
        <div className="space-y-0.5 border-l border-border pl-3 pt-1">
          {entries.map(([key, value]) => (
            <VariableNode key={key} name={key} value={value} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface VariableNodeProps {
  name: string;
  value: unknown;
  depth?: number;
}

function VariableNode({ name, value, depth = 0 }: VariableNodeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const isExpandable = isObject(value) || Array.isArray(value);
  const displayValue = formatValue(value);

  if (!isExpandable) {
    return (
      <div className="flex items-start gap-2 py-0.5 text-xs">
        <span className="font-mono text-purple-600 dark:text-purple-400">{name}</span>
        <span className="text-muted-foreground">:</span>
        <span className={cn('font-mono', getValueColorClass(value))}>{displayValue}</span>
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex items-start gap-1 py-0.5 text-xs hover:bg-muted/30">
        <ChevronRight
          className={cn('mt-0.5 h-3 w-3 text-muted-foreground transition-transform', isOpen && 'rotate-90')}
        />
        <span className="font-mono text-purple-600 dark:text-purple-400">{name}</span>
        <span className="text-muted-foreground">:</span>
        <span className="text-muted-foreground">
          {Array.isArray(value) ? `Array(${value.length})` : `Object(${entries.length})`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-4">
        {depth < 5 && entries.map(([k, v]) => <VariableNode key={k} name={k} value={v} depth={depth + 1} />)}
        {depth >= 5 && <span className="text-xs italic text-muted-foreground">Max depth reached</span>}
      </CollapsibleContent>
    </Collapsible>
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${truncate(value, 50)}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (isObject(value)) return `Object(${Object.keys(value).length})`;
  return typeof value === 'symbol' ? value.toString() : `[${typeof value}]`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function getValueColorClass(value: unknown): string {
  if (value === null || value === undefined) return 'text-gray-500';
  if (typeof value === 'string') return 'text-green-600 dark:text-green-400';
  if (typeof value === 'number') return 'text-blue-600 dark:text-blue-400';
  if (typeof value === 'boolean') return 'text-orange-600 dark:text-orange-400';
  return 'text-foreground';
}

import React, { useCallback, useRef, useState, type ReactNode } from 'react';
import type { DockPointer } from '@src/navigation';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { InputDialog } from '@src/components/ui/input-dialog';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { BrowseableTree } from '@src/components/browseable-tree/BrowseableTree';
import type { BrowseableRoot } from '@src/components/browseable-tree/types';

/**
 * BrowseableMenu — generic popover embedding for `BrowseableTree` (the tree
 * itself is layout-agnostic and was panel-only until now). Any picker-style
 * consumer (prompt library, future entity pickers) composes this with an
 * adapter root. Zero business logic: rendering + delegation only.
 */
export interface BrowseableMenuProps {
  /** The popover trigger (a ribbon button, toolbar icon, …). */
  trigger: ReactNode;
  roots: BrowseableRoot[];
  /** Selection/navigation callback — pickers override navigation here. */
  onNavigate?: (pointer: DockPointer) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra classes on the popover content (width/height). */
  contentClassName?: string;
  align?: 'start' | 'center' | 'end';
  emptyState?: ReactNode;
}

export const BrowseableMenu: React.FC<BrowseableMenuProps> = ({
  trigger,
  roots,
  onNavigate,
  open,
  onOpenChange,
  contentClassName,
  align = 'end',
  emptyState,
}) => (
  <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>{trigger}</PopoverTrigger>
    <PopoverContent align={align} className={contentClassName ?? 'w-80 p-1'}>
      <div className="max-h-96 overflow-y-auto">
        <BrowseableTree roots={roots} activePointer={null} onNavigate={onNavigate} emptyState={emptyState} />
      </div>
    </PopoverContent>
  </Popover>
);

/**
 * useMenuDialogs — generic name-prompt / confirm primitives for tree
 * adapters. Adapters live outside React; they receive these async callbacks
 * (`requestName`, `confirm`) and the consumer renders `{dialogs}` once.
 * Reactivity/plumbing only — no decisions.
 */
export function useMenuDialogs(): {
  requestName: (title: string, opts?: { placeholder?: string; defaultValue?: string }) => Promise<string | null>;
  confirm: (title: string, description?: string) => Promise<boolean>;
  dialogs: ReactNode;
} {
  const [nameState, setNameState] = useState<{
    title: string;
    placeholder?: string;
    defaultValue?: string;
  } | null>(null);
  const nameResolve = useRef<((value: string | null) => void) | null>(null);

  const [confirmState, setConfirmState] = useState<{ title: string; description?: string } | null>(null);
  const confirmResolve = useRef<((ok: boolean) => void) | null>(null);

  const requestName = useCallback(
    (title: string, opts: { placeholder?: string; defaultValue?: string } = {}) =>
      new Promise<string | null>((resolve) => {
        nameResolve.current = resolve;
        setNameState({ title, ...opts });
      }),
    [],
  );

  const confirm = useCallback(
    (title: string, description?: string) =>
      new Promise<boolean>((resolve) => {
        confirmResolve.current = resolve;
        setConfirmState({ title, description });
      }),
    [],
  );

  const dialogs = (
    <>
      <InputDialog
        open={nameState !== null}
        onOpenChange={(open) => {
          if (!open) {
            nameResolve.current?.(null);
            nameResolve.current = null;
            setNameState(null);
          }
        }}
        title={nameState?.title ?? ''}
        placeholder={nameState?.placeholder}
        defaultValue={nameState?.defaultValue}
        onConfirm={(value) => {
          nameResolve.current?.(value);
          nameResolve.current = null;
        }}
      />
      <ConfirmDialog
        open={confirmState !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            confirmResolve.current?.(false);
            confirmResolve.current = null;
            setConfirmState(null);
          }
        }}
        title={confirmState?.title ?? ''}
        description={confirmState?.description ?? ''}
        onConfirm={() => {
          confirmResolve.current?.(true);
          confirmResolve.current = null;
          setConfirmState(null);
        }}
      />
    </>
  );

  return { requestName, confirm, dialogs };
}

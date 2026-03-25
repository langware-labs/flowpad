import { cn } from '@src/lib/utils';
import { ChatInputBox } from './ChatInputBox';
import { PendingInjectionCard } from './PendingInjectionCard';

interface InterferenceBoxProps {
  waitingForInput: boolean;
  inputId: string | null;
  onSubmitInput: (value: string) => void | Promise<void>;
  onInjectInstruction: (content: string) => void | Promise<void>;
  disabled: boolean;
  className?: string;
}

/**
 * InterferenceBox - Compact input area for session interaction
 */
export function InterferenceBox({
  waitingForInput,
  inputId,
  onSubmitInput,
  onInjectInstruction,
  disabled,
  className,
}: InterferenceBoxProps) {
  return (
    <div className={cn('shrink-0', className)}>
      {waitingForInput ? (
        <PendingInjectionCard inputId={inputId} onSubmit={onSubmitInput} />
      ) : (
        <ChatInputBox onSubmit={onInjectInstruction} disabled={disabled} />
      )}
    </div>
  );
}

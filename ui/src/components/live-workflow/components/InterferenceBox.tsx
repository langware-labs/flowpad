import { cn } from '@src/lib/utils';
import { ChatInputBox } from './ChatInputBox';

interface InterferenceBoxProps {
  onInjectInstruction: (content: string) => void | Promise<void>;
  disabled: boolean;
  className?: string;
}

/**
 * InterferenceBox - Compact input area for session interaction
 */
export function InterferenceBox({
  onInjectInstruction,
  disabled,
  className,
}: InterferenceBoxProps) {
  return (
    <div className={cn('shrink-0', className)}>
      <ChatInputBox onSubmit={onInjectInstruction} disabled={disabled} />
    </div>
  );
}

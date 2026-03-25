import type { Instruction } from '../types';
import { InstructionItem } from './instruction-item';

interface InstructionListProps {
  instructions: Instruction[];
  currentInstructionId: string | null;
  onRetry?: (instructionId: string) => void;
  onSkip?: (instructionId: string) => void;
  onToggleExpand?: (instructionId: string) => void;
}

export function InstructionList({
  instructions,
  currentInstructionId,
  onRetry,
  onSkip,
  onToggleExpand,
}: InstructionListProps) {
  if (instructions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        No instructions to display
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {instructions.map((instruction) => (
        <InstructionItem
          key={instruction.id}
          instruction={instruction}
          isCurrent={instruction.id === currentInstructionId}
          onRetry={onRetry}
          onSkip={onSkip}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </div>
  );
}

import { Instruction } from './Instruction';

export class InstructionsBlock {
  private instructions: Instruction[] = [];

  constructor(instructions: Instruction[] = []) {
    this.instructions = [...instructions];
  }

  add(instruction: Instruction): void {
    this.instructions.push(instruction);
  }

  getAll(): Instruction[] {
    return [...this.instructions];
  }

  sortByLineNumber(): void {
    this.instructions.sort((a, b) => a.lineNumber - b.lineNumber);
  }
}

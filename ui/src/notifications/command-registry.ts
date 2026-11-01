/**
 * The notification command registry, in a module that imports nothing.
 *
 * Modules register commands as they load. Some load inside an import cycle that runs through
 * commands.ts, so the registry must exist before any of commands.ts's own imports run.
 */
export type CommandArgs = Record<string, string | number | boolean>;
export type CommandHandler = (args: CommandArgs, ctx: { id: string }) => void;

const registry = new Map<string, CommandHandler>();

export function registerCommand(name: string, fn: CommandHandler): void {
  registry.set(name, fn);
}

export function commandFor(name: string): CommandHandler | undefined {
  return registry.get(name);
}

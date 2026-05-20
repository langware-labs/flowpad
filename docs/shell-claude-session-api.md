---
id: 69b3f08c-4316-5b87-a6bb-f49c1c3d1c31
---

# Shell & ClaudeSession Client-Side API

## Overview

Client-side TypeScript domain interfaces for working with Shell and Claude Code sessions. Shell is a generic shell with no Claude knowledge. ClaudeSession runs *inside* a Shell and depends on it — not the other way around.

## Usage

```typescript
// Shell is generic — just runs commands
const shell = new Shell(sessionId);
assert(shell.status === 'idle');

await shell.run("echo hello");
assert(shell.status === 'idle'); // back to idle after command completes

// Claude session is created *on top of* a shell
const claudeSession = await ClaudeSession.start(shell, { instruction: "fix the bug" });
assert(shell.status === 'running');       // shell sees a foreground process
assert(claudeSession.status === 'running');

await claudeSession.waitForTurn();
assert(claudeSession.status === 'complete');

// Closing the Claude session returns the shell to idle
await claudeSession.close();
assert(shell.status === 'idle');

// Can also attach to an existing Claude session via record
const record = await ClaudeSessionRecord.fromClaudeSessionId(knownClaudeSessionId);
const session = ClaudeSession.fromRecord(record, shell);
```

## Interfaces

### Types (`ts_sdk/src/domain/types.ts`)

```typescript
export type ShellStatus = 'idle' | 'running' | 'closed';

export type ClaudeSessionStatus = 'idle' | 'running' | 'complete';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

### IShell (`ts_sdk/src/domain/shell.ts`)

Shell is a generic shell. No Claude awareness.

```typescript
export interface IShell {
  readonly sessionId: string;
  readonly name: string;
  readonly status: ShellStatus;
  readonly workdir: string | undefined;

  /** Set or update environment variables. Merges with existing env; later calls override earlier ones. */
  setEnv(vars: Record<string, string>): Promise<void>;

  /** Run a command in the foreground. Status → 'running' while active, then back to 'idle'. */
  run(command: string): Promise<ShellResult>;

  /** Close the shell entirely. Kills any running process. Status → 'closed'. */
  close(): Promise<void>;
}
```

### IClaudeSessionRecord (`ts_sdk/src/domain/claude-session.ts`)

```typescript
export interface IClaudeSessionRecord {
  readonly sessionId: string;
  readonly slug: string | undefined;
  readonly model: string | undefined;
  readonly cwd: string | undefined;
  readonly status: ClaudeSessionStatus;
  readonly messageCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly toolsUsed: string[] | undefined;

  // Static on implementing class:
  // static fromClaudeSessionId(claudeSessionId: string): Promise<IClaudeSessionRecord>
}
```

### IClaudeSession (`ts_sdk/src/domain/claude-session.ts`)

ClaudeSession runs inside a Shell. It depends on Shell, not vice versa.

```typescript
export interface IClaudeSession {
  readonly record: IClaudeSessionRecord;
  readonly status: ClaudeSessionStatus;
  readonly workerSessionId: string;

  /** The shell this Claude session is running inside. */
  readonly shell: IShell;

  /** Resume a paused session: `claude --resume <id>` */
  resume(): Promise<void>;

  /** Wait for Claude to finish its current turn. Polls until 'complete'. */
  waitForTurn(): Promise<ClaudeSessionStatus>;

  /**
   * Close this Claude session.
   * The underlying shell returns to 'idle'.
   * Does NOT close the shell itself.
   */
  close(): Promise<void>;

  // Static on implementing class:
  // static start(shell: IShell, options?: { model?, permissionMode?, sessionId?, instruction? }): Promise<IClaudeSession>
  // static fromRecord(record: IClaudeSessionRecord, shell: IShell): IClaudeSession
}
```

## Design Decisions

1. **One-way dependency**: `ClaudeSession` → `Shell`. Shell has zero Claude knowledge.
2. **Shell status is simple**: `idle | running | closed`. Shell just sees a foreground process — it doesn't know or care if it's Claude.
3. **`ClaudeSession.close()` de-occupies the shell** — shell goes back to `idle`, not `closed`.
4. **`ClaudeSession.start()` is a static factory** — takes a shell + options, returns a session running inside that shell.
5. **Static factories on classes, not interfaces** — TypeScript interfaces can't define statics.

## File Layout

```
ts_sdk/src/domain/
├── types.ts           # ShellStatus, ClaudeSessionStatus, ShellResult
├── shell.ts           # IShell interface
├── claude-session.ts  # IClaudeSessionRecord, IClaudeSession interfaces
└── index.ts           # Barrel exports
```

# Session Share Spec

How Claude Code sessions are structured, what needs to move between machines, and how to patch transcripts so the receiving machine works cleanly.

---

## 1. What a Session Is

A session is three things:

1. **The JSONL transcript** — `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`
   The append-only conversation log. This is the source of truth. Everything Claude knows about past work lives here.

2. **The `worker_session_id`** — the UUID that is the filename of the JSONL.
   Claude's `--resume <uuid>` uses this to find and load the transcript.

3. **Supporting records** (optional, flow-cli specific):
   - `AgenticProcessRecord` — `~/.flow/records/agentic_process/<id>/.flow_record/record.json`
   - `ShellSessionRecord` — `~/.flow/records/shell_session/<id>/.flow_record/record.json`

Ephemeral state (active PTY, replay buffer, WebSocket connections) is machine-local and is not transferred.

---

## 2. Project Path Encoding

Claude stores sessions under a directory named after the project path:

```
/Users/alice/myrepo   →   ~/.claude/projects/-Users-alice-myrepo/
/tmp/folder-a         →   ~/.claude/projects/-private-tmp-folder-a/   (macOS: /tmp → /private/tmp)
```

Rule: take the absolute path, replace every `/` with `-`.

`--resume <uuid>` looks **only** inside `~/.claude/projects/<encoded-cwd>/` — it does not scan other project directories. The JSONL must be placed under the encoding of the directory you run `claude` from.

---

## 3. Experiment Results

All experiments ran on the same machine using two directories (`/tmp/folder-a`, `/tmp/folder-b`) to simulate a cross-machine transfer with the same git repo at a different absolute path.

### 3.1 Basic number memory

```
folder-a:  claude -p "remember 45345"
transfer:  cp <uuid>.jsonl into folder-b project dir
folder-b:  claude --resume <uuid> -p "what is the number?"
result:    → "45345"  ✅
```

### 3.2 File read — path reported from memory

```
folder-a:  claude -p "read data.txt"
           transcript stores: /private/tmp/folder-a/data.txt  (absolute)
transfer:  naive copy, no patching
folder-b:  claude --resume <uuid> -p "what was the exact file path you read?"
result:    → "/private/tmp/folder-a/data.txt"  (old machine path)

follow-up: claude --resume <uuid> -p "read that file again"
result:    → permission denied  ❌  (folder-a path, running from folder-b)
```

### 3.3 File read — transcript path-patched

```
folder-a:  claude -p "read data.txt"
transfer:  copy JSONL + replace "/private/tmp/folder-a" → "/private/tmp/folder-b"
           9 replacements made across the file
folder-b:  claude --resume <uuid> -p "what was the exact file path you read?"
result:    → "/private/tmp/folder-b/data.txt"  ✅

follow-up: claude --resume <uuid> -p "read that file again"
result:    → reads folder-b/data.txt successfully  ✅
```

**Conclusion:** naive copy is enough for conversation context (Claude remembers facts, numbers, decisions). Path patching is required for Claude to correctly re-access files after transfer.

---

## 4. Where Paths Appear in the Transcript

Analysis of a real 95 MB session (1,989 lines). All occurrences of absolute paths, by location:

| Location | Hits | Unique paths | Notes |
|---|---|---|---|
| `envelope.cwd` | 1,928 | 1 | Every line carries the cwd field |
| `user.tool_result.content` | 398 | 296 | File contents, grep output, tracebacks |
| `assistant.tool_use[Read].input.file_path` | 73 | 30 | Read tool calls |
| `user.tool_result.content.text` | 48 | 22 | Bash stdout containing paths |
| `assistant.tool_use[Bash].input.command` | 47 | 23 | cd, cat, python commands |
| `assistant.tool_use[Edit].input.file_path` | 35 | 7 | Edit tool calls |
| `assistant.tool_use[Grep].input.path` | 30 | 14 | Grep directory args |
| `user.plain_string` | 11 | 10 | User typed paths directly |
| `assistant.tool_use[Glob].input.path` | 3 | 2 | Glob directory args |
| `assistant.tool_use[Agent].input.prompt` | 3 | 1 | Paths mentioned in subagent prompts |
| `user.text` | 2 | 1 | User text blocks |
| `assistant.tool_use[Write].input.file_path` | 1 | 1 | Write tool calls |
| `assistant.tool_use[mcp__*].input.*` | 2 | 2 | MCP tool file args |

**Entry types that contain zero paths** (safe, no patching needed):

- `progress`
- `file-history-snapshot`
- `system`
- `queue-operation`
- `last-prompt`
- `assistant.thinking`
- `assistant.text` (in this session — not guaranteed)

**Patching method:** a single `str.replace(old_root, new_root)` on the raw file bytes covers every location in the table above. No JSON parsing required. All path occurrences share the same project root string.

---

## 5. Transfer Algorithm

### Assumptions
- Both machines have the same git repository checked out.
- The repo may be at a different absolute path on each machine (e.g. `/Users/alice/repo` vs `/home/bob/repo`).
- The receiving machine has Claude Code installed.

### Steps

**On the source machine:**

1. Find the JSONL:
   ```
   ~/.claude/projects/<encoded-src-path>/<session-uuid>.jsonl
   ```

2. Optionally find supporting records:
   ```
   ~/.flow/records/agentic_process/<id>/.flow_record/record.json
   ```

3. Bundle them (tar, zip, or plain copy over SSH/git).

**On the receiving machine:**

1. Compute the encoded target path:
   ```
   /home/bob/repo  →  -home-bob-repo
   ```

2. Place the JSONL:
   ```
   ~/.claude/projects/-home-bob-repo/<session-uuid>.jsonl
   ```

3. Patch all occurrences of the source root path with the target root path:
   ```python
   content = open(jsonl_path, 'rb').read()
   content = content.replace(b'/Users/alice/repo', b'/home/bob/repo')
   open(jsonl_path, 'wb').write(content)
   ```

4. Place the `AgenticProcessRecord` (if included):
   ```
   ~/.flow/records/agentic_process/<id>/.flow_record/record.json
   ```
   Clear machine-specific fields: set `pty_pid` and `shell_id` to `null`.
   Update `context_data.workdir` to the new machine's path.

5. Resume:
   ```bash
   cd /home/bob/repo && claude --resume <session-uuid>
   ```

---

## 6. What Transfers Cleanly vs What Needs Attention

| Data | Transfers? | Action |
|---|---|---|
| Conversation history (facts, decisions, reasoning) | ✅ as-is | none |
| File contents Claude already read | ✅ as-is | already in transcript |
| Absolute paths in tool calls | ⚠️ stale | patch with `str.replace` |
| `envelope.cwd` on every line | ⚠️ stale | covered by same `str.replace` |
| Active PTY / terminal output buffer | ❌ not transferred | regenerated on resume |
| `pty_pid`, `shell_id` | ❌ machine-local | set to null in record |
| `AgenticProcessRecord.context_data.workdir` | ⚠️ stale | update to new path |

---

## 7. New Transcript Entries After Transfer

Once resumed on the new machine, Claude appends new entries to the JSONL with the new machine's `cwd`. The transcript becomes a mixed record:

```
lines 1–N:    cwd=/Users/alice/repo   (source machine history)
lines N+1–M:  cwd=/home/bob/repo      (new machine, post-transfer)
```

This is expected and correct. Claude reads the full history and continues naturally.

---

## 8. Records to Transfer (flow-cli specific)

Beyond the JSONL, a full flow-cli session transfer should include:

| Record | Location | Required? | Notes |
|---|---|---|---|
| `AgenticProcessRecord` | `~/.flow/records/agentic_process/` | Recommended | Needed for flow-cli UI to show session |
| `ShellSessionRecord` | `~/.flow/records/shell_session/` | Optional | Needed to restore terminal tab state |

The `Project`, `Workspace`, `Agent`, and `ComputeNode` entities are bootstrapped locally on first run and do not need to be transferred.

---

## 9. Edge Cases

**Paths outside the project root** (e.g. `/tmp/scratch.txt`, `~/.claude/plans/foo.md`):
These appear occasionally in tool calls. A project-root replace will not patch them. They are rare and the files are unlikely to exist on the new machine. Claude will get a "file not found" error if it tries to access them, which is the correct behavior.

**macOS `/tmp` symlink:**
On macOS, `/tmp` resolves to `/private/tmp`. Claude Code uses the resolved path. The source machine path in the transcript will be `/private/tmp/...`, not `/tmp/...`. Account for this when computing the encoded project directory name.

**Sessions with multiple cwds:**
If the user ran `cd` mid-session and Claude used different absolute paths within the same session, a single `str.replace` of the project root still covers all of them, since all paths share the same root prefix.

**File contents that contain paths:**
`tool_result.content` stores raw file contents. If a source file contained hardcoded absolute paths (e.g. a config file with `/Users/alice/repo/...`), those strings will also be replaced. This is generally correct behavior — they become the new machine's paths — but worth being aware of.

**Binary content in tool results:**
Tool results are JSON strings. Path replacement on raw bytes is safe as long as the old and new paths are the same byte length or replacement is done on the decoded text. Use text mode (`str.replace`) rather than binary mode to avoid JSON encoding issues.

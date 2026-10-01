/**
 * The shell command that runs a markdown code block, or null when the block is
 * not something a terminal runs (json, yaml, a diff, an unlabelled fence).
 *
 * Every runnable language lands in the SAME place — a real terminal — because
 * that is where its output, its prompts and its Ctrl-C belong. A shell block is
 * typed as written; an interpreter block is fed to its interpreter on stdin via
 * a quoted heredoc, so the shell expands nothing inside the script.
 *
 * Pure on purpose: the Run button owns "which terminal", this owns "what to type".
 */

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh']);
/** Transcripts of a session: only the `$ ` / `% ` lines are commands, the rest is output. */
const SESSION_LANGUAGES = new Set(['console', 'shell-session', 'terminal']);
const INTERPRETERS: Record<string, string> = {
  python: 'python3 -',
  py: 'python3 -',
  python3: 'python3 -',
  javascript: 'node -',
  js: 'node -',
  mjs: 'node -',
  node: 'node -',
};

/** Quoted, so `$VAR` / backticks in the script reach the interpreter untouched. */
export const HEREDOC_DELIMITER = 'FLOWPAD_EOF';

export function codeBlockCommand(language: string, code: string): string | null {
  const lang = language.trim().toLowerCase();
  const body = code.replace(/\s+$/, '');
  if (!body.trim()) return null;

  if (SHELL_LANGUAGES.has(lang)) return body;

  if (SESSION_LANGUAGES.has(lang)) {
    const commands = body
      .split('\n')
      .map((line) => line.match(/^\s*[$%]\s+(.*)$/)?.[1])
      .filter((line): line is string => !!line?.trim());
    return commands.length ? commands.join('\n') : null;
  }

  const interpreter = INTERPRETERS[lang];
  if (interpreter) {
    // A script that itself contains the delimiter line would end the heredoc early.
    if (body.split('\n').some((line) => line.trim() === HEREDOC_DELIMITER)) return null;
    return `${interpreter} <<'${HEREDOC_DELIMITER}'\n${body}\n${HEREDOC_DELIMITER}`;
  }

  return null;
}

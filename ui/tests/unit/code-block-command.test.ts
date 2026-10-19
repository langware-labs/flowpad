import { describe, expect, it } from 'vitest';
import { codeBlockCommand, HEREDOC_DELIMITER } from '@src/terminal/code-block-command';

describe('codeBlockCommand', () => {
  it('types a shell block as written, trailing whitespace dropped', () => {
    expect(codeBlockCommand('bash', 'ls ~/.config\necho hi\n\n')).toBe('ls ~/.config\necho hi');
    expect(codeBlockCommand('SH', 'pwd')).toBe('pwd');
  });

  it('keeps only the prompt lines of a session transcript', () => {
    expect(codeBlockCommand('console', '$ ls\nfile.txt\n$ pwd\n/home')).toBe('ls\npwd');
    expect(codeBlockCommand('console', 'just output')).toBeNull();
  });

  it('feeds a script to its interpreter through a quoted heredoc', () => {
    expect(codeBlockCommand('python', 'print("$HOME")\n')).toBe(
      `python3 - <<'${HEREDOC_DELIMITER}'\nprint("$HOME")\n${HEREDOC_DELIMITER}`,
    );
    expect(codeBlockCommand('js', 'console.log(1)')).toMatch(/^node - <</);
  });

  it('refuses a script that would end its own heredoc', () => {
    expect(codeBlockCommand('python', `x = 1\n${HEREDOC_DELIMITER}\nprint(x)`)).toBeNull();
  });

  it('offers nothing for data, unlabelled or empty blocks', () => {
    expect(codeBlockCommand('json', '{}')).toBeNull();
    expect(codeBlockCommand('', 'ls')).toBeNull();
    expect(codeBlockCommand('bash', '   \n')).toBeNull();
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import type { FsRef } from '@src/hooks/use-fs-ref-content';

// A real in-memory file substrate. FsRef is the editor's I/O abstraction
// (caller-supplied closures) — this is NOT a mock of the code under test
// (useMarkdownContent's parse/serialize/save path); it's the genuine file
// the save writes to, just backed by a string instead of disk.
function memFsRef(initial: string): FsRef & { current: () => string } {
  let store = initial;
  return {
    path: '/skills/slick/SKILL.md',
    read: async () => store,
    write: async (c: string) => {
      store = c;
    },
    exists: async () => true,
    current: () => store,
  };
}

// The actual committed bytes of the corrupted slick SKILL.md: metadata is
// stranded in the body (no parseable leading `--- ... ---` fence).
const STRANDED = [
  '| <br /> | <br /> | <br /> |',
  '| :----- | :----- | :----- |',
  '',
  'id: e7d69e47-4ca0-5d06-aa52-ea46e2974787',
  'name: slick',
  'description: hello',
  '------------------------------',
  '',
  '# Slick',
  'body text',
  '',
].join('\n');

// A well-formed control: a single valid frontmatter fence.
const VALID = [
  '---',
  'id: e7d69e47-4ca0-5d06-aa52-ea46e2974787',
  'name: slick',
  'description: hello',
  '---',
  '',
  '# Slick',
  'body text',
  '',
].join('\n');

async function loadAndEditBody(initial: string): Promise<string> {
  const fs = memFsRef(initial);
  const { result } = renderHook(() =>
    useMarkdownContent(fs, { autoSave: false }),
  );

  // Wait for the initial async read() to populate content.
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  // Simulate a body edit identical to the loaded body (e.g. the editor
  // re-emitting Milkdown's serialization on focus/blur), then save.
  await act(async () => {
    result.current.setBody(result.current.body);
  });
  await act(async () => {
    await result.current.save();
  });

  return fs.current();
}

describe('markdown editor save does not inject hollow frontmatter fences', () => {
  it('a valid file stays a single parseable fence through a body-edit save', async () => {
    const after = await loadAndEditBody(VALID);
    // Control / "off" side of the switch: parseable frontmatter is NOT given a
    // hollow fence — it stays one valid `---\nid: ... \n---` block. (Field
    // values may be re-quoted; that normalization is not the corruption.)
    expect(after.startsWith('---\n\n---\n\n')).toBe(false);
    expect(after.startsWith('---\nid:')).toBe(true);
  });

  it('a stranded-metadata file must NOT gain an empty `---\\n\\n---` fence on save', async () => {
    const after = await loadAndEditBody(STRANDED);

    // BUG: serializeFrontmatter prepends `---\n${fields}\n---\n\n` even when
    // fields is empty, injecting a hollow fence and stranding the metadata
    // deeper in the body on every save. A correct editor leaves an
    // unparseable file's content alone.
    expect(after.startsWith('---\n\n---\n\n')).toBe(false);
  });
});

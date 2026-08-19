import { describe, expect, it } from 'vitest';
import { patchAgentDocument } from '@src/components/assets/editor/agent-profile/agent-document';

const CAPSULE = '<!-- flowpad:capsule identity\nversion: 1\ndata:\n  id: 59fd8b16-3416-4cfa-9b71-c5e95496ee12\nflowpad:endcapsule identity -->';
const SRC = `---\nname: x\nextra: keep-me\n---\n\nOld prompt.\n\n${CAPSULE}\n`;

describe('patchAgentDocument keeps the identity capsule', () => {
  it('re-attaches the capsule after a system_prompt swap', () => {
    const out = patchAgentDocument(SRC, { system_prompt: 'New prompt.' });
    expect(out).toContain('New prompt.');
    expect(out).not.toContain('Old prompt.');
    expect(out).toContain(CAPSULE);
    expect(out).toContain('extra: keep-me');
    expect(out.trimEnd().endsWith('flowpad:endcapsule identity -->')).toBe(true);
  });
  it('leaves the body alone when only frontmatter changes', () => {
    const out = patchAgentDocument(SRC, { description: 'd' });
    expect(out).toContain('Old prompt.');
    expect(out).toContain(CAPSULE);
  });
});

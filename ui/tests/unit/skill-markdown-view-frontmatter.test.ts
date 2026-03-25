import { describe, expect, it } from 'vitest';
import { SkillParser } from '@sdk/models/skill/SkillParser';

/**
 * Tests for FLOWPAD-1678: SKILL.md frontmatter must be preserved when editing
 * in markdown view mode.
 *
 * The SkillMarkdownView component extracts body content for the editor and
 * must re-serialize with frontmatter when onChange fires.
 */
describe('SkillMarkdownView frontmatter preservation', () => {
  const sampleContent = `---
name: my-skill
description: A test skill
tags:
  - testing
  - example
allowed-tools: Read, Write, Edit
---

# My Skill

Do something useful.`;

  it('should parse and re-serialize preserving frontmatter', () => {
    const { metadata, content: body } = SkillParser.parse(sampleContent);

    // Re-serialize with same body
    const reserialized = SkillParser.serialize(metadata, body);

    // Should still contain frontmatter
    expect(reserialized).toContain('---');
    expect(reserialized).toContain('name: my-skill');
    expect(reserialized).toContain('description: A test skill');
    expect(reserialized).toContain('# My Skill');
    expect(reserialized).toContain('Do something useful.');
  });

  it('should preserve frontmatter when body is edited', () => {
    const { metadata, content: body } = SkillParser.parse(sampleContent);

    // Simulate user editing the body in the markdown editor
    const editedBody = body + '\n\nNew paragraph added by user.';
    const reserialized = SkillParser.serialize(metadata, editedBody);

    // Frontmatter must still be present
    expect(reserialized).toContain('name: my-skill');
    expect(reserialized).toContain('description: A test skill');
    expect(reserialized).toMatch(/^---\n/);

    // Edited body must be present
    expect(reserialized).toContain('New paragraph added by user.');
    expect(reserialized).toContain('# My Skill');
  });

  it('should preserve tags and allowed-tools through parse/serialize cycle', () => {
    const { metadata } = SkillParser.parse(sampleContent);

    expect(metadata.tags).toEqual(['testing', 'example']);
    expect(metadata.allowedTools).toEqual(['Read', 'Write', 'Edit']);

    const reserialized = SkillParser.serialize(metadata, 'body');
    expect(reserialized).toContain('  - testing');
    expect(reserialized).toContain('  - example');
    expect(reserialized).toContain('allowed-tools: Read, Write, Edit');
  });

  it('should preserve extra/unknown frontmatter fields', () => {
    const contentWithExtra = `---
name: my-skill
description: A test skill
custom-field: custom-value
tags:
  - test
---

Body content.`;

    const { metadata, content: body } = SkillParser.parse(contentWithExtra);

    expect(metadata.extra).toHaveProperty('custom-field', 'custom-value');

    const reserialized = SkillParser.serialize(metadata, body);
    expect(reserialized).toContain('custom-field: custom-value');
    expect(reserialized).toContain('name: my-skill');
  });

  it('should fail if only body is returned without frontmatter (the bug)', () => {
    const { content: bodyOnly } = SkillParser.parse(sampleContent);

    // This is what the broken SkillMarkdownView did: pass body-only to onChange
    // Verify that body-only content does NOT contain frontmatter
    expect(bodyOnly).not.toContain('---');
    expect(bodyOnly).not.toContain('name: my-skill');

    // And that it would fail to re-parse (proving data loss)
    expect(() => SkillParser.parse(bodyOnly)).toThrow('Invalid SKILL.md format');
  });
});

describe('SkillMarkdownView editable frontmatter name and description', () => {
  const sampleContent = `---
name: my-skill
description: A test skill
tags:
  - testing
allowed-tools: Read, Write
---

# Instructions

Do something useful.`;

  it('should update name in frontmatter while preserving body and other fields', () => {
    const { metadata, content: body } = SkillParser.parse(sampleContent);

    // Simulate editing the name field
    const updated = { ...metadata, name: 'renamed-skill' };
    const reserialized = SkillParser.serialize(updated, body);

    // New name should be present
    expect(reserialized).toContain('name: renamed-skill');
    // Old name should be gone
    expect(reserialized).not.toContain('name: my-skill');
    // Other fields preserved
    expect(reserialized).toContain('description: A test skill');
    expect(reserialized).toContain('  - testing');
    expect(reserialized).toContain('allowed-tools: Read, Write');
    // Body preserved
    expect(reserialized).toContain('# Instructions');
    expect(reserialized).toContain('Do something useful.');
  });

  it('should update description in frontmatter while preserving body and other fields', () => {
    const { metadata, content: body } = SkillParser.parse(sampleContent);

    // Simulate editing the description field
    const updated = { ...metadata, description: 'Updated description for the skill' };
    const reserialized = SkillParser.serialize(updated, body);

    // New description should be present
    expect(reserialized).toContain('description: Updated description for the skill');
    // Old description should be gone
    expect(reserialized).not.toContain('description: A test skill');
    // Other fields preserved
    expect(reserialized).toContain('name: my-skill');
    expect(reserialized).toContain('  - testing');
    expect(reserialized).toContain('allowed-tools: Read, Write');
    // Body preserved
    expect(reserialized).toContain('Do something useful.');
  });

  it('should allow editing both name and description together', () => {
    const { metadata, content: body } = SkillParser.parse(sampleContent);

    // Simulate editing name, then description
    const updated = { ...metadata, name: 'new-name', description: 'new description' };
    const reserialized = SkillParser.serialize(updated, body);

    const reparsed = SkillParser.parse(reserialized);
    expect(reparsed.metadata.name).toBe('new-name');
    expect(reparsed.metadata.description).toBe('new description');
    expect(reparsed.metadata.tags).toEqual(['testing']);
    expect(reparsed.metadata.allowedTools).toEqual(['Read', 'Write']);
    expect(reparsed.content).toContain('Do something useful.');
  });

  it('should allow clearing description', () => {
    const { metadata, content: body } = SkillParser.parse(sampleContent);

    const updated = { ...metadata, description: '' };
    const reserialized = SkillParser.serialize(updated, body);

    // Empty description should not appear in frontmatter
    expect(reserialized).not.toContain('description:');
    // Re-parsing should work
    const reparsed = SkillParser.parse(reserialized);
    expect(reparsed.metadata.name).toBe('my-skill');
    expect(reparsed.metadata.description).toBe('');
  });

  it('should preserve body edits when name changes', () => {
    const { metadata, content: body } = SkillParser.parse(sampleContent);

    // Simulate: user edits body first, then changes name
    const editedBody = body + '\n\nExtra line.';
    const updated = { ...metadata, name: 'changed-name' };
    const reserialized = SkillParser.serialize(updated, editedBody);

    expect(reserialized).toContain('name: changed-name');
    expect(reserialized).toContain('Extra line.');
    expect(reserialized).toContain('Do something useful.');
  });

  it('should not lose trailing whitespace in description during edit round-trip', () => {
    const { metadata, content: body } = SkillParser.parse(sampleContent);

    // Simulate user typing "A test skill " (with trailing space, mid-typing)
    const withTrailingSpace = { ...metadata, description: 'A test skill ' };
    const serialized = SkillParser.serialize(withTrailingSpace, body);

    // The serialized content includes the trailing space in the YAML line
    expect(serialized).toContain('description: A test skill ');

    // But re-parsing trims it — this is expected YAML behavior.
    // The fix is that SkillMarkdownView skips re-parsing metadata on internal
    // changes (matching lastEmittedRef), so the state keeps the untrimmed value.
    const reparsed = SkillParser.parse(serialized);
    expect(reparsed.metadata.description).toBe('A test skill');

    // Verify the serialized content differs from what a clean round-trip produces,
    // proving that the component must NOT re-parse on internal changes.
    const reserializedFromParsed = SkillParser.serialize(reparsed.metadata, reparsed.content);
    expect(serialized).not.toBe(reserializedFromParsed);
  });

  it('should preserve description with multiple internal spaces', () => {
    const { metadata, content: body } = SkillParser.parse(sampleContent);

    const updated = { ...metadata, description: 'A skill  with  double  spaces' };
    const reserialized = SkillParser.serialize(updated, body);

    expect(reserialized).toContain('description: A skill  with  double  spaces');
    // Internal spaces survive the parse round-trip (only leading/trailing trimmed)
    const reparsed = SkillParser.parse(reserialized);
    expect(reparsed.metadata.description).toBe('A skill  with  double  spaces');
  });
});

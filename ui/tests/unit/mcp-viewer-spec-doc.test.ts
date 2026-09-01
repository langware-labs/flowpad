import { describe, expect, it } from 'vitest';
import { withDefaults } from '@src/components/assets/editor/mcp/McpViewer';

describe('withDefaults', () => {
  it('supplies what mcp.json omits', () => {
    // The file is written with `exclude_defaults=True`, so a server sitting on
    // its defaults really does arrive as just a name.
    expect(withDefaults({ name: 'x' })).toMatchObject({
      name: 'x',
      transport: 'stdio',
      args: [],
      env: {},
    });
  });

  it('keeps a key the form does not render', () => {
    // The regression this file exists for: the form writes the WHOLE document
    // back, so anything the normalizer drops is erased on the next edit. The
    // first version hand-listed the fields and forgot `entrypoint`, so editing
    // any field on a bundled server unbundled it — silently, and permanently,
    // since the scaffolder then early-returns.
    const doc = { name: 'x', entrypoint: 'server.py', future_field: 'kept' };
    expect(withDefaults(doc)).toMatchObject(doc);
  });
});

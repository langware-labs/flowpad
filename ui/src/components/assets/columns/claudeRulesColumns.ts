import { registerColumns } from './columnRegistry';
import { pathCell, scopeTag } from './columnHelpers';

registerColumns('claude_rules', [
  { key: 'scope', header: 'Scope', render: (r) => scopeTag(r.scope) },
  { key: 'source_path', header: 'File', render: (r) => pathCell(r.source_path) },
]);

import { registerColumns } from './columnRegistry';
import { pathCell, scopeTag } from './columnHelpers';

registerColumns('claude_rules', [
  { key: 'scope', header: 'Scope', render: (r) => scopeTag(r.scope) },
  { key: 'asset_ref', header: 'File', render: (r) => pathCell(r.asset_ref) },
]);

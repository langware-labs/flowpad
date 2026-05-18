import { registerColumns } from './columnRegistry';
import { pathCell } from './columnHelpers';

registerColumns('claude_rules', [
  { key: 'asset_ref', header: 'File', render: (r) => pathCell(r.asset_ref) },
]);

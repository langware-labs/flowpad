import { registerColumns } from './columnRegistry';
import { pathCell } from './columnHelpers';

registerColumns('claude_memory', [
  { key: 'asset_ref', header: 'File', render: (r) => pathCell(r.asset_ref) },
]);

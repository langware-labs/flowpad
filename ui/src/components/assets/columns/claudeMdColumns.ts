import { registerColumns } from './columnRegistry';
import { pathCell } from './columnHelpers';

registerColumns('claude_md', [
  { key: 'asset_ref', header: 'File', render: (r) => pathCell(r.file_path || r.asset_ref) },
]);

import { registerColumns } from './columnRegistry';
import { pathCell } from './columnHelpers';

registerColumns('project', [
  { key: 'asset_ref', header: 'Path', render: (r) => pathCell(r.asset_ref) },
]);

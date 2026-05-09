import { registerColumns } from './columnRegistry';
import { pathCell, truncCell } from './columnHelpers';

registerColumns('skill', [
  { key: 'description', header: 'Description', render: (r) => truncCell(r.description, 60) },
  { key: 'asset_ref', header: 'Location', render: (r) => pathCell(r.asset_ref) },
]);

import { registerColumns } from './columnRegistry';
import { pathCell, truncCell } from './columnHelpers';

registerColumns('skill', [
  { key: 'description', header: 'Description', render: (r) => truncCell(r.description, 60) },
  { key: 'source_path', header: 'Location', render: (r) => pathCell(r.source_path) },
]);

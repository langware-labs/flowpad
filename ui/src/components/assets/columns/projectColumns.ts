import { registerColumns } from './columnRegistry';
import { pathCell } from './columnHelpers';

registerColumns('project', [
  { key: 'source_path', header: 'Path', render: (r) => pathCell(r.source_path) },
]);

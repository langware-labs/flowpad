import { registerColumns } from './columnRegistry';
import { truncCell } from './columnHelpers';

registerColumns('task', [
  { key: 'title', header: 'Title', render: (r) => truncCell(r.title, 50) },
]);

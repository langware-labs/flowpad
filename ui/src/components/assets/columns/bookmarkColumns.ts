import { registerColumns } from './columnRegistry';
import { pathCell } from './columnHelpers';

registerColumns('bookmark', [
  { key: 'work_dir', header: 'Work Dir', render: (r) => r.work_dir ? pathCell(r.work_dir) : '—' },
]);

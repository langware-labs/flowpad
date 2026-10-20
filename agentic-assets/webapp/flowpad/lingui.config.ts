// Vite runs from this folder (so Flowpad owns the process); Lingui finds its config here.
// rootDir keeps the catalogs under ui/, where they live.
import base from '../../../ui/lingui.config';

export default { ...base, rootDir: '../../../ui' };

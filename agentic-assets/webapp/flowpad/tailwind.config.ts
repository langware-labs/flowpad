// Vite runs from this folder (so Flowpad owns the process); Tailwind looks for its config here.
import base from '../../../ui/tailwind.config';

export default { ...base, content: ['../../../ui/index.html', '../../../ui/src/**/*.{js,ts,jsx,tsx}'] };

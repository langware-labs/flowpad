import { afterEach, describe, expect, it } from 'vitest';
import { apiBase, apiOrigin } from '../manual_regression/_shared/api';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('manual-regression API origin', () => {
  it('prefers the dedicated QA override and normalizes trailing slashes', () => {
    process.env.QA_API_URL = 'http://localhost:6123///';
    process.env.API_URL = 'http://localhost:6124';
    process.env.VITE_API_URL = 'http://localhost:6125';

    expect(apiOrigin()).toBe('http://localhost:6123');
    expect(apiBase()).toBe('http://localhost:6123');
  });

  it('uses the backend URL injected into the app when no test override exists', () => {
    delete process.env.QA_API_URL;
    delete process.env.API_URL;
    process.env.VITE_API_URL = 'http://localhost:6234';

    expect(apiOrigin()).toBe('http://localhost:6234');
    expect(apiBase()).toBe('http://localhost:6234');
  });
});

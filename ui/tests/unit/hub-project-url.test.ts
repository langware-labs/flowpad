import { describe, expect, it } from 'vitest';
import { TypeId } from '@sdk';
import { hubPageUrl, hubProjectUrl } from '@src/lib/hub-page-url';

describe('hubProjectUrl', () => {
  it('builds the canonical Hub Project dock URL from the app origin', () => {
    expect(hubProjectUrl('https://hub.flowpad.ai/', '12345678-0000-4000-8000-000000000000')).toBe(
      'https://hub.flowpad.ai/dock/hub/project/12345678-0000-4000-8000-000000000000',
    );
  });

  it('requires both app origin and project id', () => {
    expect(hubProjectUrl('', '12345678-0000-4000-8000-000000000000')).toBeNull();
    expect(hubProjectUrl('https://hub.flowpad.ai', null)).toBeNull();
  });

  it('routes Project TypeIds through the canonical dock URL', () => {
    expect(hubPageUrl('https://hub.flowpad.ai', new TypeId('project', '12345678-0000-4000-8000-000000000000'))).toBe(
      'https://hub.flowpad.ai/dock/hub/project/12345678-0000-4000-8000-000000000000',
    );
  });
});

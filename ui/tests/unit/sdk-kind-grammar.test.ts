// The shape grammar read by the SDK, so an app never re-splits `enum:a|b` or `a|b` itself (found on
// GTM Studio: seven views each parsed it by hand).
import { describe, expect, it } from 'vitest';

import { enumValues, linkTargets, parseValueRef } from '../../../ts_sdk/src/viewers/kinds';

describe('enumValues', () => {
  it('reads a closed set, optional or not', () => {
    expect(enumValues('enum:new|won|lost')).toEqual(['new', 'won', 'lost']);
    expect(enumValues('?enum:a|b')).toEqual(['a', 'b']);
  });

  it.each(['string', '?crm.lead', ['enum:a|b'], { a: 'string' }])('is null for %j', (shape) => {
    expect(enumValues(shape)).toBeNull();
  });
});

describe('linkTargets', () => {
  it('names the kinds a link field may point at', () => {
    expect(linkTargets('?--acme--.crm.company')).toEqual(['--acme--.crm.company']);
    expect(linkTargets('crm.company|crm.lead')).toEqual(['crm.company', 'crm.lead']);
    expect(linkTargets(['?crm.note'])).toEqual(['crm.note']);
  });

  it.each(['string', 'date', 'enum:a|b', ['string'], { name: 'string' }, '*'])('is null for %j', (shape) => {
    expect(linkTargets(shape)).toBeNull();
  });
});

describe('parseValueRef', () => {
  it('splits a reference into its kind and id', () => {
    expect(parseValueRef('--acme--.crm.lead.id.3f6c0d4e-8a1b-4c2d-9e3f-5a6b7c8d9e0f')).toEqual({
      kind: '--acme--.crm.lead',
      id: '3f6c0d4e-8a1b-4c2d-9e3f-5a6b7c8d9e0f',
    });
  });

  it.each(['crm.lead', 'crm.lead.id.not-a-uuid', 7, null])('is null for %j', (text) => {
    expect(parseValueRef(text)).toBeNull();
  });
});

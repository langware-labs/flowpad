import { getUtmParams } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('UTM Parameters', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // Mock window.location
    delete (window as any).location;
  });

  afterEach(() => {
    // Restore window.location
    (window as any).location = originalLocation;
  });

  it('extracts all utm_* parameters from URL', () => {
    (window as any).location = {
      search: '?utm_source=google&utm_medium=cpc&utm_campaign=summer_sale&other=ignored',
    };

    const result = getUtmParams();

    expect(result).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'summer_sale',
    });
  });

  it('returns empty object when no utm params exist', () => {
    (window as any).location = {
      search: '?foo=bar&baz=qux',
    };

    const result = getUtmParams();

    expect(result).toEqual({});
  });

  it('returns empty object for empty search string', () => {
    (window as any).location = {
      search: '',
    };

    const result = getUtmParams();

    expect(result).toEqual({});
  });

  it('captures custom utm_* parameters', () => {
    (window as any).location = {
      search: '?utm_source=email&utm_custom_field=special',
    };

    const result = getUtmParams();

    expect(result).toEqual({
      utm_source: 'email',
      utm_custom_field: 'special',
    });
  });

  it('handles all standard utm parameters', () => {
    (window as any).location = {
      search: '?utm_source=src&utm_medium=med&utm_campaign=camp&utm_content=cont&utm_term=term',
    };

    const result = getUtmParams();

    expect(result).toEqual({
      utm_source: 'src',
      utm_medium: 'med',
      utm_campaign: 'camp',
      utm_content: 'cont',
      utm_term: 'term',
    });
  });
});

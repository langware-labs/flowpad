import { Page } from '@sdk';
import { describe, expect, it } from 'vitest';

describe('page suite', () => {
  it('page type', () => {
    expect(Page.type).toBe('page');
  });

  it('page title', () => {
    const page = new Page({ title: 'Test Page' });
    expect(page.title).toBe('Test Page');
  });
});

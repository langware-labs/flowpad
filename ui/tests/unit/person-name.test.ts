import { describe, expect, it } from 'vitest';
import { personName } from '@src/components/conversation/participant-display';

describe('personName — never empty, never "unknown", never an email', () => {
  it('prefers a real name, else a short name from the email, else a short id', () => {
    expect(personName({ name: 'Gadi Tunes' })).toBe('Gadi Tunes');
    expect(personName({ name: null, email: 'john.doe@x.io' })).toBe('John Doe');
    expect(personName({ name: 'shanis@z-school.co.il' })).toBe('Shanis');
    expect(personName({ email: `${'a'.repeat(40)}@x.io` })).toHaveLength(20);
    expect(personName({ name: null, email: null, user_id: 'c6a858da-f727' })).toBe('User c6a858');
  });
});

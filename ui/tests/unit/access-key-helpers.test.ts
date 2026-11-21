/**
 * The access-key helpers that carry bytes and codes between the browser's passkey prompt and
 * the hub: base64url both ways, the short code's display form, and how a failed add is sorted.
 */
import { describe, expect, it } from 'vitest';
import {
  aaguidOf,
  accessKeyFailure,
  authenticatorName,
  base64UrlToBytes,
  bytesToBase64Url,
  decodeAssertion,
  encodeAssertion,
  formatAccessKeyCode,
  registrationResponseToJSON,
} from '@sdk/services/access-key';

describe('access key helpers', () => {
  it('base64url: URL-safe alphabet, no padding, and back to the same bytes', () => {
    const bytes = new Uint8Array([251, 255, 254, 0, 1]);
    const text = bytesToBase64Url(bytes);
    expect(text).toBe('-__-AAE');
    expect([...base64UrlToBytes(text)]).toEqual([...bytes]);
    expect(bytesToBase64Url(bytes.buffer)).toBe(text);
    // A view onto part of a buffer encodes only its own bytes.
    expect(bytesToBase64Url(new Uint8Array(bytes.buffer, 3, 2))).toBe('AAE');
    expect([...base64UrlToBytes('')]).toEqual([]);
  });

  it('shows a key code as two groups of four', () => {
    expect(formatAccessKeyCode('3f9ac271')).toBe('3f9a c271');
    expect(formatAccessKeyCode('abc')).toBe('abc');
  });

  it('turns the browser credential into a RegistrationResponseJSON', () => {
    const credential = {
      id: 'AQI',
      rawId: new Uint8Array([1, 2]).buffer,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
      response: {
        clientDataJSON: new Uint8Array([3]).buffer,
        attestationObject: new Uint8Array([4, 5]).buffer,
        getTransports: () => ['internal', 'hybrid'],
      },
    } as unknown as PublicKeyCredential;
    expect(registrationResponseToJSON(credential)).toEqual({
      id: 'AQI',
      rawId: 'AQI',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: true } },
      response: { clientDataJSON: 'Aw', attestationObject: 'BAU', transports: ['internal', 'hybrid'] },
    });
  });

  it('an assertion rides in an address as one URL-safe word and comes back the same', () => {
    const assertion = {
      id: 'AQI',
      rawId: 'AQI',
      type: 'public-key',
      response: { authenticatorData: 'BAU', clientDataJSON: 'Aw', signature: '-__-', userHandle: null },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
    const word = encodeAssertion(assertion);
    expect(word).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAssertion(word)).toEqual(assertion);
    expect(() => decodeAssertion('not an assertion')).toThrow();
  });

  it('names a new key after what keeps it, read from the AAGUID in its authenticator data', () => {
    expect(authenticatorName('fbfc3007-154e-4ecc-8c0b-6e020557d7bd')).toBe('iCloud Keychain');
    expect(authenticatorName('EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4')).toBe('Google Password Manager');
    expect(authenticatorName('bada5566-a7aa-401f-bd96-45619a55120d')).toBe('1Password');
    expect(authenticatorName('adce0002-35bc-c60a-648b-0b25f1f05503')).toBe('Chrome on Mac');
    expect(authenticatorName('08987058-cadc-51b2-bc80-37a3dc8f6d5c')).toBe('Windows Hello');
    expect(authenticatorName('d548826e-79b4-db40-a3d8-11116f7e8349')).toBe('Bitwarden');
    expect(authenticatorName('00000000-0000-0000-0000-000000000000')).toBe('Passkey');
    expect(authenticatorName('12345678-1234-1234-1234-123456789abc')).toBe('Passkey');
    expect(authenticatorName(null)).toBe('Passkey');

    // 37 bytes of RP id hash, flags and sign count, then the 16 AAGUID bytes.
    const data = new Uint8Array(60);
    data.set([0xfb, 0xfc, 0x30, 0x07, 0x15, 0x4e, 0x4e, 0xcc, 0x8c, 0x0b, 0x6e, 0x02, 0x05, 0x57, 0xd7, 0xbd], 37);
    expect(aaguidOf(data)).toBe('fbfc3007-154e-4ecc-8c0b-6e020557d7bd');
    expect(aaguidOf(data.buffer)).toBe('fbfc3007-154e-4ecc-8c0b-6e020557d7bd');
    // Authenticator data with no attested credential in it carries no AAGUID.
    expect(aaguidOf(new Uint8Array(37))).toBeNull();
    expect(aaguidOf(undefined)).toBeNull();
  });

  it.each([
    [{ name: 'NotAllowedError' }, 'cancelled'],
    [{ name: 'InvalidStateError' }, 'duplicate'],
    [{ response: { status: 400, data: { message: 'wrong code' } } }, 'wrong_code'],
    [{ response: { status: 400, data: { message: 'the passkey request expired, start again' } } }, 'expired'],
    [{ response: { status: 400, data: { message: "the passkey was not made on this hub's page" } } }, 'unsupported'],
    [{ response: { status: 400, data: { message: 'the passkey could not be verified' } } }, 'unknown'],
    [{ response: { status: 429 } }, 'too_many_attempts'],
    [{ response: { status: 409, data: { message: 'this key was already added' } } }, 'duplicate'],
    [{ response: { status: 409, data: { message: 'key limit reached' } } }, 'key_limit'],
    [{ response: { status: 403 } }, 'forbidden'],
    [new Error('boom'), 'unknown'],
  ])('sorts a failed add %j as %s', (error, reason) => {
    expect(accessKeyFailure(error)).toBe(reason);
  });
});

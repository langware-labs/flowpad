/**
 * Access keys — the passkeys a person registers on the hub to open remote control of their
 * machines. Every call is a hub-owned user action on the caller's OWN user
 * (`/graph/user/<id>/<action>`), forwarded verbatim by the local server.
 *
 * The passkey prompt (`registerPasskey`) must run on a hub page in a real browser: the hub checks
 * the origin the browser signed, and the Electron window is not that origin.
 */
import { dataManager } from '../APIEntity';
import { dataContext } from '../FlowSync/context';
import type { HttpMethod } from '../models/ApiUrl';
import { hubAction } from './hub-action';

export interface AccessKey {
  id: string;
  kind: 'passkey';
  /** base64url. */
  credential_id: string;
  /** base64url, the COSE key bytes. */
  public_key: string;
  /** COSE algorithm number (-7 is ES256). */
  algorithm: number;
  label: string;
  /** 8 lowercase hex: the start of the SHA-256 of the public key. */
  code: string;
  /** The passkey may be synced between the person's devices. */
  backup_eligible: boolean;
  backup_state: boolean;
  transports: string[];
  added_via: 'email_code';
  request_id: string | null;
  request_node: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Why adding a key failed, in the terms the dialog explains. */
export type AccessKeyFailure =
  | 'wrong_code'
  | 'too_many_attempts'
  | 'cancelled'
  | 'duplicate'
  | 'key_limit'
  | 'expired'
  | 'forbidden'
  | 'unsupported'
  | 'unknown';

export function bytesToBase64Url(bytes: ArrayBuffer | ArrayBufferView): string {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A key's short code as shown everywhere: two groups of four (`3f9a c271`). */
export function formatAccessKeyCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

/** The creation options as the hub sends them: every binary field is base64url. */
interface CreationOptionsJSON {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  [key: string]: unknown;
}

function creationOptionsFromJSON(options: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64UrlToBytes(options.challenge),
    user: { ...options.user, id: base64UrlToBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
      ...c,
      id: base64UrlToBytes(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
  };
}

/** The browser's new credential as a RegistrationResponseJSON (binary fields base64url). */
export function registrationResponseToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      attestationObject: bytesToBase64Url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  };
}

/** A signed challenge as an AuthenticationResponseJSON: every binary field is base64url. */
export interface PasskeyAssertion {
  id: string;
  rawId: string;
  type: string;
  response: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle: string | null;
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment: string | null;
}

/**
 * Sign `challenge` (base64url) with one of `keys` — the browser's passkey prompt, fingerprint
 * required. Runs on a hub page in a real browser, like `registerPasskey`: the relying party is the
 * page's own host. The machine that made the challenge checks the answer; the hub takes no part.
 */
export async function signWithPasskey({
  challenge,
  keys,
}: {
  challenge: string;
  keys: Pick<AccessKey, 'credential_id' | 'transports'>[];
}): Promise<PasskeyAssertion> {
  if (typeof navigator === 'undefined' || !navigator.credentials?.get) {
    throw new DOMException('Passkeys are not supported here', 'NotSupportedError');
  }
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: base64UrlToBytes(challenge),
      rpId: window.location.hostname,
      allowCredentials: keys.map((key) => ({
        type: 'public-key' as const,
        id: base64UrlToBytes(key.credential_id),
        transports: key.transports as AuthenticatorTransport[],
      })),
      userVerification: 'required',
      timeout: 60000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new DOMException('Nothing was signed', 'NotAllowedError');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      signature: bytesToBase64Url(response.signature),
      userHandle: response.userHandle ? bytesToBase64Url(response.userHandle) : null,
    },
    clientExtensionResults: (credential.getClientExtensionResults?.() ?? {}) as Record<string, unknown>,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
  };
}

/** An assertion as one URL-safe word (base64url of its JSON text), to ride in an address. */
export function encodeAssertion(assertion: PasskeyAssertion): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(assertion)));
}

/** The reverse of `encodeAssertion`. Throws on text that is not one. */
export function decodeAssertion(text: string): PasskeyAssertion {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(text))) as PasskeyAssertion;
}

const DEFAULT_AUTHENTICATOR_NAME = 'Passkey';
const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

/** Who keeps a passkey, by the AAGUID its authenticator states. Product names, not translated. */
const AUTHENTICATOR_NAMES: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-51b2-bc80-37a3dc8f6d5c': 'Windows Hello',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
};

/** A new key's default label: the name of what keeps it, or "Passkey" when it does not say. */
export function authenticatorName(aaguid: string | null | undefined): string {
  const id = (aaguid ?? '').toLowerCase();
  if (!id || id === ZERO_AAGUID) return DEFAULT_AUTHENTICATOR_NAME;
  return AUTHENTICATOR_NAMES[id] ?? DEFAULT_AUTHENTICATOR_NAME;
}

// Authenticator data: 32 bytes RP id hash, 1 flags, 4 sign count, then the 16-byte AAGUID.
const AAGUID_START = 37;
const AAGUID_END = 53;

/** The AAGUID inside a new credential's authenticator data, as a lowercase UUID; null when it is not there. */
export function aaguidOf(authenticatorData: ArrayBuffer | ArrayBufferView | null | undefined): string | null {
  if (!authenticatorData) return null;
  const bytes =
    authenticatorData instanceof ArrayBuffer
      ? new Uint8Array(authenticatorData)
      : new Uint8Array(authenticatorData.buffer, authenticatorData.byteOffset, authenticatorData.byteLength);
  if (bytes.length < AAGUID_END) return null;
  const hex = Array.from(bytes.subarray(AAGUID_START, AAGUID_END), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ownUserId(): string {
  const id = dataContext.currentUser?.id;
  if (!id) throw new Error('No signed-in user');
  return String(id);
}

function call<R>(name: string, method: HttpMethod, body?: Record<string, unknown>): Promise<R> {
  const info = hubAction(name, 'user', ownUserId(), method);
  if (body) info.bodyParameters = body;
  return dataManager.callAction<undefined, R>(info);
}

/** The caller's keys that are not revoked, oldest first. */
export async function listAccessKeys(): Promise<AccessKey[]> {
  const data = await call<{ keys: AccessKey[] }>('access_keys', 'GET');
  return data?.keys ?? [];
}

/** Email the caller the 6-digit code every add needs. */
export function requestEmailCode(): Promise<{ sent: boolean; expires_in: number }> {
  return call('access_key_email_code', 'POST', {});
}

/**
 * Add a passkey: ask the hub for the options, let the browser create the credential, send it back
 * with the emailed code. `requestId` / `requestNode` tie the key to the machine that asked for it.
 */
export async function registerPasskey({
  code,
  label,
  requestId,
  requestNode,
}: {
  code: string;
  label?: string;
  requestId?: string | null;
  requestNode?: string | null;
}): Promise<AccessKey> {
  if (typeof navigator === 'undefined' || !navigator.credentials?.create) {
    throw new DOMException('Passkeys are not supported here', 'NotSupportedError');
  }
  const { options, challenge_token } = await call<{ options: CreationOptionsJSON; challenge_token: string }>(
    'access_key_passkey_options',
    'POST',
    {},
  );
  const credential = (await navigator.credentials.create({
    publicKey: creationOptionsFromJSON(options),
  })) as PublicKeyCredential | null;
  if (!credential) throw new DOMException('No passkey was created', 'NotAllowedError');
  // No name from the caller: the key is called after what keeps it (a browser too old to say gets "Passkey").
  const attestation = credential.response as AuthenticatorAttestationResponse;
  const name = label || authenticatorName(aaguidOf(attestation.getAuthenticatorData?.()));
  const { key } = await call<{ key: AccessKey }>('access_key_add', 'POST', {
    code,
    challenge_token,
    credential: registrationResponseToJSON(credential),
    label: name,
    ...(requestId ? { request_id: requestId } : {}),
    ...(requestNode ? { request_node: requestNode } : {}),
  });
  return key;
}

export async function renameAccessKey(id: string, label: string): Promise<AccessKey> {
  const { key } = await call<{ key: AccessKey }>('access_key_rename', 'POST', { id, label });
  return key;
}

export function removeAccessKey(id: string): Promise<{ removed: boolean }> {
  return call('access_key_remove', 'POST', { id });
}

/** Sort a failed add into the cases the dialog words: the browser's own errors, then the hub's status. */
export function accessKeyFailure(error: unknown): AccessKeyFailure {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
  // The authenticator already holds one of the account's keys (`excludeCredentials`).
  if (name === 'InvalidStateError') return 'duplicate';
  if (name === 'NotSupportedError' || name === 'SecurityError') return 'unsupported';
  const response = (error as { response?: { status?: number; data?: { message?: unknown } } } | null)?.response;
  const message = typeof response?.data?.message === 'string' ? response.data.message.toLowerCase() : '';
  switch (response?.status) {
    case 429:
      return 'too_many_attempts';
    case 409:
      return message.includes('limit') ? 'key_limit' : 'duplicate';
    case 403:
      return 'forbidden';
    case 400:
      if (message.includes('code')) return 'wrong_code';
      if (message.includes('expired')) return 'expired';
      // The hub refuses a passkey made on a page that is not its own.
      return message.includes('page') ? 'unsupported' : 'unknown';
    default:
      return 'unknown';
  }
}

import apiClient from '../client';
import type { PasskeyAssertion } from './access-key';

const BASE = '/remote-control';

/** Why remote control cannot be used on this machine right now. */
export type RemoteControlUnavailableReason = 'signed_out' | 'private' | 'identity';

/** One access key as this machine holds it. */
export interface MachineAccessKey {
  credential_id: string;
  label: string;
  /** 8 lowercase hex, the same code the hub shows for the key. */
  code: string;
  kind: string;
  /** `pending` waits for Allow and is dropped at `expires_at`. */
  state: 'accepted' | 'pending';
  accepted_at: string | null;
  expires_at: string | null;
}

export interface RemoteControlStatus {
  available: boolean;
  reason: RemoteControlUnavailableReason | null;
  /** True only between a fingerprint-confirmed turn-on and `open_until`. */
  on: boolean;
  /** When the open window ends (ISO); null while off. */
  open_until: string | null;
  /** The hours of the current or the last window; null before the first turn-on. */
  hours: number | null;
  /** How the last window ended: by itself at its deadline, or by Lock now. Null before the first one ends. */
  last_off: 'expired' | 'locked' | null;
  /** The window lengths `turnOn` takes, in hours. */
  hours_options: number[];
  node_typeid: string | null;
  machine_name: string;
  keys: MachineAccessKey[];
  /** The open "add an access key" request, while it lives. */
  request: { id: string; expires_at: string } | null;
}

/** What `request` answers: the hub page to open in the browser, and the request it carries. */
export interface RemoteControlRequest {
  url: string;
  request_id: string;
  node_typeid: string;
  expires_at: string;
}

/** What `turnOn` answers: the hub page that runs the passkey prompt, and when its challenge runs out. */
export interface RemoteControlTurnOn {
  url: string;
  expires_at: string;
}

/**
 * SDK service for this machine's Remote control: the open window and the access keys the machine
 * accepted. Local routes only — the keys themselves are added on the hub (`access-key.ts`).
 *
 * Turning on is two steps: `turnOn` makes a challenge and names the hub page to open in the
 * browser; that page signs the challenge with the person's passkey (`signWithPasskey`) and hands
 * the answer back to the app, which gives it to `confirm`. The machine checks the signature itself.
 */
export class RemoteControlService {
  status(): Promise<RemoteControlStatus> {
    return apiClient.get(`${BASE}/status`);
  }

  /** Register this machine on the hub if needed and open a 10-minute request for a new key. */
  request(): Promise<RemoteControlRequest> {
    return apiClient.post(`${BASE}/request`, {});
  }

  /**
   * Read the account's keys from the hub: a key made for this machine's request is accepted, any
   * other waits as pending.
   */
  refresh(): Promise<RemoteControlStatus> {
    return apiClient.post(`${BASE}/refresh`, {});
  }

  /** Accept a pending key. */
  allow(credentialId: string): Promise<RemoteControlStatus> {
    return apiClient.post(`${BASE}/allow`, { credential_id: credentialId });
  }

  remove(credentialId: string): Promise<RemoteControlStatus> {
    return apiClient.post(`${BASE}/remove`, { credential_id: credentialId });
  }

  /**
   * Ask to turn remote control on for `hours`. Nothing is on yet: the answer is the hub page that
   * asks for the fingerprint. 409 with no accepted key, 400 for hours the machine does not offer.
   */
  turnOn(hours: number): Promise<RemoteControlTurnOn> {
    return apiClient.post(`${BASE}/turn-on`, { hours });
  }

  /** Hand over the signed challenge (an AuthenticationResponseJSON). On success the window is open. */
  confirm(assertion: PasskeyAssertion): Promise<RemoteControlStatus> {
    return apiClient.post(`${BASE}/confirm`, { assertion });
  }

  /** Lock now: off at once. Always allowed. */
  lock(): Promise<RemoteControlStatus> {
    return apiClient.post(`${BASE}/lock`, {});
  }
}

export const remoteControlService = new RemoteControlService();

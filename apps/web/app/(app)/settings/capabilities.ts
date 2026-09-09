/**
 * Which of the provider-backed settings sections the mail backend behind this
 * account can actually serve. `GET /settings` reports them as `capabilities`;
 * Zimbra reports every flag true.
 *
 * Everything here defaults to **true**. An absent object (a server that
 * predates the field, or a request that raced a deploy) and an absent
 * individual flag (a server that grew a new capability we do not know about)
 * both mean "render it" — so the gating can only ever hide a section a backend
 * has explicitly disclaimed, never hide one by accident.
 */
export interface SettingsCapabilities {
  /** Stored signatures can be listed, created, edited and deleted. */
  signatures: boolean;
  /** Sending identities (display name, reply-to) can be read and edited. */
  identities: boolean;
  /** Server-side mail preferences (reading/composing/vacation) can be read and written. */
  serverPrefs: boolean;
  /** The account password can be changed from here. */
  changePassword: boolean;
  /**
   * The backend can run a two-factor challenge. Consumed at login, not on this
   * page — there is no 2FA enrolment UI in settings today — so nothing here is
   * gated on it. It is carried through so the flag set matches the API's.
   */
  twoFactor: boolean;
}

export const ALL_CAPABILITIES: SettingsCapabilities = {
  signatures: true,
  identities: true,
  serverPrefs: true,
  changePassword: true,
  twoFactor: true,
};

export function resolveCapabilities(
  raw?: Partial<SettingsCapabilities> | null,
): SettingsCapabilities {
  if (!raw) return ALL_CAPABILITIES;
  return {
    signatures:     raw.signatures     ?? true,
    identities:     raw.identities     ?? true,
    serverPrefs:    raw.serverPrefs    ?? true,
    changePassword: raw.changePassword ?? true,
    twoFactor:      raw.twoFactor      ?? true,
  };
}

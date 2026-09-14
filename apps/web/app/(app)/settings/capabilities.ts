/**
 * Resolution policy for the `capabilities` object on `GET /settings`. The wire
 * shape itself lives with the rest of the response types in `@/lib/api`; this
 * module owns what an absent value means.
 *
 * Everything defaults to **true**. An absent object (a server that predates
 * the field, or a request that raced a deploy) and an absent individual flag
 * (a server that grew a new capability we do not know about) both mean
 * "render it" — so the gating can only ever hide a section a backend has
 * explicitly disclaimed, never hide one by accident.
 *
 * Note `twoFactor` gates nothing on the settings page: 2FA is login-time and
 * there is no enrolment UI here. It is carried so the flag set matches the
 * API's.
 */
import type { SettingsCapabilities } from '@/lib/api';

/** Re-exported so the settings page has one import for the type and the policy. */
export type { SettingsCapabilities };

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

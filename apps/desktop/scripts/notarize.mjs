/**
 * afterSign hook for electron-builder — notarizes the macOS app bundle.
 *
 * Only runs when ALL of these env vars are set:
 *   APPLE_ID          — your Apple ID email
 *   APPLE_APP_PASSWORD — app-specific password from appleid.apple.com
 *   APPLE_TEAM_ID     — 10-char Team ID from developer.apple.com/account
 *
 * If any var is missing the hook exits silently (no notarization).
 * This lets unsigned/unsigned-ad-hoc builds still complete without error.
 *
 * To set up notarization:
 *   1. Join Apple Developer Program (developer.apple.com)
 *   2. Create a "Developer ID Application" certificate in Xcode / Keychain
 *   3. Export it and set CSC_LINK (path or base64) + CSC_KEY_PASSWORD
 *   4. Generate an app-specific password at appleid.apple.com
 *   5. Set APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID and rebuild
 */

import { notarize } from '@electron/notarize';
import path from 'path';

export default async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID } = process.env;

  if (!APPLE_ID || !APPLE_APP_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      '\n[notarize] Skipping notarization — APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID not set.\n' +
      '           The app will show "damaged" on other Macs until notarized.\n' +
      '           See apps/desktop/scripts/notarize.mjs for setup instructions.\n',
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[notarize] Submitting ${appPath} to Apple Notary Service…`);

  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] Notarization complete.');
}

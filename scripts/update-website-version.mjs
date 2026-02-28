/**
 * Post-release hook: updates CURRENT_VERSION and RELEASE_DATE in the website repo,
 * then commits and pushes so the download page reflects the new version immediately.
 *
 * Called automatically by release-it after a successful release:
 *   "hooks": { "after:release": "node scripts/update-website-version.mjs ${version}" }
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/update-website-version.mjs <version>');
  process.exit(1);
}

// Path to the website repo's releases.ts
const websiteDir = resolve(__dirname, '../../1govmail-web/website');
const releasesFile = resolve(websiteDir, 'lib/releases.ts');

// Build a human-readable month+year string, e.g. "March 2026"
const releaseDate = new Date().toLocaleDateString('en-US', {
  month: 'long',
  year: 'numeric',
});

console.log(`\n📦 Updating website to v${version} (${releaseDate})…`);

// Read current file
let content = readFileSync(releasesFile, 'utf8');

// Replace CURRENT_VERSION
content = content.replace(
  /export const CURRENT_VERSION\s*=\s*["'][^"']*["']/,
  `export const CURRENT_VERSION = "${version}"`,
);

// Replace RELEASE_DATE
content = content.replace(
  /export const RELEASE_DATE\s*=\s*["'][^"']*["']/,
  `export const RELEASE_DATE = "${releaseDate}"`,
);

writeFileSync(releasesFile, content, 'utf8');
console.log(`✅ Updated lib/releases.ts`);

// Commit and push the website change
try {
  execSync(`git -C "${websiteDir}" add lib/releases.ts`, { stdio: 'inherit' });
  execSync(
    `git -C "${websiteDir}" commit -m "chore: bump version to v${version}"`,
    { stdio: 'inherit' },
  );
  execSync(`git -C "${websiteDir}" push`, { stdio: 'inherit' });
  console.log(`🚀 Website repo updated and pushed.`);
} catch (err) {
  console.error('⚠️  Failed to commit/push website changes:', err.message);
  console.error('   Please commit and push ~/Documents/development/1govmail-web/website manually.');
}

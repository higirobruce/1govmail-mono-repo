import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';

/**
 * Encrypts/decrypts EWS mailbox credentials (password, and for NTLM the
 * "DOMAIN\user|password" composite) at rest in the DB.
 *
 * AES-256-GCM. The 32-byte key is derived once per instance via
 * `scryptSync(rawKey, <fixed app salt>, 32)` and memoized — scrypt is
 * deliberately slow, so re-deriving it on every encrypt/decrypt call would be
 * both wasteful and a self-inflicted DoS surface.
 *
 * `rawKey` must come from `MAIL_CRED_KEY`. This NEVER falls back to
 * `JWT_SECRET` or any other secret — a separate secret means rotating one
 * does not silently weaken (or break) the other, and a leak of one does not
 * imply a leak of the other.
 *
 * Blob format: `base64(iv).base64(authTag).base64(ciphertext)` — self
 * describing, and safe to store as a single opaque string column. `.` cannot
 * appear inside base64 output, so it is an unambiguous separator.
 */
export class EwsCrypto {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12;
  private static readonly KEY_LENGTH = 32;
  // Fixed, app-specific scrypt salt. This is not a secret by itself — the
  // secrecy lives entirely in `rawKey` — it just domain-separates this KDF
  // usage from any other scrypt derivation elsewhere in the app.
  private static readonly SALT = '1gov-mail:ews-crypto:v1';
  private static readonly SEPARATOR = '.';

  private readonly key: Buffer;

  constructor(rawKey: string | undefined = process.env.MAIL_CRED_KEY) {
    if (!rawKey) {
      throw new Error(
        'EwsCrypto: no encryption key available. Set MAIL_CRED_KEY (do not reuse JWT_SECRET).',
      );
    }
    this.key = scryptSync(rawKey, EwsCrypto.SALT, EwsCrypto.KEY_LENGTH);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(EwsCrypto.IV_LENGTH);
    const cipher = createCipheriv(EwsCrypto.ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, ciphertext].map((b) => b.toString('base64')).join(EwsCrypto.SEPARATOR);
  }

  decrypt(blob: string): string {
    const parts = blob.split(EwsCrypto.SEPARATOR);
    if (parts.length !== 3) {
      throw new Error('EwsCrypto: malformed ciphertext blob.');
    }
    const [ivB64, tagB64, ciphertextB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    const decipher = createDecipheriv(EwsCrypto.ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }
}

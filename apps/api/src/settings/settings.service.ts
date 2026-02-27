import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';

export interface SignatureData {
  name: string;
  contentHtml: string;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
  ) {}

  private async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.authToken)
      throw new UnauthorizedException('Please log in again to connect to Zimbra.');
    return user;
  }

  // ── Fetch everything needed for the settings page in one call ─────────────

  async getSettings(userId: string) {
    const user = await this.getUser(userId);
    const [prefs, identities, signatures] = await Promise.all([
      this.zimbra.getPrefs(
        user.zimbraHost, user.authToken!, user.csrfToken ?? undefined,
      ),
      this.zimbra.getIdentities(
        user.zimbraHost, user.authToken!, user.csrfToken ?? undefined,
      ),
      this.zimbra.getSignatures(
        user.zimbraHost, user.authToken!, user.csrfToken ?? undefined,
      ),
    ]);

    // Convert Zimbra-relative image paths (e.g. Briefcase GIFs) to inline
    // base64 data URIs so they display correctly in the client without auth.
    const processedSignatures = await Promise.all(
      (signatures as Array<{ id: string; name: string; contentHtml: string; contentText: string }>)
        .map(async (sig) => ({
          ...sig,
          contentHtml: await this.processSignatureImages(sig.contentHtml, user),
        })),
    );

    return {
      email:       user.email,
      zimbraHost:  user.zimbraHost,
      displayName: user.displayName,
      prefs,
      identities,
      signatures: processedSignatures,
    };
  }

  /**
   * Replace `src="/home/..."` Zimbra Briefcase image paths with inline base64
   * data URIs so the client can display them without needing Zimbra auth tokens.
   */
  private async processSignatureImages(
    html: string,
    user: { zimbraHost: string; authToken: string | null },
  ): Promise<string> {
    if (!user.authToken) return html;
    const regex = /src="(\/home\/[^"]+)"/gi;
    const matches = [...html.matchAll(regex)];
    if (!matches.length) return html;

    let processed = html;
    await Promise.all(
      matches.map(async ([full, path]) => {
        try {
          const { data, contentType } = await this.zimbra.downloadZimbraPath(
            user.zimbraHost, user.authToken!, path,
          );
          const dataUri = `data:${contentType};base64,${data.toString('base64')}`;
          // Keep the original Zimbra path in data-zimbra-src so the editor can
          // round-trip it back when saving (avoids the 10 KB signature size limit).
          processed = processed.split(full).join(`src="${dataUri}" data-zimbra-src="${path}"`);
        } catch {
          // Leave original path — image will be missing but the rest renders
        }
      }),
    );
    return processed;
  }

  /**
   * Before saving a signature to Zimbra, strip the base64 data URIs we embedded
   * for display and restore the original Zimbra Briefcase paths from the
   * data-zimbra-src attributes we stored alongside them.
   *
   * Processes each <img> tag individually so attribute ordering doesn't matter.
   *
   * Cases:
   *   1. data-zimbra-src present  → Briefcase image; restore original path, strip base64 + attr
   *   2. src="data:..." only      → New upload; remove entire <img> tag (can't persist in Zimbra)
   *   3. Neither                  → External/http image; leave unchanged
   *
   * Returns the cleaned HTML and a flag indicating whether any new-upload images
   * were stripped so the caller can warn the user.
   */
  private restoreSignatureHtmlForZimbra(
    html: string,
  ): { html: string; imagesStripped: boolean } {
    let imagesStripped = false;

    const result = html.replace(/<img([^>]*)>/gi, (_imgTag, attrs: string) => {
      const zimbraSrcMatch = attrs.match(/data-zimbra-src="([^"]*)"/i);

      if (zimbraSrcMatch) {
        // Briefcase image — restore original path, strip base64 src + data-zimbra-src attr
        const restored = attrs
          .replace(/src="data:[^"]*"/, `src="${zimbraSrcMatch[1]}"`)
          .replace(/\s*data-zimbra-src="[^"]*"/, '');
        return `<img${restored}>`;
      }

      if (/src="data:[^"]*"/.test(attrs)) {
        // New upload with no Zimbra origin — remove the entire tag (can't persist in Zimbra)
        imagesStripped = true;
        return '';
      }

      // No base64 src at all (e.g. external http image) — leave unchanged
      return `<img${attrs}>`;
    });

    return { html: result, imagesStripped };
  }

  // ── Preferences ────────────────────────────────────────────────────────────

  async updatePrefs(userId: string, prefs: Record<string, string>) {
    const user = await this.getUser(userId);
    await this.zimbra.modifyPrefs(
      user.zimbraHost, user.authToken!, prefs, user.csrfToken ?? undefined,
    );
    return { success: true };
  }

  // ── Identity (display name, reply-to, default signature) ──────────────────

  async updateIdentity(
    userId: string,
    identityId: string,
    attrs: Record<string, string>,
  ) {
    const user = await this.getUser(userId);
    await this.zimbra.modifyIdentity(
      user.zimbraHost, user.authToken!, identityId, attrs, user.csrfToken ?? undefined,
    );
    // Keep the local DB display name in sync
    if (attrs.zimbraPrefFromDisplay) {
      await this.prisma.user.update({
        where: { id: userId },
        data:  { displayName: attrs.zimbraPrefFromDisplay },
      });
    }
    return { success: true };
  }

  // ── Signatures ─────────────────────────────────────────────────────────────

  async createSignature(userId: string, data: SignatureData) {
    const user = await this.getUser(userId);
    // Strip base64 data URIs / restore original Zimbra paths before saving —
    // Zimbra rejects zimbraPrefMailSignature values larger than 10 240 bytes.
    const { html: zimbraHtml, imagesStripped } = this.restoreSignatureHtmlForZimbra(data.contentHtml);
    const id = await this.zimbra.createSignature(
      user.zimbraHost, user.authToken!, data.name, zimbraHtml,
      user.csrfToken ?? undefined,
    );
    // Return the original (base64-embedded) HTML so the frontend can display
    // images immediately without waiting for a fresh getSettings fetch.
    return { id, name: data.name, contentHtml: data.contentHtml, contentText: '', imagesStripped };
  }

  async updateSignature(userId: string, signatureId: string, data: SignatureData) {
    const user = await this.getUser(userId);
    const { html: zimbraHtml, imagesStripped } = this.restoreSignatureHtmlForZimbra(data.contentHtml);
    await this.zimbra.modifySignature(
      user.zimbraHost, user.authToken!, signatureId, data.name, zimbraHtml,
      user.csrfToken ?? undefined,
    );
    return { id: signatureId, name: data.name, contentHtml: data.contentHtml, contentText: '', imagesStripped };
  }

  async deleteSignature(userId: string, signatureId: string) {
    const user = await this.getUser(userId);
    await this.zimbra.deleteSignature(
      user.zimbraHost, user.authToken!, signatureId, user.csrfToken ?? undefined,
    );
    return { success: true };
  }

  // ── Password ───────────────────────────────────────────────────────────────

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ) {
    if (!oldPassword || !newPassword)
      throw new BadRequestException('Both passwords are required');
    if (newPassword.length < 6)
      throw new BadRequestException('New password must be at least 6 characters');

    const user = await this.getUser(userId);
    await this.zimbra.changePassword(
      user.zimbraHost,
      user.authToken!,
      user.email,
      oldPassword,
      newPassword,
      user.csrfToken ?? undefined,
    );
    return { success: true };
  }
}

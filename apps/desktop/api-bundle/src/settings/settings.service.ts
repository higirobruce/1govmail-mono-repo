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

    return {
      email:       user.email,
      zimbraHost:  user.zimbraHost,
      displayName: user.displayName,
      prefs,
      identities,
      signatures,
    };
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
    const id = await this.zimbra.createSignature(
      user.zimbraHost, user.authToken!, data.name, data.contentHtml,
      user.csrfToken ?? undefined,
    );
    return { id, name: data.name, contentHtml: data.contentHtml, contentText: '' };
  }

  async updateSignature(userId: string, signatureId: string, data: SignatureData) {
    const user = await this.getUser(userId);
    await this.zimbra.modifySignature(
      user.zimbraHost, user.authToken!, signatureId, data.name, data.contentHtml,
      user.csrfToken ?? undefined,
    );
    return { id: signatureId, name: data.name, contentHtml: data.contentHtml, contentText: '' };
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

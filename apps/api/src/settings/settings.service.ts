import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailProviderResolver } from '../provider/mail-provider.resolver';
import { buildMailSession } from '../provider/mail-session';
import type { ProviderIdentity, ProviderSignature } from '../provider/provider-types';
import { inlineSignatureImages } from '../common/signature-images';
import { UpdateAiProfileDto } from './dto/ai-profile.dto';

export interface SignatureData {
  name: string;
  contentHtml: string;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: MailProviderResolver,
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
    const provider = this.resolver.forUser(user);
    const session = buildMailSession(user);
    const caps = provider.capabilities;

    // Capability-branch (spec §7): a provider that lacks serverPrefs/identities/
    // signatures (EWS: all false) throws CapabilityNotSupportedError from these
    // methods, so we must NOT call them — the settings page would 500. Return
    // those sections empty instead; the `capabilities` object below tells the
    // frontend which to hide. Zimbra (all true) still calls the provider for
    // every section, so its payload is unchanged.
    //
    // TODO(exchange-signatures): when a local EmailSignature table lands (spec
    // §7), an EWS user's signatures should be read from Postgres here instead of
    // returning an empty list.
    const [prefs, identities, signatures] = await Promise.all([
      caps.serverPrefs
        ? provider.getPrefs(session)
        : Promise.resolve<Record<string, string>>({}),
      caps.identities
        ? provider.getIdentities(session)
        : Promise.resolve<ProviderIdentity[]>([]),
      caps.signatures
        ? provider.getSignatures(session)
        : Promise.resolve<ProviderSignature[]>([]),
    ]);

    // Convert Zimbra-relative image paths (e.g. Briefcase GIFs) to inline
    // base64 data URIs so they display correctly in the client without auth.
    // The cast Tasks 1-8 needed here is gone: getSignatures is typed
    // ProviderSignature[] now, not unknown[].
    const processedSignatures = await Promise.all(
      signatures.map(async (sig) => ({
        ...sig,
        contentHtml: await this.processSignatureImages(sig.contentHtml, user),
      })),
    );

    return {
      email:       user.email,
      zimbraHost:  user.zimbraHost,
      displayName: user.displayName,
      provider:    provider.name,
      prefs,
      identities,
      signatures: processedSignatures,
      /**
       * Which of the provider-backed settings sections this backend can
       * actually serve. The one sanctioned addition to the Phase 1 REST
       * surface: the client gates its Signatures / Identity / preferences /
       * password sections on these flags, defaulting every absent flag to
       * true so a client that predates this field (or a mid-deploy mix) keeps
       * rendering everything exactly as before.
       */
      capabilities: provider.capabilities,
    };
  }

  /**
   * Replace `src="/home/..."` Zimbra Briefcase image paths with inline base64
   * data URIs so the client can display them without needing Zimbra auth tokens.
   */
  private async processSignatureImages(
    html: string,
    user: { zimbraHost: string; authToken: string | null; provider: string },
  ): Promise<string> {
    // Zimbra-only enrichment (downloadZimbraPath is off the MailProvider
    // interface): any other backend keeps the signature HTML as the provider
    // returned it rather than failing the settings load.
    if (user.provider !== 'zimbra') return html;
    return inlineSignatureImages(this.resolver.zimbra(), user, html);
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
    await this.resolver.forUser(user).modifyPrefs(buildMailSession(user), prefs);
    return { success: true };
  }

  // ── Identity (display name, reply-to, default signature) ──────────────────

  async updateIdentity(
    userId: string,
    identityId: string,
    attrs: Record<string, string>,
  ) {
    const user = await this.getUser(userId);
    await this.resolver.forUser(user).modifyIdentity(buildMailSession(user), identityId, attrs);
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
    const id = await this.resolver.forUser(user).createSignature(
      buildMailSession(user), data.name, zimbraHtml,
    );
    // Return the original (base64-embedded) HTML so the frontend can display
    // images immediately without waiting for a fresh getSettings fetch.
    return { id, name: data.name, contentHtml: data.contentHtml, contentText: '', imagesStripped };
  }

  async updateSignature(userId: string, signatureId: string, data: SignatureData) {
    const user = await this.getUser(userId);
    const { html: zimbraHtml, imagesStripped } = this.restoreSignatureHtmlForZimbra(data.contentHtml);
    await this.resolver.forUser(user).modifySignature(
      buildMailSession(user), signatureId, data.name, zimbraHtml,
    );
    return { id: signatureId, name: data.name, contentHtml: data.contentHtml, contentText: '', imagesStripped };
  }

  async deleteSignature(userId: string, signatureId: string) {
    const user = await this.getUser(userId);
    await this.resolver.forUser(user).deleteSignature(buildMailSession(user), signatureId);
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
    await this.resolver.forUser(user).changePassword(
      buildMailSession(user), oldPassword, newPassword,
    );
    return { success: true };
  }

  // ── AI personalization profile (DB-only; never touches Zimbra) ────────────

  private static readonly AI_PROFILE_SELECT = {
    instructions: true, jobTitle: true, institution: true, department: true, language: true,
  } as const;

  async getAiProfile(userId: string) {
    const row = await this.prisma.userAiProfile.findUnique({
      where: { userId }, select: SettingsService.AI_PROFILE_SELECT,
    });
    return row ?? { instructions: null, jobTitle: null, institution: null, department: null, language: null };
  }

  async updateAiProfile(userId: string, dto: UpdateAiProfileDto) {
    const norm = (v?: string | null) => (v == null ? undefined : v.trim() || null);
    const data = {
      instructions: norm(dto.instructions), jobTitle: norm(dto.jobTitle),
      institution: norm(dto.institution), department: norm(dto.department), language: norm(dto.language),
    };
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    await this.prisma.userAiProfile.upsert({
      where: { userId }, update: clean, create: { userId, ...clean },
    });
    return this.getAiProfile(userId);
  }

  // ── AI profile suggestions (seeded from Zimbra; best-effort, never 5xxs) ──

  /**
   * Suggestions to seed the AI-profile form from the user's existing Zimbra
   * GAL entry. Needs Zimbra (via getUser, which 401s if there's no
   * authToken), but any Zimbra-leg failure past that point degrades to
   * nulls rather than surfacing a 5xx.
   *
   * `galSelfLookup` is a sanctioned Zimbra-only extra (off the MailProvider
   * interface), so it is reached through `resolver.zimbra()` behind an
   * explicit provider check: a non-Zimbra account gets the same all-null
   * shape the failure path returns, never an error.
   */
  async getAiProfileSuggestions(userId: string) {
    const user = await this.getUser(userId);
    const NO_SUGGESTIONS = { title: null, department: null, company: null };
    const galResult = user.provider === 'zimbra'
      ? await this.resolver.zimbra()
          .galSelfLookup(buildMailSession(user), user.email)
          .catch(() => NO_SUGGESTIONS)
      : NO_SUGGESTIONS;

    return {
      jobTitle:    galResult.title,
      institution: galResult.company,
      department:  galResult.department,
    };
  }
}

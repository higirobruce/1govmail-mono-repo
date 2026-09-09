import { Injectable, UnauthorizedException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailProviderResolver } from '../provider/mail-provider.resolver';
import { ProviderAuthResult } from '../provider/provider-types';
import { AuditService } from '../common/audit/audit.service';
import { InstitutionRegistry } from './institution.registry';
import { LoginDto } from './dto/login.dto';

export interface AuthContext {
  ip?: string | null;
  userAgent?: string | null;
}

interface ResolvedInstitution {
  provider: string;
  institutionId: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: MailProviderResolver,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly institutionRegistry: InstitutionRegistry,
  ) {}

  async login(dto: LoginDto, ctx: AuthContext = {}) {
    const { email, password } = dto;

    const inst = dto.institution
      ? await this.institutionRegistry.resolve(dto.institution)
      : dto.zimbraHost
        ? await this.institutionRegistry.resolveByHost(dto.zimbraHost)
        : null;
    if (!inst) {
      throw new BadRequestException('Unknown institution. Pick your institution from the list.');
    }
    if (dto.zimbraHost && !dto.institution) {
      this.logger.warn(`Legacy zimbraHost login for ${inst.id} — client should send institution`);
    }
    // The resolver IS the gate: Task 3's temporary `inst.provider !== 'zimbra'
    // throw is gone, so an institution on a backend this build does not speak
    // yet fails here with the resolver's BadRequestException — and the moment
    // Phase 2/3 registers that provider, login starts working with no change
    // to this method.
    const provider = this.resolver.forUser({ provider: inst.provider });
    const zimbraHost = inst.host;
    const resolvedInstitution: ResolvedInstitution = { provider: inst.provider, institutionId: inst.id };

    let zimbraResult: ProviderAuthResult;
    try {
      zimbraResult = await provider.authenticate(zimbraHost, email, password);
    } catch (err) {
      await this.audit.record('LOGIN_FAILURE', {
        email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        success: false,
        metadata: { zimbraHost, reason: 'zimbra_auth_failed' },
      });
      throw err;
    }

    // ── Two-Factor Authentication required ────────────────────────────────────
    // The token Zimbra returned is only a pre-auth token — not usable for
    // mailbox SOAP calls.  Issue a short-lived (5 min) JWT encoding the
    // pre-auth state so the frontend can complete the TOTP challenge.
    if (zimbraResult.twoFactorRequired) {
      this.logger.log(`login(${email}): 2FA required — issuing two-factor challenge token`);
      const twoFactorToken = this.jwt.sign(
        {
          sub: 'zimbra:two-factor',
          email,
          zimbraHost,
          preAuthToken: zimbraResult.authToken,
          provider: resolvedInstitution.provider,
          institutionId: resolvedInstitution.institutionId,
        },
        { expiresIn: '5m' },
      );
      await this.audit.record('LOGIN_2FA_REQUIRED', {
        email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { zimbraHost },
      });
      return { requiresTwoFactor: true as const, twoFactorToken };
    }

    return this.createSession(email, zimbraHost, zimbraResult, ctx, resolvedInstitution);
  }

  async loginTwoFactor(twoFactorToken: string, code: string, ctx: AuthContext = {}) {
    let payload: {
      sub: string;
      email: string;
      zimbraHost: string;
      preAuthToken: string;
      provider?: string;
      institutionId?: string;
    };
    try {
      payload = this.jwt.verify(twoFactorToken) as typeof payload;
    } catch {
      throw new UnauthorizedException('Two-factor session expired. Please sign in again.');
    }
    if (payload.sub !== 'zimbra:two-factor') {
      throw new UnauthorizedException('Invalid two-factor session token.');
    }

    const { email, zimbraHost, preAuthToken, provider, institutionId } = payload;

    // Challenge tokens minted before the provider column existed carry no
    // `provider`; they can only have come from the Zimbra login leg, so
    // default to it rather than 400-ing a 2FA prompt that is already open.
    const mailProvider = this.resolver.forUser({ provider: provider ?? 'zimbra' });

    let zimbraResult: ProviderAuthResult;
    try {
      zimbraResult = await mailProvider.verifyTwoFactor(
        zimbraHost,
        email,
        preAuthToken,
        code,
      );
    } catch (err) {
      await this.audit.record('LOGIN_2FA_FAILURE', {
        email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        success: false,
        metadata: { zimbraHost },
      });
      throw err;
    }

    return this.createSession(
      email,
      zimbraHost,
      zimbraResult,
      ctx,
      provider && institutionId ? { provider, institutionId } : undefined,
    );
  }

  /** Persist the Zimbra session and return a signed JWT for the frontend. */
  private async createSession(
    email: string,
    originalHost: string,
    zimbraResult: ProviderAuthResult,
    ctx: AuthContext,
    institution?: ResolvedInstitution,
  ) {
    const effectiveHost = zimbraResult.redirectHost ?? originalHost;
    // Guard against a misconfigured/omitted Zimbra `lifetime`: if it were
    // falsy, NaN, or unreasonably small, tokenExpiry would land at or before
    // "now" — the very next request would fail JwtStrategy's expiresAt check,
    // bounce back to login, which would succeed and immediately fail again:
    // an infinite login loop with no way out. Floor it to a sane minimum and
    // fall back to a conservative default when the value isn't usable.
    const MIN_SESSION_LIFETIME_MS = 60_000; // 60s
    const DEFAULT_SESSION_LIFETIME_MS = 60 * 60 * 1000; // 1h
    const lifetimeMs =
      Number.isFinite(zimbraResult.lifetime) && zimbraResult.lifetime >= MIN_SESSION_LIFETIME_MS
        ? zimbraResult.lifetime
        : DEFAULT_SESSION_LIFETIME_MS;
    const tokenExpiry = new Date(Date.now() + lifetimeMs);

    const user = await this.prisma.user.upsert({
      where: { email },
      update: {
        authToken: zimbraResult.authToken,
        csrfToken: zimbraResult.csrfToken ?? null,
        tokenExpiry,
        displayName: zimbraResult.displayName ?? undefined,
        zimbraHost: effectiveHost,
        ...(institution ? { provider: institution.provider, institutionId: institution.institutionId } : {}),
      },
      create: {
        email,
        zimbraHost: effectiveHost,
        authToken: zimbraResult.authToken,
        csrfToken: zimbraResult.csrfToken ?? null,
        tokenExpiry,
        displayName: zimbraResult.displayName,
        ...(institution ? { provider: institution.provider, institutionId: institution.institutionId } : {}),
      },
    });

    const accessToken = this.jwt.sign({ sub: user.id, email: user.email });

    try {
      await this.prisma.session.create({
        data: {
          userId: user.id,
          token: accessToken,
          expiresAt: tokenExpiry,
          userAgent: ctx.userAgent ?? null,
          ipAddress: ctx.ip ?? null,
        },
      });
    } catch (err) {
      // Two logins for the same user within the same JWT `iat` second (e.g. a
      // double-submitted form, or two tabs racing) can sign byte-identical
      // tokens, colliding on Session.token's unique constraint. The session
      // for this token already exists — treat it as already recorded rather
      // than failing an otherwise-successful login. Any other failure (e.g. a
      // bad userId foreign key) should still propagate.
      const isDuplicateToken =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (!isDuplicateToken) {
        throw err;
      }
    }

    await this.audit.record('LOGIN_SUCCESS', {
      userId: user.id,
      email: user.email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { zimbraHost: effectiveHost },
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        zimbraHost: user.zimbraHost,
      },
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      zimbraHost: user.zimbraHost,
    };
  }

  async logout(userId: string, ctx: AuthContext = {}) {
    await this.prisma.session.deleteMany({ where: { userId } });
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { authToken: null, tokenExpiry: null },
      select: { email: true },
    });
    await this.audit.record('LOGOUT', {
      userId,
      email: user.email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  async getSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      // JwtStrategy already rejects expired sessions, so a row surviving past
      // its expiresAt is unusable dead weight — exclude it here too, or the
      // Settings panel (and revokeOtherSessions' count) would treat it as live.
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      isCurrent: s.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({ where: { userId, id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    await this.prisma.session.delete({ where: { id: sessionId } });
    return { success: true };
  }

  async revokeOtherSessions(userId: string, currentSessionId: string) {
    const { count } = await this.prisma.session.deleteMany({
      where: { userId, id: { not: currentSessionId } },
    });
    return { success: true, revoked: count };
  }
}

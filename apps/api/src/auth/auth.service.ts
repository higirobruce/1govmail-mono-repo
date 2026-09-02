import { Injectable, UnauthorizedException, NotFoundException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { AuditService } from '../common/audit/audit.service';

export interface AuthContext {
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, zimbraHost: string, ctx: AuthContext = {}) {
    let zimbraResult: Awaited<ReturnType<ZimbraService['authenticate']>>;
    try {
      zimbraResult = await this.zimbra.authenticate(zimbraHost, email, password);
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

    return this.createSession(email, zimbraHost, zimbraResult, ctx);
  }

  async loginTwoFactor(twoFactorToken: string, code: string, ctx: AuthContext = {}) {
    let payload: { sub: string; email: string; zimbraHost: string; preAuthToken: string };
    try {
      payload = this.jwt.verify(twoFactorToken) as typeof payload;
    } catch {
      throw new UnauthorizedException('Two-factor session expired. Please sign in again.');
    }
    if (payload.sub !== 'zimbra:two-factor') {
      throw new UnauthorizedException('Invalid two-factor session token.');
    }

    const { email, zimbraHost, preAuthToken } = payload;

    let zimbraResult: Awaited<ReturnType<ZimbraService['verifyTwoFactor']>>;
    try {
      zimbraResult = await this.zimbra.verifyTwoFactor(
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

    return this.createSession(email, zimbraHost, zimbraResult, ctx);
  }

  /** Persist the Zimbra session and return a signed JWT for the frontend. */
  private async createSession(
    email: string,
    originalHost: string,
    zimbraResult: import('../zimbra/zimbra.service').ZimbraAuthResult,
    ctx: AuthContext,
  ) {
    const effectiveHost = zimbraResult.refer ?? originalHost;
    const tokenExpiry = new Date(Date.now() + zimbraResult.lifetime);

    const user = await this.prisma.user.upsert({
      where: { email },
      update: {
        authToken: zimbraResult.authToken,
        csrfToken: zimbraResult.csrfToken ?? null,
        tokenExpiry,
        displayName: zimbraResult.displayName ?? undefined,
        zimbraHost: effectiveHost,
      },
      create: {
        email,
        zimbraHost: effectiveHost,
        authToken: zimbraResult.authToken,
        csrfToken: zimbraResult.csrfToken ?? null,
        tokenExpiry,
        displayName: zimbraResult.displayName,
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
      where: { userId },
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

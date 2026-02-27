import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string, zimbraHost: string) {
    const zimbraResult = await this.zimbra.authenticate(zimbraHost, email, password);

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
      return { requiresTwoFactor: true as const, twoFactorToken };
    }

    // ── Normal login (no 2FA) ─────────────────────────────────────────────────
    return this.createSession(email, zimbraHost, zimbraResult);
  }

  async loginTwoFactor(twoFactorToken: string, code: string) {
    // Decode and validate the short-lived 2FA challenge token issued by login()
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

    // Send pre-auth token + TOTP code to Zimbra — returns the real session token
    const zimbraResult = await this.zimbra.verifyTwoFactor(
      zimbraHost,
      email,
      preAuthToken,
      code,
    );

    return this.createSession(email, zimbraHost, zimbraResult);
  }

  /** Persist the Zimbra session and return a signed JWT for the frontend. */
  private async createSession(
    email: string,
    originalHost: string,
    zimbraResult: import('../zimbra/zimbra.service').ZimbraAuthResult,
  ) {
    // Zimbra clusters may refer us to a different backend node.
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

  async logout(userId: string) {
    await this.prisma.session.deleteMany({ where: { userId } });
    await this.prisma.user.update({
      where: { id: userId },
      data: { authToken: null, tokenExpiry: null },
    });
  }
}

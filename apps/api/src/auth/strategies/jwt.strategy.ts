import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // This option alone is what makes passport-jwt invoke validate(req, payload)
      // below instead of validate(payload) — without it, `req` would be undefined here.
      passReqToCallback: true,
      // ConfigService returns string|undefined; passport-jwt requires string|Buffer
      secretOrKey: config.get<string>('JWT_SECRET') ?? '',
    });
  }

  // Pre-auth two-factor challenge tokens are verified manually in
  // AuthService.loginTwoFactor and never reach this guard-backed strategy,
  // so `payload.sub` here is always a real user id, never 'zimbra:two-factor'.
  async validate(req: Request, payload: { sub: string; email: string }) {
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    if (!token) throw new UnauthorizedException();

    const session = await this.prisma.session.findUnique({ where: { token } });
    if (!session || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Session expired or signed out. Please log in again.');
    }

    // This write is bookkeeping, not part of the auth decision (auth already
    // succeeded above), so: (1) only touch the row when the existing value is
    // stale, since this runs on every authenticated request — the hottest
    // path in the app; (2) don't block the request on it, and swallow any
    // error — a concurrent revocation between the read above and this write
    // would otherwise throw an unhandled Prisma error for a request that
    // should still succeed.
    if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
      void this.prisma.session
        .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {});
    }

    return { sub: payload.sub, email: payload.email, sessionId: session.id };
  }
}

import { Controller, Post, Get, Body, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { LoginDto } from './dto/login.dto';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // 5 login attempts per minute per IP — brute-force gate.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() req: AuthenticatedRequest) {
    return this.authService.login(dto.email, dto.password, dto.zimbraHost, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('two-factor')
  @HttpCode(HttpStatus.OK)
  twoFactor(
    @Body() body: { twoFactorToken: string; code: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.authService.loginTwoFactor(body.twoFactorToken, body.code, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: AuthenticatedRequest) {
    return this.authService.getProfile(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Req() req: AuthenticatedRequest) {
    return this.authService.logout(req.user.sub, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}

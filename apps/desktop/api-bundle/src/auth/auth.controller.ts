import { Controller, Post, Get, Body, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { LoginDto } from './dto/login.dto';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password, dto.zimbraHost);
  }

  @Post('two-factor')
  @HttpCode(HttpStatus.OK)
  twoFactor(@Body() body: { twoFactorToken: string; code: string }) {
    return this.authService.loginTwoFactor(body.twoFactorToken, body.code);
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
    return this.authService.logout(req.user.sub);
  }
}

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SettingsService } from './settings.service';
import type { SignatureData } from './settings.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@UseGuards(JwtAuthGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  /**
   * GET /settings
   * Returns all settings data in one call: prefs, identities, signatures,
   * plus the basic user profile fields.
   */
  @Get()
  getSettings(@Req() req: AuthenticatedRequest) {
    return this.settingsService.getSettings(req.user.sub);
  }

  /**
   * PATCH /settings/prefs
   * Update one or more Zimbra preferences.
   * Body: { [zimbraPrefKey]: value, ... }
   */
  @Patch('prefs')
  @HttpCode(HttpStatus.OK)
  updatePrefs(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, string>,
  ) {
    return this.settingsService.updatePrefs(req.user.sub, body);
  }

  /**
   * PATCH /settings/identity/:id
   * Update an identity (display name, reply-to, default signature, etc.)
   * Body: { [zimbraAttrKey]: value, ... }
   */
  @Patch('identity/:id')
  @HttpCode(HttpStatus.OK)
  updateIdentity(
    @Req() req: AuthenticatedRequest,
    @Param('id') identityId: string,
    @Body() body: Record<string, string>,
  ) {
    return this.settingsService.updateIdentity(req.user.sub, identityId, body);
  }

  /**
   * POST /settings/signatures
   * Create a new email signature.
   * Body: { name: string; contentHtml: string }
   */
  @Post('signatures')
  @HttpCode(HttpStatus.OK)
  createSignature(
    @Req() req: AuthenticatedRequest,
    @Body() body: SignatureData,
  ) {
    return this.settingsService.createSignature(req.user.sub, body);
  }

  /**
   * PATCH /settings/signatures/:id
   * Update an existing signature.
   * Body: { name: string; contentHtml: string }
   */
  @Patch('signatures/:id')
  @HttpCode(HttpStatus.OK)
  updateSignature(
    @Req() req: AuthenticatedRequest,
    @Param('id') signatureId: string,
    @Body() body: SignatureData,
  ) {
    return this.settingsService.updateSignature(req.user.sub, signatureId, body);
  }

  /**
   * DELETE /settings/signatures/:id
   * Delete an email signature.
   */
  @Delete('signatures/:id')
  @HttpCode(HttpStatus.OK)
  deleteSignature(
    @Req() req: AuthenticatedRequest,
    @Param('id') signatureId: string,
  ) {
    return this.settingsService.deleteSignature(req.user.sub, signatureId);
  }

  /**
   * POST /settings/password
   * Change the user's Zimbra password.
   * Body: { oldPassword: string; newPassword: string }
   */
  @Post('password')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @Req() req: AuthenticatedRequest,
    @Body() body: { oldPassword: string; newPassword: string },
  ) {
    return this.settingsService.changePassword(
      req.user.sub,
      body.oldPassword,
      body.newPassword,
    );
  }
}

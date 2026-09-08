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
import { UpdateAiProfileDto } from './dto/ai-profile.dto';
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

  /**
   * GET /settings/ai-profile
   * Returns the account-level AI personalization profile (DB-only, no Zimbra call).
   */
  @Get('ai-profile')
  getAiProfile(@Req() req: AuthenticatedRequest) {
    return this.settingsService.getAiProfile(req.user.sub);
  }

  /**
   * PATCH /settings/ai-profile
   * Upserts the account-level AI personalization profile. Empty string fields
   * clear the value (stored as null).
   */
  @Patch('ai-profile')
  @HttpCode(HttpStatus.OK)
  updateAiProfile(
    @Req() req: AuthenticatedRequest,
    @Body() body: UpdateAiProfileDto,
  ) {
    return this.settingsService.updateAiProfile(req.user.sub, body);
  }

  /**
   * GET /settings/ai-profile/suggestions
   * Best-effort suggestions to seed the AI-profile form, drawn from the
   * user's Zimbra identity (display name) and GAL entry (title/org/dept).
   * Requires Zimbra (401s without a stored authToken), but any Zimbra-leg
   * failure past that point degrades to nulls rather than a 5xx.
   */
  @Get('ai-profile/suggestions')
  getAiProfileSuggestions(@Req() req: AuthenticatedRequest) {
    return this.settingsService.getAiProfileSuggestions(req.user.sub);
  }
}

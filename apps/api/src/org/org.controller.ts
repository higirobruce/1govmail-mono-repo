import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { OrgService } from './org.service';
import { DIGEST_WINDOWS, type DigestWindow, type OrgDigest } from './org.types';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@UseGuards(JwtAuthGuard)
@Controller('org')
export class OrgController {
  constructor(private readonly orgService: OrgService) {}

  /**
   * GET /org/digest?window=day|week|month
   * The institution comes from the JWT subject, never from a parameter.
   */
  @Get('digest')
  digest(
    @Req() req: AuthenticatedRequest,
    @Query('window') window?: string,
  ): Promise<OrgDigest> {
    const w: DigestWindow = DIGEST_WINDOWS.includes(window as DigestWindow)
      ? (window as DigestWindow)
      : 'week';
    return this.orgService.getDigest(req.user.sub, w);
  }
}

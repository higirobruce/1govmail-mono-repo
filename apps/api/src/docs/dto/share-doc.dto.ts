import { IsEnum, IsOptional } from 'class-validator';
import { SharePermission } from '@prisma/client';

export class ShareDocDto {
  @IsOptional()
  @IsEnum(SharePermission)
  sharePermission?: SharePermission;
}

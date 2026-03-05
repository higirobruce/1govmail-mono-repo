import { IsEnum } from 'class-validator';
import { InviteRole } from '@prisma/client';

export class UpdateInviteDto {
  @IsEnum(InviteRole)
  role: InviteRole;
}

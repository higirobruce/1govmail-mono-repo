import { IsEmail, IsEnum, IsOptional } from 'class-validator';
import { InviteRole } from '@prisma/client';

export class CreateInviteDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsEnum(InviteRole)
  role?: InviteRole;
}

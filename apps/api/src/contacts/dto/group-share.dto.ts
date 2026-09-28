import { IsEmail, IsIn, IsOptional } from 'class-validator';

export class AddGroupShareDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  email!: string;

  @IsOptional()
  @IsIn(['VIEWER', 'EDITOR'])
  role?: 'VIEWER' | 'EDITOR';
}

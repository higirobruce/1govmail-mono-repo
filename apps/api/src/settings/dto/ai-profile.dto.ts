import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAiProfileDto {
  @IsOptional() @IsString() @MaxLength(500)
  instructions?: string;

  @IsOptional() @IsString() @MaxLength(80)
  jobTitle?: string;

  @IsOptional() @IsString() @MaxLength(80)
  institution?: string;

  @IsOptional() @IsString() @MaxLength(80)
  department?: string;

  @IsOptional() @IsIn(['en', 'fr', 'rw', ''])
  language?: string;
}

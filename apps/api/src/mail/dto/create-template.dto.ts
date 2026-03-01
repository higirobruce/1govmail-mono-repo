import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  body!: string;
}

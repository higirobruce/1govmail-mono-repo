import { IsInt, IsOptional, IsString } from 'class-validator';

export class UpdateDocDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  emoji?: string;

  @IsOptional()
  @IsInt()
  position?: number;
}

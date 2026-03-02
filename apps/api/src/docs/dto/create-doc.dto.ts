import { IsOptional, IsString } from 'class-validator';

export class CreateDocDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  emoji?: string;
}

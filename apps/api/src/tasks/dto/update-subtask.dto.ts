import { IsString, IsBoolean, IsOptional } from 'class-validator';

export class UpdateSubtaskDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}

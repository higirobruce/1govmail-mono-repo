import { IsArray, IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateRuleDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsArray()
  conditions!: Array<{ field: string; op: string; value: string }>;

  @IsArray()
  actions!: Array<{ type: string; folderId?: string }>;
}

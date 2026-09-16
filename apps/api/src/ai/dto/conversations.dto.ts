import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString,
  MaxLength, MinLength, ValidateNested,
} from 'class-validator';

export class TurnDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MinLength(1)
  content!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  sources?: unknown[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  steps?: unknown[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  proposals?: unknown[];
}

export class CreateConversationDto {
  @IsIn(['app', 'thread', 'doc'])
  scopeKind!: 'app' | 'thread' | 'doc';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  scopeId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  scopeLabel?: string | null;

  @IsString()
  @MaxLength(120)
  model!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  turnId?: string | null;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => TurnDto)
  turns!: TurnDto[];
}

export class AppendTurnsDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  turnId?: string | null;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => TurnDto)
  turns!: TurnDto[];
}

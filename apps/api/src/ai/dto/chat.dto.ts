import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ChatMessageDto {
  @IsIn(['system', 'user', 'assistant'])
  role!: 'system' | 'user' | 'assistant';

  @IsString()
  content!: string;
}

export class ResponseFormatDto {
  @IsIn(['json_object'])
  type!: 'json_object';
}

export class ChatRequestDto {
  @IsString()
  model!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages!: ChatMessageDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4096)
  max_tokens?: number;

  @IsOptional()
  @IsBoolean()
  stream?: boolean;

  /** OpenAI-style JSON mode — forwarded to the backend verbatim. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ResponseFormatDto)
  response_format?: ResponseFormatDto;
}

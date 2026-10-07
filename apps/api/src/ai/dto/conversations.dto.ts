import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString,
  MaxLength, MinLength, ValidateNested,
} from 'class-validator';

/**
 * Bounds here are ABUSE bounds, not shaping: the service truncates `content`
 * and `scopeLabel` to their stored sizes, so a genuinely long answer or
 * subject still saves. Rejecting is reserved for values no real client
 * produces, because the panel's persist swallows a 4xx by design — a reject
 * is a silent data loss, not an error the user sees.
 */
export class TurnDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MinLength(1)
  // Only the 50 MB express body limit bounded a row before this: one
  // authenticated user could persist arbitrarily large rows, kept 90 days,
  // on the box already at 78% disk. 100k is ~25k tokens — orders of
  // magnitude past any real answer, which the service caps at 32k anyway.
  @MaxLength(100_000)
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

  // A thread scopeId is the seed message id, which on Exchange is the raw
  // EWS ItemId — a base64 store id routinely 140-200+ characters. At 200
  // this 400'd, and the panel swallows that: thread-scoped history would
  // silently never save on the Exchange VM while looking perfect on Zimbra.
  // No other message-id path in this API caps at all (snooze-message.dto,
  // agent.dto, Commitment.messageId); this is a sanity bound, not a shape.
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  scopeId?: string | null;

  // Truncated to 300 by the service rather than rejected here — a subject
  // over 300 chars must cost the label, not the whole write.
  @IsOptional()
  @IsString()
  @MaxLength(4000)
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

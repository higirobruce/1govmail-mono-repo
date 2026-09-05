import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString, MaxLength, ValidateNested } from 'class-validator';

export class InboxChatTurnDto {
  /** Deliberately NO 'system' — the server owns the system prompt entirely. */
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(4000)
  content!: string;
}

export class InboxChatRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12) // ≤6 exchanges — the panel truncates client-side too
  @ValidateNested({ each: true })
  @Type(() => InboxChatTurnDto)
  messages!: InboxChatTurnDto[];
}

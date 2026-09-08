import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

export class AskTurnDto {
  /** Deliberately NO 'system' — the server owns the system prompt entirely. */
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(4000)
  content!: string;
}

/**
 * Narrows retrieval (RetrievalService.retrieve's `AskScope`). `docId` is
 * access-checked by AskService via DocsService.verifyReadAccess BEFORE
 * retrieval runs — see ask.service.ts.
 */
export class AskScopeDto {
  @IsOptional()
  @IsArray()
  @IsIn(['mail', 'doc', 'event'], { each: true })
  types?: ('mail' | 'doc' | 'event')[];

  @IsOptional()
  @IsString()
  @IsNotEmpty() // an empty docId would silently widen a "this document" ask back to the whole corpus
  docId?: string;
}

export class AskRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12) // ≤6 exchanges — the panel truncates client-side too
  @ValidateNested({ each: true })
  @Type(() => AskTurnDto)
  messages!: AskTurnDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AskScopeDto)
  scope?: AskScopeDto;
}

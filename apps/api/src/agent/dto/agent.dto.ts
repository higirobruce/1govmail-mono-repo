import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional,
  IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { AskTurnDto } from '../../chat/dto/ask.dto';

/**
 * A mail thread pinned into an Ask 1Gov conversation. `text` is untrusted mail
 * content — the service fences it before it reaches the model. MaxLength is
 * headroom over the client's 6000-char budget, not a second budget: an
 * oversized body is a client bug and should 400 rather than truncate silently.
 */
export class AgentPinnedDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  label!: string;

  /** @IsNotEmpty for the same reason AskScopeDto.docId has it: an empty pin
   *  would silently become an unpinned ask that still claims a thread in the UI. */
  @IsString() @IsNotEmpty() @MaxLength(8000)
  text!: string;

  /** Ids the text was gathered from — the whole thread. Used for
   *  injection-card lookup in both modes, and to bound id-addressed reads
   *  under a lock. NOT a count of what reached the model: see includedCount. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true })
  messageIds?: string[];

  /** How many of those messages survived the client's char budget and are
   *  actually inside `text`. May be lower than messageIds.length. */
  @IsOptional() @IsInt() @Min(0) @Max(50)
  includedCount?: number;

  @IsOptional() @IsIn(['thread'])
  toolScope?: 'thread';
}

export class AgentRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AskTurnDto)
  messages!: AskTurnDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentPinnedDto)
  pinned?: AgentPinnedDto;
}

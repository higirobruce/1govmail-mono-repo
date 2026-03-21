import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReactCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(16) // covers multi-codepoint emoji sequences
  emoji: string;
}

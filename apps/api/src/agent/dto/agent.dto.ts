import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { AskTurnDto } from '../../chat/dto/ask.dto';

export class AgentRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AskTurnDto)
  messages!: AskTurnDto[];
}

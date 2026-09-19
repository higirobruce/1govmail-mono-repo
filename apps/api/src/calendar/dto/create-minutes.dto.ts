import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateMinutesDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  /** TipTap document JSON, composed by the client from the Meeting Minutes
   *  template. The API stores it verbatim and never parses it. */
  @IsString()
  @MinLength(2)
  content!: string;
}

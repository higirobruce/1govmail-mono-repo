import { IsString } from 'class-validator';

export class CreateSubtaskDto {
  @IsString()
  title: string;
}

import { IsArray, IsDateString, IsOptional, IsString } from 'class-validator';

export class ScheduleMessageDto {
  @IsDateString()
  sendAt!: string;

  @IsArray()
  @IsString({ each: true })
  to!: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  cc?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  bcc?: string[];

  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  @IsOptional()
  body?: string;
}

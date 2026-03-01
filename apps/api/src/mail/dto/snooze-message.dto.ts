import { IsString, IsDateString } from 'class-validator';

export class SnoozeMessageDto {
  @IsString()
  messageId!: string;

  @IsDateString()
  snoozedUntil!: string;

  @IsString()
  originalFolderId!: string;
}

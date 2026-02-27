import { IsArray, IsOptional, IsString } from 'class-validator';

export class SaveDraftDto {
  @IsOptional()
  @IsArray()
  to?: string[];

  @IsOptional()
  @IsArray()
  cc?: string[];

  @IsOptional()
  @IsArray()
  bcc?: string[];

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  body?: string;

  /** Zimbra message ID of the draft to update; omit to create a new draft */
  @IsOptional()
  @IsString()
  draftId?: string;
}

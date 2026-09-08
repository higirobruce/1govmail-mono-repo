import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

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

  /**
   * When 'markdown', the server converts the body to HTML and appends the
   * user's default signature (agent-authored drafts). Omit for compose saves,
   * whose body is already final HTML with the signature in place.
   */
  @IsOptional()
  @IsIn(['markdown'])
  bodyFormat?: 'markdown';

  /** Zimbra message ID of the draft to update; omit to create a new draft */
  @IsOptional()
  @IsString()
  draftId?: string;
}

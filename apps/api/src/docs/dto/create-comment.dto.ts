import { IsOptional, IsString } from 'class-validator';

export class CreateCommentDto {
  @IsString()
  anchorId: string; // UUID matching the TipTap mark's data-cid attribute

  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  parentId?: string; // Set to create a reply in a thread
}

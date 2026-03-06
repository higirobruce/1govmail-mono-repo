import {
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ArrayMinSize,
} from 'class-validator';

export class SendMessageDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one recipient is required' })
  @IsEmail({}, { each: true, message: 'Each "to" address must be a valid email' })
  to: string[];

  @IsOptional()
  @IsArray()
  @IsEmail({}, { each: true, message: 'Each "cc" address must be a valid email' })
  cc?: string[];

  @IsOptional()
  @IsArray()
  @IsEmail({}, { each: true, message: 'Each "bcc" address must be a valid email' })
  bcc?: string[];

  @IsString()
  @IsNotEmpty({ message: 'subject must not be empty' })
  subject: string;

  @IsString()
  body: string;

  @IsOptional()
  @IsString()
  replyToId?: string;

  @IsOptional()
  @IsIn(['r', 'w'])
  replyType?: 'r' | 'w';
}

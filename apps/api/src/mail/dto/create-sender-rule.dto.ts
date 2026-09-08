import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateSenderRuleDto {
  @IsIn(['BLOCK', 'ALLOW'])
  type!: 'BLOCK' | 'ALLOW';

  // Either a full address ("person@example.com") or a domain wildcard ("@example.com").
  @IsString()
  @MinLength(3)
  @MaxLength(320)
  @Matches(/^@?[^\s@]+@[^\s@]+\.[^\s@]+$|^@[^\s@]+\.[^\s@]+$/, {
    message: 'address must be an email address or a domain wildcard like "@example.com"',
  })
  address!: string;
}

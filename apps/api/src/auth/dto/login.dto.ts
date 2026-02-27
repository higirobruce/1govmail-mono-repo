import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'password must not be empty' })
  password: string;

  /**
   * Zimbra server host. Accepted formats:
   *   - "mail.company.com"             (defaults to https, port 443)
   *   - "mail.company.com:8443"        (https, custom port)
   *   - "https://mail.company.com"     (explicit https)
   *   - "http://mail.company.com:8080" (self-hosted plain HTTP)
   */
  @IsString()
  @IsNotEmpty({ message: 'zimbraHost must not be empty' })
  zimbraHost: string;
}

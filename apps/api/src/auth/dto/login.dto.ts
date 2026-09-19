import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'password must not be empty' })
  password: string;

  /**
   * Institution id (e.g. "risa"), resolved to a provider + host via
   * InstitutionRegistry. The web client no longer sends this — the server
   * derives the institution from the address domain when it is absent, so
   * email + password alone is a complete login. Still accepted, and still
   * takes precedence, for older clients that supply it.
   */
  @IsOptional()
  @IsString()
  institution?: string;

  /**
   * Legacy: Zimbra server host. Accepted formats:
   *   - "mail.company.com"             (defaults to https, port 443)
   *   - "mail.company.com:8443"        (https, custom port)
   *   - "https://mail.company.com"     (explicit https)
   *   - "http://mail.company.com:8080" (self-hosted plain HTTP)
   *
   * @deprecated Prefer `institution`. Kept for older clients — the server
   * maps this back to an institution via InstitutionRegistry.resolveByHost
   * and logs a deprecation warning.
   */
  @IsOptional()
  @IsString()
  zimbraHost?: string;
}

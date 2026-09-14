import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'password must not be empty' })
  password: string;

  /**
   * Institution id from the `/auth/institutions` dropdown (e.g. "risa").
   * The server resolves this to a provider + host via InstitutionRegistry —
   * preferred over `zimbraHost`. At least one of `institution`/`zimbraHost`
   * must be supplied; the service enforces that.
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

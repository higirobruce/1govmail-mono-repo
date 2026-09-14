import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { CapabilityNotSupportedError } from '../../provider/capability.error';

/**
 * Turns a {@link CapabilityNotSupportedError} — thrown when a feature service
 * calls a provider capability the backend lacks (e.g. an EWS user hitting
 * change-password / server prefs / identities / signatures, spec §7) — into a
 * clean HTTP 400 instead of the default 500 an unmapped Error would produce.
 *
 * The response message is deliberately generic ("This setting is not available
 * for your mail account.") so it never leaks which provider or capability is
 * missing; the internal error text (which names the mail server) stays in logs.
 */
@Catch(CapabilityNotSupportedError)
export class CapabilityNotSupportedFilter implements ExceptionFilter {
  catch(_exception: CapabilityNotSupportedError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: 'This setting is not available for your mail account.',
    });
  }
}

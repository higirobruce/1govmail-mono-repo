import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { CapabilityNotSupportedFilter } from './capability-not-supported.filter';
import { CapabilityNotSupportedError } from '../../provider/capability.error';

/** Minimal ArgumentsHost double exposing the Express response the filter writes. */
function makeHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('CapabilityNotSupportedFilter', () => {
  it('maps CapabilityNotSupportedError to a clean HTTP 400', () => {
    const filter = new CapabilityNotSupportedFilter();
    const { host, status, json } = makeHost();

    filter.catch(new CapabilityNotSupportedError('password changes'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'This setting is not available for your mail account.',
      }),
    );
  });

  it('does not leak the internal error text (which names "mail server")', () => {
    const filter = new CapabilityNotSupportedFilter();
    const { host, json } = makeHost();

    filter.catch(new CapabilityNotSupportedError('signatures'), host);

    const body = json.mock.calls[0][0];
    expect(body.message).not.toMatch(/mail server/i);
    expect(body.message).not.toMatch(/signatures/i);
  });
});

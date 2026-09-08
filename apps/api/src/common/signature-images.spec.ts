import { inlineSignatureImages } from './signature-images';
import { ZimbraService } from '../zimbra/zimbra.service';

function makeZimbra() {
  return {
    downloadZimbraPath: jest.fn(),
  } as unknown as ZimbraService & { downloadZimbraPath: jest.Mock };
}

describe('inlineSignatureImages', () => {
  const user = { zimbraHost: 'mail.example.com', authToken: 'tok' };

  it('replaces /home/ Briefcase src with a base64 data URI and preserves data-zimbra-src', async () => {
    const zimbra = makeZimbra();
    zimbra.downloadZimbraPath.mockResolvedValue({
      data: Buffer.from('hello'),
      contentType: 'image/png',
    });

    const html = await inlineSignatureImages(
      zimbra,
      user,
      '<p>Sig</p><img src="/home/bruce@risa.gov.rw/Briefcase/logo.png">',
    );

    expect(html).toContain(
      `src="data:image/png;base64,${Buffer.from('hello').toString('base64')}"`,
    );
    expect(html).toContain('data-zimbra-src="/home/bruce@risa.gov.rw/Briefcase/logo.png"');
    expect(zimbra.downloadZimbraPath).toHaveBeenCalledWith(
      'mail.example.com', 'tok', '/home/bruce@risa.gov.rw/Briefcase/logo.png',
    );
  });

  it('leaves the original src when the download fails for one image', async () => {
    const zimbra = makeZimbra();
    zimbra.downloadZimbraPath.mockRejectedValue(new Error('network error'));

    const html = await inlineSignatureImages(
      zimbra,
      user,
      '<img src="/home/bruce@risa.gov.rw/Briefcase/logo.png">',
    );

    expect(html).toBe('<img src="/home/bruce@risa.gov.rw/Briefcase/logo.png">');
  });

  it('returns the html unchanged when there is no authToken', async () => {
    const zimbra = makeZimbra();
    const html = await inlineSignatureImages(
      zimbra,
      { zimbraHost: 'mail.example.com', authToken: null },
      '<img src="/home/bruce@risa.gov.rw/Briefcase/logo.png">',
    );

    expect(html).toBe('<img src="/home/bruce@risa.gov.rw/Briefcase/logo.png">');
    expect(zimbra.downloadZimbraPath).not.toHaveBeenCalled();
  });

  it('returns the html unchanged when there are no /home/ images', async () => {
    const zimbra = makeZimbra();
    const html = await inlineSignatureImages(zimbra, user, '<p>No images here</p>');

    expect(html).toBe('<p>No images here</p>');
    expect(zimbra.downloadZimbraPath).not.toHaveBeenCalled();
  });
});

import { UnauthorizedException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { ZimbraService } from '../zimbra/zimbra.service';

function makePrisma() {
  return {
    user: {
      findUnique: jest.fn(),
    },
    userAiProfile: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

function makeZimbra() {
  return {
    // The real declaration, not a hand-written literal — this is what makes the
    // capabilities assertion below a test of the plumbing (provider declares →
    // GET /settings forwards) rather than of a fixture.
    capabilities: new ZimbraService().capabilities,
    getPrefs: jest.fn(),
    getIdentities: jest.fn(),
    getSignatures: jest.fn(),
    modifyPrefs: jest.fn(),
    modifyIdentity: jest.fn(),
    createSignature: jest.fn(),
    modifySignature: jest.fn(),
    deleteSignature: jest.fn(),
    changePassword: jest.fn(),
    galSelfLookup: jest.fn(),
    downloadZimbraPath: jest.fn(),
  } as any;
}

const zimbraCallsOnly = (zimbra: any) =>
  Object.values(zimbra).filter((v: any) => typeof v?.mock === 'object');

describe('SettingsService AI profile', () => {
  describe('getAiProfile', () => {
    it('returns all-null shape when no row exists', async () => {
      const prisma = makePrisma();
      const zimbra = makeZimbra();
      const service = new SettingsService(prisma, zimbra);

      const result = await service.getAiProfile('u1');

      expect(result).toEqual({
        instructions: null,
        jobTitle: null,
        institution: null,
        department: null,
        language: null,
      });
      expect(prisma.userAiProfile.findUnique).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        select: {
          instructions: true,
          jobTitle: true,
          institution: true,
          department: true,
          language: true,
        },
      });
      expect(zimbraCallsOnly(zimbra).every((fn: any) => !fn.mock.calls.length)).toBe(true);
    });

    it('returns the row shape when one exists', async () => {
      const prisma = makePrisma();
      prisma.userAiProfile.findUnique.mockResolvedValue({
        instructions: 'be concise',
        jobTitle: 'Director',
        institution: 'MINALOC',
        department: 'IT',
        language: 'en',
      });
      const zimbra = makeZimbra();
      const service = new SettingsService(prisma, zimbra);

      const result = await service.getAiProfile('u1');

      expect(result).toEqual({
        instructions: 'be concise',
        jobTitle: 'Director',
        institution: 'MINALOC',
        department: 'IT',
        language: 'en',
      });
      expect(zimbraCallsOnly(zimbra).every((fn: any) => !fn.mock.calls.length)).toBe(true);
    });
  });

  describe('updateAiProfile', () => {
    it('upserts and maps empty string fields to null', async () => {
      const prisma = makePrisma();
      prisma.userAiProfile.findUnique.mockResolvedValue({
        instructions: null,
        jobTitle: null,
        institution: null,
        department: null,
        language: null,
      });
      const zimbra = makeZimbra();
      const service = new SettingsService(prisma, zimbra);

      const result = await service.updateAiProfile('u1', {
        instructions: 'be concise',
        jobTitle: '',
        institution: '  MINALOC  ',
        language: '',
      } as any);

      expect(prisma.userAiProfile.upsert).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        update: {
          instructions: 'be concise',
          jobTitle: null,
          institution: 'MINALOC',
          language: null,
        },
        create: {
          userId: 'u1',
          instructions: 'be concise',
          jobTitle: null,
          institution: 'MINALOC',
          language: null,
        },
      });
      expect(result).toEqual({
        instructions: null,
        jobTitle: null,
        institution: null,
        department: null,
        language: null,
      });
      expect(zimbraCallsOnly(zimbra).every((fn: any) => !fn.mock.calls.length)).toBe(true);
    });

    it('omits undefined fields from the upsert payload (partial update)', async () => {
      const prisma = makePrisma();
      const zimbra = makeZimbra();
      const service = new SettingsService(prisma, zimbra);

      await service.updateAiProfile('u1', { department: 'IT' } as any);

      expect(prisma.userAiProfile.upsert).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        update: { department: 'IT' },
        create: { userId: 'u1', department: 'IT' },
      });
    });

    it('does not throw on an explicit JSON null and treats it like undefined (field ignored)', async () => {
      const prisma = makePrisma();
      const zimbra = makeZimbra();
      const service = new SettingsService(prisma, zimbra);

      await expect(
        service.updateAiProfile('u1', { jobTitle: null, department: 'IT' } as any),
      ).resolves.toBeDefined();

      expect(prisma.userAiProfile.upsert).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        update: { department: 'IT' },
        create: { userId: 'u1', department: 'IT' },
      });
    });
  });

  describe('getAiProfileSuggestions', () => {
    const baseUser = {
      id: 'u1',
      email: 'bruce@risa.gov.rw',
      displayName: 'Bruce H.',
      zimbraHost: 'zimbra.example.com',
      authToken: 'tok',
      csrfToken: 'csrf',
    };

    it('returns GAL title/department/institution (no displayName — consumed nowhere)', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(baseUser);
      const zimbra = makeZimbra();
      zimbra.galSelfLookup.mockResolvedValue({
        title: 'Director', department: 'IT', company: 'MINALOC',
      });
      const service = new SettingsService(prisma, zimbra);

      const result = await service.getAiProfileSuggestions('u1');

      expect(result).toEqual({
        jobTitle: 'Director',
        institution: 'MINALOC',
        department: 'IT',
      });
      expect(zimbra.getIdentities).not.toHaveBeenCalled();
      expect(zimbra.galSelfLookup).toHaveBeenCalledWith(
        { host: 'zimbra.example.com', email: 'bruce@risa.gov.rw', authToken: 'tok', csrfToken: 'csrf' },
        'bruce@risa.gov.rw',
      );
    });

    it('returns all-null suggestion fields when the GAL lookup throws, without raising', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(baseUser);
      const zimbra = makeZimbra();
      zimbra.galSelfLookup.mockRejectedValue(new Error('zimbra down'));
      const service = new SettingsService(prisma, zimbra);

      const result = await service.getAiProfileSuggestions('u1');

      expect(result).toEqual({
        jobTitle: null,
        institution: null,
        department: null,
      });
    });

    it('rejects with UnauthorizedException when the user has no Zimbra authToken', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue({ ...baseUser, authToken: null });
      const zimbra = makeZimbra();
      const service = new SettingsService(prisma, zimbra);

      await expect(service.getAiProfileSuggestions('u1')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(zimbra.getIdentities).not.toHaveBeenCalled();
      expect(zimbra.galSelfLookup).not.toHaveBeenCalled();
    });
  });
});

describe('SettingsService getSettings', () => {
  const baseUser = {
    id: 'u1',
    email: 'bruce@risa.gov.rw',
    displayName: 'Bruce H.',
    zimbraHost: 'zimbra.example.com',
    authToken: 'tok',
    csrfToken: 'csrf',
  };

  function arrange() {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(baseUser);
    const zimbra = makeZimbra();
    zimbra.getPrefs.mockResolvedValue({ zimbraPrefDefaultSignatureId: 's1' });
    zimbra.getIdentities.mockResolvedValue([
      { id: 'i1', name: 'DEFAULT', attrs: { zimbraPrefFromDisplay: 'Bruce H.' } },
    ]);
    zimbra.getSignatures.mockResolvedValue([
      { id: 's1', name: 'Work', contentHtml: '<p>hi</p>', contentText: 'hi' },
    ]);
    return { prisma, zimbra, service: new SettingsService(prisma, zimbra) };
  }

  it('exposes the provider capability flags', async () => {
    const { service } = arrange();

    const result = await service.getSettings('u1');

    expect(result.capabilities).toEqual({
      signatures: true,
      identities: true,
      serverPrefs: true,
      changePassword: true,
      twoFactor: true,
    });
  });

  it('leaves the rest of the payload byte-identical to the pre-provider response', async () => {
    const { service } = arrange();

    const { capabilities, ...rest } = await service.getSettings('u1');

    expect(capabilities).toBeDefined();
    expect(rest).toEqual({
      email: 'bruce@risa.gov.rw',
      zimbraHost: 'zimbra.example.com',
      displayName: 'Bruce H.',
      prefs: { zimbraPrefDefaultSignatureId: 's1' },
      identities: [{ id: 'i1', name: 'DEFAULT', attrs: { zimbraPrefFromDisplay: 'Bruce H.' } }],
      signatures: [{ id: 's1', name: 'Work', contentHtml: '<p>hi</p>', contentText: 'hi' }],
    });
  });

  it('reads prefs/identities/signatures off one MailSession built from the user row', async () => {
    const { zimbra, service } = arrange();

    await service.getSettings('u1');

    const session = {
      host: 'zimbra.example.com',
      email: 'bruce@risa.gov.rw',
      authToken: 'tok',
      csrfToken: 'csrf',
    };
    expect(zimbra.getPrefs).toHaveBeenCalledWith(session);
    expect(zimbra.getIdentities).toHaveBeenCalledWith(session);
    expect(zimbra.getSignatures).toHaveBeenCalledWith(session);
  });
});

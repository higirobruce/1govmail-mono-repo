import { UnauthorizedException } from '@nestjs/common';
import { SettingsService } from './settings.service';

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
  } as any;
}

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
      expect(Object.values(zimbra).every((fn: any) => !fn.mock.calls.length)).toBe(true);
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
      expect(Object.values(zimbra).every((fn: any) => !fn.mock.calls.length)).toBe(true);
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
      expect(Object.values(zimbra).every((fn: any) => !fn.mock.calls.length)).toBe(true);
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

    it('merges identity displayName with GAL title/department/institution', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(baseUser);
      const zimbra = makeZimbra();
      zimbra.getIdentities.mockResolvedValue([
        { id: '1', name: 'default', attrs: { zimbraPrefFromDisplay: 'Bruce Higiro' } },
      ]);
      zimbra.galSelfLookup.mockResolvedValue({
        title: 'Director', department: 'IT', company: 'MINALOC',
      });
      const service = new SettingsService(prisma, zimbra);

      const result = await service.getAiProfileSuggestions('u1');

      expect(result).toEqual({
        displayName: 'Bruce Higiro',
        jobTitle: 'Director',
        institution: 'MINALOC',
        department: 'IT',
      });
      expect(zimbra.getIdentities).toHaveBeenCalledWith('zimbra.example.com', 'tok', 'csrf');
      expect(zimbra.galSelfLookup).toHaveBeenCalledWith(
        'zimbra.example.com', 'tok', 'bruce@risa.gov.rw', 'csrf',
      );
    });

    it('falls back to user.displayName when no identity display attr is set', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(baseUser);
      const zimbra = makeZimbra();
      zimbra.getIdentities.mockResolvedValue([{ id: '1', name: 'default', attrs: {} }]);
      zimbra.galSelfLookup.mockResolvedValue({ title: null, department: null, company: null });
      const service = new SettingsService(prisma, zimbra);

      const result = await service.getAiProfileSuggestions('u1');

      expect(result.displayName).toBe('Bruce H.');
    });

    it('falls back to user.displayName when getIdentities returns no identities', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(baseUser);
      const zimbra = makeZimbra();
      zimbra.getIdentities.mockResolvedValue([]);
      zimbra.galSelfLookup.mockResolvedValue({ title: null, department: null, company: null });
      const service = new SettingsService(prisma, zimbra);

      const result = await service.getAiProfileSuggestions('u1');

      expect(result.displayName).toBe('Bruce H.');
    });

    it('returns all-null suggestion fields when both Zimbra legs throw, without raising', async () => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue(baseUser);
      const zimbra = makeZimbra();
      zimbra.getIdentities.mockRejectedValue(new Error('zimbra down'));
      zimbra.galSelfLookup.mockRejectedValue(new Error('zimbra down'));
      const service = new SettingsService(prisma, zimbra);

      const result = await service.getAiProfileSuggestions('u1');

      expect(result).toEqual({
        displayName: 'Bruce H.',
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

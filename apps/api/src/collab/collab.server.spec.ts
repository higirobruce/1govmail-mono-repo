import * as jwt from 'jsonwebtoken';
import type { onAuthenticatePayload } from '@hocuspocus/server';
import { authenticateCollabConnection } from './collab.server';

const JWT_SECRET = 'test-secret';

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    session: { findUnique: jest.fn() },
    document: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    documentInvite: { findUnique: jest.fn() },
    ...overrides,
  } as any;
}

function makePayload(token: string, documentName = 'doc1'): onAuthenticatePayload {
  return {
    token,
    documentName,
    connectionConfig: { readOnly: false } as any,
  } as unknown as onAuthenticatePayload;
}

describe('authenticateCollabConnection (jwt token type)', () => {
  const userId = 'u1';
  const validJwt = jwt.sign({ sub: userId }, JWT_SECRET);
  const rawToken = JSON.stringify({ type: 'jwt', value: validJwt });

  it('rejects when there is no matching Session row (revoked or never existed)', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue(null);

    await expect(
      authenticateCollabConnection(makePayload(rawToken), { prisma, jwtSecret: JWT_SECRET }),
    ).rejects.toThrow(/session/i);

    expect(prisma.document.findUnique).not.toHaveBeenCalled();
  });

  it('rejects when the Session row has expired', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      userId,
      token: validJwt,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      authenticateCollabConnection(makePayload(rawToken), { prisma, jwtSecret: JWT_SECRET }),
    ).rejects.toThrow(/session/i);
  });

  it('rejects when the session belongs to a different user than the JWT payload', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'someone-else',
      token: validJwt,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      authenticateCollabConnection(makePayload(rawToken), { prisma, jwtSecret: JWT_SECRET }),
    ).rejects.toThrow(/session/i);
  });

  it('accepts a live session belonging to the document owner', async () => {
    const prisma = makePrisma();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      userId,
      token: validJwt,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.document.findUnique.mockResolvedValue({ userId });

    const result = await authenticateCollabConnection(makePayload(rawToken), {
      prisma,
      jwtSecret: JWT_SECRET,
    });

    expect(result).toEqual({ userId });
    expect(prisma.session.findUnique).toHaveBeenCalledWith({ where: { token: validJwt } });
  });
});

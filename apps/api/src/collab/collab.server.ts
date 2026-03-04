import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';

export function createCollabServer() {
  const prisma = new PrismaClient();
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.warn('[collab] JWT_SECRET not set — authenticated collaboration will fail');
  }

  return new Server({
    port: Number(process.env.HOCUSPOCUS_PORT ?? 1234),
    quiet: true,
    debounce: 300,
    maxDebounce: 2000,
    stopOnSignals: false,

    // ── Authentication ──────────────────────────────────────────────────────
    async onAuthenticate({ token, documentName }) {
      let parsed: { type: string; value: string };

      try {
        parsed = JSON.parse(token) as { type: string; value: string };
      } catch {
        throw new Error('Invalid token format');
      }

      const { type, value } = parsed;

      if (type === 'jwt') {
        if (!jwtSecret) throw new Error('Server misconfiguration');
        const payload = jwt.verify(value, jwtSecret) as { sub: string };
        const doc = await prisma.document.findUnique({
          where: { id: documentName },
          select: { userId: true },
        });
        if (!doc || doc.userId !== payload.sub) throw new Error('Forbidden');
        return { userId: payload.sub };
      }

      if (type === 'share') {
        const doc = await prisma.document.findUnique({
          where: { shareToken: value },
          select: { id: true, isShared: true },
        });
        if (!doc || !doc.isShared || doc.id !== documentName) throw new Error('Forbidden');
        return { userId: null };
      }

      throw new Error('Unknown token type');
    },

    extensions: [
      new Database({
        // ── Load Yjs state from DB ────────────────────────────────────────
        async fetch({ documentName }) {
          const doc = await prisma.document.findUnique({
            where: { id: documentName },
            select: { yjsState: true },
          });
          return doc?.yjsState ?? null;
        },

        // ── Persist Yjs state to DB ───────────────────────────────────────
        async store({ documentName, state }) {
          await prisma.document.update({
            where: { id: documentName },
            data: { yjsState: Buffer.from(state) },
          });
        },
      }),
    ],
  });
}

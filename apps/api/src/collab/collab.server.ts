import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { InviteRole, PrismaClient, SharePermission } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import * as jwt from 'jsonwebtoken';

export function createCollabServer() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
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
    async onAuthenticate({ token, documentName, connectionConfig }) {
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
        if (!doc) throw new Error('Forbidden');

        // Owner — full access
        if (doc.userId === payload.sub) return { userId: payload.sub };

        // Check invite — invitees (any role) may connect for real-time updates
        const user = await prisma.user.findUnique({
          where: { id: payload.sub },
          select: { email: true },
        });
        if (!user) throw new Error('Forbidden');
        const invite = await prisma.documentInvite.findUnique({
          where: { documentId_invitedEmail: { documentId: documentName, invitedEmail: user.email } },
          select: { role: true },
        });
        if (!invite) throw new Error('Forbidden');
        // Viewers may receive updates but must not push edits
        if (invite.role === InviteRole.VIEWER) connectionConfig.readOnly = true;
        return { userId: payload.sub, role: invite.role };
      }

      if (type === 'share') {
        const doc = await prisma.document.findUnique({
          where: { shareToken: value },
          select: { id: true, isShared: true, sharePermission: true },
        });
        if (!doc || !doc.isShared || doc.id !== documentName) throw new Error('Forbidden');
        if (doc.sharePermission !== SharePermission.EDIT) connectionConfig.readOnly = true;
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

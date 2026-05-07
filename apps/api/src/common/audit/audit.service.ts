import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type AuditAction =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'LOGIN_2FA_REQUIRED'
  | 'LOGIN_2FA_FAILURE'
  | 'LOGOUT'
  | 'PASSWORD_CHANGED'
  | 'PREFS_CHANGED'
  | 'SIGNATURE_CREATED'
  | 'SIGNATURE_UPDATED'
  | 'SIGNATURE_DELETED'
  | 'DOC_SHARE_ENABLED'
  | 'DOC_SHARE_DISABLED'
  | 'DOC_INVITE_ADDED'
  | 'DOC_INVITE_REMOVED'
  | 'DOC_DELETED';

export interface AuditContext {
  userId?: string | null;
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  resource?: string | null;
  resourceId?: string | null;
  success?: boolean;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Best-effort write — never let audit log failures break the primary action.
  async record(action: AuditAction, ctx: AuditContext = {}): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          userId: ctx.userId ?? null,
          email: ctx.email ?? null,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          resource: ctx.resource ?? null,
          resourceId: ctx.resourceId ?? null,
          success: ctx.success ?? true,
          metadata: ctx.metadata ? (ctx.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
        },
      });
    } catch (err) {
      this.logger.warn(`audit ${action} failed: ${String(err)}`);
    }
  }
}

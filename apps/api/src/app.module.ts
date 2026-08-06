import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { ZimbraModule } from './zimbra/zimbra.module';
import { AuthModule } from './auth/auth.module';
import { MailModule } from './mail/mail.module';
import { ContactsModule } from './contacts/contacts.module';
import { CalendarModule } from './calendar/calendar.module';
import { SettingsModule } from './settings/settings.module';
import { TasksModule } from './tasks/tasks.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DocsModule } from './docs/docs.module';
import { AiModule } from './ai/ai.module';
import { AuditModule } from './common/audit/audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Global default: 120 requests / minute / IP. Stricter limits are applied
    // per-endpoint (see @Throttle decorators on login and public share routes).
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 120 },
    ]),
    PrismaModule,
    AuditModule,
    ZimbraModule,
    AuthModule,
    MailModule,
    ContactsModule,
    CalendarModule,
    SettingsModule,
    TasksModule,
    NotificationsModule,
    DocsModule,
    AiModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

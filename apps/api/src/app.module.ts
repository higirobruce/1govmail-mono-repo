import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { ProviderModule } from './provider/provider.module';
import { AuthModule } from './auth/auth.module';
import { MailModule } from './mail/mail.module';
import { ContactsModule } from './contacts/contacts.module';
import { CalendarModule } from './calendar/calendar.module';
import { SettingsModule } from './settings/settings.module';
import { TasksModule } from './tasks/tasks.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PeopleModule } from './people/people.module';
import { DocsModule } from './docs/docs.module';
import { AiModule } from './ai/ai.module';
import { ChatModule } from './chat/chat.module';
import { AgentModule } from './agent/agent.module';
import { AuditModule } from './common/audit/audit.module';
import { CapabilityNotSupportedFilter } from './common/filters/capability-not-supported.filter';

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
    ProviderModule,
    AuthModule,
    MailModule,
    ContactsModule,
    CalendarModule,
    SettingsModule,
    TasksModule,
    NotificationsModule,
    PeopleModule,
    DocsModule,
    AiModule,
    ChatModule,
    AgentModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Maps CapabilityNotSupportedError (e.g. an EWS user directly POSTing to
    // change-password / prefs) to a clean HTTP 400 instead of a 500 (spec §7).
    { provide: APP_FILTER, useClass: CapabilityNotSupportedFilter },
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { CalendarModule } from '../calendar/calendar.module';
import { CalendarService } from '../calendar/calendar.service';
import { ChatModule } from '../chat/chat.module';
import { ContactsModule } from '../contacts/contacts.module';
import { ContactsService } from '../contacts/contacts.service';
import { DocsModule } from '../docs/docs.module';
import { DocsService } from '../docs/docs.service';
import { MailModule } from '../mail/mail.module';
import { MailService } from '../mail/mail.service';
import { PeopleModule } from '../people/people.module';
import { PeopleService } from '../people/people.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RetrievalService } from '../chat/retrieval.service';
import { TasksModule } from '../tasks/tasks.module';
import { TasksService } from '../tasks/tasks.service';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ToolRegistry } from './tool-registry';
import { buildAttachmentTool } from './tools/attachment.tools';
import { buildCalendarTools } from './tools/calendar.tools';
import { buildDocsTools } from './tools/docs.tools';
import { buildMailReadTools } from './tools/mail.tools';
import { buildPeopleTools } from './tools/people.tools';
import { buildChartTool, buildGatedTools, buildWriteTools } from './tools/write.tools';

@Module({
  imports: [PrismaModule, AiModule, ChatModule, MailModule, DocsModule, TasksModule, CalendarModule, ContactsModule, PeopleModule],
  providers: [
    AgentService,
    {
      provide: ToolRegistry,
      inject: [MailService, RetrievalService, DocsService, TasksService, CalendarService, ContactsService, PeopleService],
      useFactory: (
        mail: MailService,
        retrieval: RetrievalService,
        docs: DocsService,
        tasks: TasksService,
        calendar: CalendarService,
        contacts: ContactsService,
        people: PeopleService,
      ) => {
        const registry = new ToolRegistry();
        registry.registerAll(buildMailReadTools(mail, retrieval));
        registry.register(buildAttachmentTool(mail));
        registry.registerAll(buildDocsTools(docs, retrieval));
        registry.registerAll(buildCalendarTools(calendar));
        registry.registerAll(buildPeopleTools(people, contacts, tasks));
        registry.registerAll(buildWriteTools(mail, docs, tasks));
        registry.registerAll(buildGatedTools());
        registry.register(buildChartTool());
        return registry;
      },
    },
  ],
  controllers: [AgentController],
})
export class AgentModule {}

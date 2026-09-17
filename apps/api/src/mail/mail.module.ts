import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';
import { MailScheduler } from './mail.scheduler';
import { CardExtractorService } from './card-extractor.service';
import { CardWorkerService } from './card-worker.service';
import { EmbedderService } from './embedder.service';
import { EmbedWorkerService } from './embed-worker.service';
import { AttachmentEmbedWorkerService } from './attachment-embed-worker.service';
import { SenderRuleSweepService } from './sender-rule-sweep.service';
import { InlineImageCacheService } from './inline-image-cache.service';
import { ProviderModule } from '../provider/provider.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [ProviderModule, PrismaModule, NotificationsModule, TasksModule],
  providers: [
    MailService,
    MailScheduler,
    CardExtractorService,
    CardWorkerService,
    EmbedderService,
    EmbedWorkerService,
    AttachmentEmbedWorkerService,
    SenderRuleSweepService,
    // Registered via a factory, not the bare class: Nest introspects the
    // constructor's parameter types when a class is listed directly, and
    // InlineImageCacheService's constructor takes a `string` (a default-valued
    // config root, not a DI token). The bare-class form makes Nest try to
    // resolve a `String` provider and fail to boot. The factory sidesteps
    // introspection entirely and always builds it with the default root.
    { provide: InlineImageCacheService, useFactory: () => new InlineImageCacheService() },
  ],
  exports: [MailService, EmbedderService],
  controllers: [MailController],
})
export class MailModule {}

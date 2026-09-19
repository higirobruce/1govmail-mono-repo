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
import { InlineImageEvictWorker } from './inline-image-evict.worker';
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
    // Same reason as InlineImageCacheService above: this constructor also
    // takes a `string` root (with a default) as its first parameter, not a
    // DI token. Registering it as a bare class provider reproduces the exact
    // boot failure that class caused — Nest tries to resolve a `String` and
    // the app never starts. The factory sidesteps introspection.
    { provide: InlineImageEvictWorker, useFactory: () => new InlineImageEvictWorker() },
  ],
  exports: [MailService, EmbedderService],
  controllers: [MailController],
})
export class MailModule {}

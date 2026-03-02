import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { createCollabServer } from './collab/collab.server';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  app.setGlobalPrefix('api');

  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  await app.listen(process.env.PORT ?? 3001);
  console.log(`API running on: http://localhost:${process.env.PORT ?? 3001}/api`);

  const collab = createCollabServer();
  await collab.listen();
  console.log(`Collab WS:   ws://localhost:${process.env.HOCUSPOCUS_PORT ?? 1234}`);
}
bootstrap();

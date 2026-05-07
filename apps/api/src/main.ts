import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { createCollabServer } from './collab/collab.server';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Trust the reverse proxy (nginx) so req.ip reflects the real client IP
  // for rate limiting and audit logs instead of the proxy's loopback address.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  // Security headers. CSP is scoped to the API (which serves JSON only,
  // never HTML), so the default restrictive policy is appropriate.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: {
        maxAge: 63072000,
        includeSubDomains: true,
        preload: true,
      },
    }),
  );

  app.setGlobalPrefix('api');

  const allowedOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, cb) => {
      // Non-browser requests (curl, server-to-server) have no Origin header.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
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

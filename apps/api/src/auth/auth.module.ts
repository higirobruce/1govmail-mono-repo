import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthScheduler } from './auth.scheduler';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    ZimbraModule,
    PrismaModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        // Cast needed: @nestjs/jwt 11 tightened expiresIn to ms.StringValue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signOptions: { expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '7d') as any },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy, AuthScheduler],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}

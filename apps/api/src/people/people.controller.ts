import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PeopleService, type PersonDossier } from './people.service';
import { PersonDossierQueryDto } from './dto/person.dto';

interface AuthenticatedRequest extends Request {
  user: { sub: string };
}

@UseGuards(JwtAuthGuard)
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get('dossier')
  dossier(@Req() req: AuthenticatedRequest, @Query() q: PersonDossierQueryDto): Promise<PersonDossier> {
    return this.people.dossier(req.user.sub, q.email);
  }
}

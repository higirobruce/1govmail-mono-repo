import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { DocsService } from './docs.service';
import { CreateDocDto } from './dto/create-doc.dto';
import { UpdateDocDto } from './dto/update-doc.dto';

@UseGuards(JwtAuthGuard)
@Controller('docs')
export class DocsController {
  constructor(private readonly docsService: DocsService) {}

  @Get()
  findAll(@Req() req: AuthenticatedRequest) {
    return this.docsService.findAll(req.user.sub);
  }

  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateDocDto) {
    return this.docsService.create(req.user.sub, dto);
  }

  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.findOne(req.user.sub, id);
  }

  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateDocDto,
  ) {
    return this.docsService.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.remove(req.user.sub, id);
  }
}

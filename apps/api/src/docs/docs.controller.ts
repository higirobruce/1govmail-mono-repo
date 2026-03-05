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

@Controller('docs')
export class DocsController {
  constructor(private readonly docsService: DocsService) {}

  // ── Public share routes — declared FIRST so 'shared' is matched as a
  //    literal segment before the dynamic ':id' routes are registered ──────────

  @Get('shared/:token')
  getByToken(@Param('token') token: string) {
    return this.docsService.findByShareToken(token);
  }

  @Patch('shared/:token')
  updateByToken(@Param('token') token: string, @Body() dto: UpdateDocDto) {
    return this.docsService.updateByShareToken(token, dto);
  }

  // ── Authenticated routes ──────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Req() req: AuthenticatedRequest) {
    return this.docsService.findAll(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateDocDto) {
    return this.docsService.create(req.user.sub, dto);
  }

  // Share management — declared before /:id so ':id/share' doesn't shadow ':id'
  @UseGuards(JwtAuthGuard)
  @Post(':id/share')
  enableSharing(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.enableSharing(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/share')
  @HttpCode(HttpStatus.OK)
  disableSharing(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.disableSharing(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/favorite')
  @HttpCode(HttpStatus.OK)
  toggleFavorite(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.toggleFavorite(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.findOne(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateDocDto,
  ) {
    return this.docsService.update(req.user.sub, id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.docsService.remove(req.user.sub, id);
  }
}

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Body,
  Param,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { CreateSubtaskDto } from './dto/create-subtask.dto';
import { UpdateSubtaskDto } from './dto/update-subtask.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';

@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  /** GET /tasks?status=TODO&linkedMessageId=X */
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('linkedMessageId') linkedMessageId?: string,
  ) {
    return this.tasksService.findAll(req.user.sub, status, linkedMessageId);
  }

  /** POST /tasks */
  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateTaskDto,
  ) {
    return this.tasksService.create(req.user.sub, dto);
  }

  /** PATCH /tasks/:id */
  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasksService.update(req.user.sub, id, dto);
  }

  /** DELETE /tasks/:id */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.tasksService.remove(req.user.sub, id);
  }

  /** POST /tasks/:id/assign */
  @Post(':id/assign')
  assign(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { assigneeEmail: string; assigneeName?: string },
  ) {
    return this.tasksService.assign(
      req.user.sub,
      id,
      body.assigneeEmail,
      body.assigneeName,
    );
  }

  // ─── Subtasks ───────────────────────────────────────────────────────────────

  /** POST /tasks/:id/subtasks */
  @Post(':id/subtasks')
  createSubtask(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreateSubtaskDto,
  ) {
    return this.tasksService.createSubtask(req.user.sub, id, dto);
  }

  /** PATCH /tasks/:id/subtasks/:sid */
  @Patch(':id/subtasks/:sid')
  updateSubtask(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Body() dto: UpdateSubtaskDto,
  ) {
    return this.tasksService.updateSubtask(req.user.sub, id, sid, dto);
  }

  /** DELETE /tasks/:id/subtasks/:sid */
  @Delete(':id/subtasks/:sid')
  @HttpCode(HttpStatus.OK)
  deleteSubtask(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.tasksService.deleteSubtask(req.user.sub, id, sid);
  }

  // ─── Comments ───────────────────────────────────────────────────────────────

  /** POST /tasks/:id/comments */
  @Post(':id/comments')
  createComment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.tasksService.createComment(req.user.sub, id, dto);
  }

  /** DELETE /tasks/:id/comments/:cid */
  @Delete(':id/comments/:cid')
  @HttpCode(HttpStatus.OK)
  deleteComment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('cid') cid: string,
  ) {
    return this.tasksService.deleteComment(req.user.sub, id, cid);
  }

  // ─── Attachments ─────────────────────────────────────────────────────────────

  /** POST /tasks/:id/attachments — upload files (multipart/form-data, field: "attachments") */
  @Post(':id/attachments')
  @UseInterceptors(
    FilesInterceptor('attachments', 5, {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
    }),
  )
  addAttachments(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    if (!files?.length) throw new BadRequestException('No files uploaded');
    return this.tasksService.addAttachments(req.user.sub, id, files);
  }

  /** DELETE /tasks/:id/attachments/:attId */
  @Delete(':id/attachments/:attId')
  @HttpCode(HttpStatus.OK)
  deleteAttachment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('attId') attId: string,
  ) {
    return this.tasksService.deleteAttachment(req.user.sub, id, attId);
  }

  /** GET /tasks/:id/attachments/:attId/download */
  @Get(':id/attachments/:attId/download')
  async downloadAttachment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('attId') attId: string,
    @Res() res: Response,
  ) {
    const { filename, mimeType, buffer } =
      await this.tasksService.downloadAttachment(req.user.sub, id, attId);
    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );
    res.send(buffer);
  }
}

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';

interface AttachmentEntry {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  data: string; // base64
}
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { CreateTaskDto, TaskStatus, AssigneeDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { CreateSubtaskDto } from './dto/create-subtask.dto';
import { UpdateSubtaskDto } from './dto/update-subtask.dto';
import { CreateCommentDto } from './dto/create-comment.dto';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
  ) {}

  private async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findAll(userId: string, status?: string, linkedMessageId?: string) {
    const tasks = await this.prisma.task.findMany({
      where: {
        userId,
        ...(status ? { status: status as TaskStatus } : {}),
        ...(linkedMessageId ? { linkedMessageId } : {}),
      },
      include: {
        subtasks: { orderBy: { createdAt: 'asc' } },
        comments: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: [{ createdAt: 'desc' }],
    });
    // Strip base64 data from attachment entries to keep list response small
    return tasks.map((t) => ({
      ...t,
      attachments: t.attachments
        ? (t.attachments as unknown as AttachmentEntry[]).map(({ data: _data, ...meta }) => meta)
        : null,
    }));
  }

  async create(userId: string, dto: CreateTaskDto) {
    return this.prisma.task.create({
      data: {
        userId,
        title: dto.title,
        description: dto.description,
        status: dto.status ?? TaskStatus.TODO,
        priority: dto.priority ?? 'MEDIUM',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        linkedMessageId: dto.linkedMessageId,
        linkedSubject: dto.linkedSubject,
        recurrence: dto.recurrence ?? null,
        recurrenceEndDate: dto.recurrenceEndDate ? new Date(dto.recurrenceEndDate) : null,
        reminderAt: dto.reminderAt ? new Date(dto.reminderAt) : null,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateTaskDto) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.userId !== userId) throw new ForbiddenException();

    const goingDone =
      dto.status === TaskStatus.DONE && task.status !== TaskStatus.DONE;
    const leavingDone =
      dto.status && dto.status !== TaskStatus.DONE && task.status === TaskStatus.DONE;

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.dueDate !== undefined ? { dueDate: dto.dueDate ? new Date(dto.dueDate) : null } : {}),
        ...(dto.linkedMessageId !== undefined ? { linkedMessageId: dto.linkedMessageId } : {}),
        ...(dto.linkedSubject !== undefined ? { linkedSubject: dto.linkedSubject } : {}),
        ...(dto.recurrence !== undefined ? { recurrence: dto.recurrence || null } : {}),
        ...(dto.recurrenceEndDate !== undefined
          ? { recurrenceEndDate: dto.recurrenceEndDate ? new Date(dto.recurrenceEndDate) : null }
          : {}),
        ...(dto.reminderAt !== undefined
          ? { reminderAt: dto.reminderAt ? new Date(dto.reminderAt) : null, reminderSentAt: null }
          : {}),
        ...(goingDone ? { completedAt: new Date() } : {}),
        ...(leavingDone ? { completedAt: null } : {}),
      },
    });

    // Recurrence spawn: when marking DONE and task has a recurrence rule + due date
    if (goingDone && task.recurrence && task.dueDate) {
      const nextDue = this.computeNextDue(new Date(task.dueDate), task.recurrence);
      const endDate = task.recurrenceEndDate ? new Date(task.recurrenceEndDate) : null;

      if (!endDate || nextDue <= endDate) {
        // Preserve the same reminder offset for the next occurrence
        let nextReminderAt: Date | null = null;
        if (task.reminderAt && task.dueDate) {
          const offsetMs = new Date(task.dueDate).getTime() - new Date(task.reminderAt).getTime();
          nextReminderAt = new Date(nextDue.getTime() - offsetMs);
        }

        await this.prisma.task.create({
          data: {
            userId: task.userId,
            title: task.title,
            description: task.description,
            status: TaskStatus.TODO,
            priority: task.priority,
            dueDate: nextDue,
            linkedMessageId: task.linkedMessageId,
            linkedSubject: task.linkedSubject,
            assignees: (task as any).assignees ?? [],
            recurrence: task.recurrence,
            recurrenceEndDate: task.recurrenceEndDate,
            reminderAt: nextReminderAt,
          },
        });
      }
    }

    return updated;
  }

  private computeNextDue(current: Date, recurrence: string): Date {
    const next = new Date(current);
    switch (recurrence) {
      case 'DAILY':   next.setDate(next.getDate() + 1); break;
      case 'WEEKLY':  next.setDate(next.getDate() + 7); break;
      case 'MONTHLY': next.setMonth(next.getMonth() + 1); break;
      case 'YEARLY':  next.setFullYear(next.getFullYear() + 1); break;
    }
    return next;
  }

  async remove(userId: string, id: string) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.userId !== userId) throw new ForbiddenException();

    await this.prisma.task.delete({ where: { id } });
    return { success: true };
  }

  // ─── Attachments ─────────────────────────────────────────────────────────────

  async addAttachments(
    userId: string,
    taskId: string,
    files: Express.Multer.File[],
  ) {
    const task = await this.verifyTaskOwnership(userId, taskId);
    const existing: AttachmentEntry[] = (task.attachments as unknown as AttachmentEntry[] | null) ?? [];

    if (existing.length + files.length > 5) {
      throw new BadRequestException('Maximum 5 attachments per task');
    }

    const newEntries: AttachmentEntry[] = files.map((f) => ({
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filename: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      data: f.buffer.toString('base64'),
    }));

    const merged = [...existing, ...newEntries];
    const updated = await this.prisma.task.update({
      where: { id: taskId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { attachments: merged as any },
    });

    // Return metadata without base64 data
    return {
      ...updated,
      attachments: (updated.attachments as unknown as AttachmentEntry[]).map(
        ({ data: _data, ...meta }) => meta,
      ),
    };
  }

  async deleteAttachment(userId: string, taskId: string, attachmentId: string) {
    const task = await this.verifyTaskOwnership(userId, taskId);
    const existing: AttachmentEntry[] = (task.attachments as unknown as AttachmentEntry[] | null) ?? [];
    const filtered = existing.filter((a) => a.id !== attachmentId);

    if (filtered.length === existing.length) {
      throw new NotFoundException('Attachment not found');
    }

    return this.prisma.task.update({
      where: { id: taskId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { attachments: filtered as any },
    });
  }

  async downloadAttachment(
    userId: string,
    taskId: string,
    attachmentId: string,
  ): Promise<{ filename: string; mimeType: string; buffer: Buffer }> {
    const task = await this.verifyTaskOwnership(userId, taskId);
    const entries: AttachmentEntry[] = (task.attachments as unknown as AttachmentEntry[] | null) ?? [];
    const entry = entries.find((a) => a.id === attachmentId);
    if (!entry) throw new NotFoundException('Attachment not found');

    return {
      filename: entry.filename,
      mimeType: entry.mimeType,
      buffer: Buffer.from(entry.data, 'base64'),
    };
  }

  // ─── Subtasks ───────────────────────────────────────────────────────────────

  private async verifyTaskOwnership(userId: string, taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.userId !== userId) throw new ForbiddenException();
    return task;
  }

  async createSubtask(userId: string, taskId: string, dto: CreateSubtaskDto) {
    await this.verifyTaskOwnership(userId, taskId);
    return this.prisma.subtask.create({
      data: { taskId, title: dto.title },
    });
  }

  async updateSubtask(
    userId: string,
    taskId: string,
    subtaskId: string,
    dto: UpdateSubtaskDto,
  ) {
    await this.verifyTaskOwnership(userId, taskId);
    const subtask = await this.prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!subtask || subtask.taskId !== taskId) throw new NotFoundException('Subtask not found');
    return this.prisma.subtask.update({
      where: { id: subtaskId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.completed !== undefined ? { completed: dto.completed } : {}),
      },
    });
  }

  async deleteSubtask(userId: string, taskId: string, subtaskId: string) {
    await this.verifyTaskOwnership(userId, taskId);
    const subtask = await this.prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!subtask || subtask.taskId !== taskId) throw new NotFoundException('Subtask not found');
    await this.prisma.subtask.delete({ where: { id: subtaskId } });
    return { success: true };
  }

  // ─── Comments ───────────────────────────────────────────────────────────────

  async createComment(userId: string, taskId: string, dto: CreateCommentDto) {
    await this.verifyTaskOwnership(userId, taskId);
    const user = await this.getUser(userId);
    return this.prisma.taskComment.create({
      data: {
        taskId,
        userId,
        authorName: user.displayName ?? user.email,
        authorEmail: user.email,
        body: dto.body,
      },
    });
  }

  async deleteComment(userId: string, taskId: string, commentId: string) {
    await this.verifyTaskOwnership(userId, taskId);
    const comment = await this.prisma.taskComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.taskId !== taskId) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId) throw new ForbiddenException();
    await this.prisma.taskComment.delete({ where: { id: commentId } });
    return { success: true };
  }

  async assign(
    userId: string,
    id: string,
    assignees: AssigneeDto[],
  ) {
    const user = await this.getUser(userId);
    if (!user.authToken) {
      throw new UnauthorizedException('Please log in again to connect to Zimbra.');
    }

    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.userId !== userId) throw new ForbiddenException();

    // Determine newly added assignees (not already on the task)
    const existing: AssigneeDto[] = ((task as any).assignees as AssigneeDto[] | null) ?? [];
    const existingEmails = new Set(existing.map((a) => a.email));
    const newAssignees = assignees.filter((a) => !existingEmails.has(a.email));

    const updated = await this.prisma.task.update({
      where: { id },
      data: { assignees: assignees as any },
    });

    // Send notification email to newly added assignees only
    if (!newAssignees.length) return updated;

    const assignorName = user.displayName ?? user.email;
    const dueDateStr = task.dueDate
      ? new Date(task.dueDate).toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : 'No due date';

    const priorityLabel: Record<string, string> = {
      LOW: 'Low',
      MEDIUM: 'Medium',
      HIGH: 'High',
      URGENT: 'Urgent',
    };

    await Promise.all(
      newAssignees.map(({ email, name }) => {
        const body = `
<html><body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;">
  <p>Hi${name ? ` ${name}` : ''},</p>
  <p>You have been assigned a task by <strong>${assignorName}</strong>.</p>
  <table style="border-collapse:collapse;width:100%;margin:16px 0;">
    <tr>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;background:#f9f9f9;font-weight:bold;width:120px;">Task</td>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;">${task.title}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;background:#f9f9f9;font-weight:bold;">Priority</td>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;">${priorityLabel[task.priority] ?? task.priority}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;background:#f9f9f9;font-weight:bold;">Due</td>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;">${dueDateStr}</td>
    </tr>
    ${task.description ? `
    <tr>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;background:#f9f9f9;font-weight:bold;">Description</td>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;">${task.description.replace(/\n/g, '<br>')}</td>
    </tr>` : ''}
    ${task.linkedSubject ? `
    <tr>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;background:#f9f9f9;font-weight:bold;">Related email</td>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;">${task.linkedSubject}</td>
    </tr>` : ''}
  </table>
  <p style="color:#888;font-size:12px;">Sent from 1Gov Mail.</p>
</body></html>`;

        return this.zimbra.sendMessage(
          user.zimbraHost,
          user.authToken!,
          {
            to: [email],
            subject: `Task assigned to you: ${task.title}`,
            body,
          },
          user.csrfToken ?? undefined,
        );
      }),
    );

    return updated;
  }
}

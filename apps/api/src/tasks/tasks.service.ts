import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { CreateTaskDto, TaskStatus } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';

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
    return this.prisma.task.findMany({
      where: {
        userId,
        ...(status ? { status: status as TaskStatus } : {}),
        ...(linkedMessageId ? { linkedMessageId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
    });
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
        assignedToEmail: dto.assignedToEmail,
        assignedToName: dto.assignedToName,
        assignedAt: dto.assignedToEmail ? new Date() : null,
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

    return this.prisma.task.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.dueDate !== undefined ? { dueDate: dto.dueDate ? new Date(dto.dueDate) : null } : {}),
        ...(dto.linkedMessageId !== undefined ? { linkedMessageId: dto.linkedMessageId } : {}),
        ...(dto.linkedSubject !== undefined ? { linkedSubject: dto.linkedSubject } : {}),
        ...(dto.assignedToEmail !== undefined ? { assignedToEmail: dto.assignedToEmail } : {}),
        ...(dto.assignedToName !== undefined ? { assignedToName: dto.assignedToName } : {}),
        ...(goingDone ? { completedAt: new Date() } : {}),
        ...(leavingDone ? { completedAt: null } : {}),
      },
    });
  }

  async remove(userId: string, id: string) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.userId !== userId) throw new ForbiddenException();

    await this.prisma.task.delete({ where: { id } });
    return { success: true };
  }

  async assign(
    userId: string,
    id: string,
    assigneeEmail: string,
    assigneeName?: string,
  ) {
    const user = await this.getUser(userId);
    if (!user.authToken) {
      throw new UnauthorizedException('Please log in again to connect to Zimbra.');
    }

    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.userId !== userId) throw new ForbiddenException();

    // Update assignment fields
    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        assignedToEmail: assigneeEmail,
        assignedToName: assigneeName ?? null,
        assignedAt: new Date(),
      },
    });

    // Send notification email via Zimbra
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

    const body = `
<html><body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;">
  <p>Hi${assigneeName ? ` ${assigneeName}` : ''},</p>
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

    await this.zimbra.sendMessage(
      user.zimbraHost,
      user.authToken,
      {
        to: [assigneeEmail],
        subject: `Task assigned to you: ${task.title}`,
        body,
      },
      user.csrfToken ?? undefined,
    );

    return updated;
  }
}

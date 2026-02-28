import { IsString, IsOptional, IsEnum, IsDateString, IsIn } from 'class-validator';
import { TaskStatus, TaskPriority } from './create-task.dto';

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  linkedMessageId?: string;

  @IsOptional()
  @IsString()
  linkedSubject?: string;

  @IsOptional()
  @IsString()
  assignedToEmail?: string;

  @IsOptional()
  @IsString()
  assignedToName?: string;

  @IsOptional()
  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
  recurrence?: string;

  @IsOptional()
  @IsDateString()
  recurrenceEndDate?: string;

  @IsOptional()
  @IsDateString()
  reminderAt?: string;
}

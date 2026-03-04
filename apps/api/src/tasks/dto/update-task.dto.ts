import { IsString, IsOptional, IsEnum, IsDateString, IsIn, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TaskStatus, TaskPriority, AssigneeDto } from './create-task.dto';

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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssigneeDto)
  assignees?: AssigneeDto[];

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

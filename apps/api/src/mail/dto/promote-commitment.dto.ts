import { IsOptional, IsString, IsDateString, IsIn } from 'class-validator';
import { TaskPriority } from '../../tasks/dto/create-task.dto';

/** All fields optional — an empty body preserves the promote endpoint's default
 * behavior (title/description derived from the commitment, no due date/priority). */
export class PromoteCommitmentDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
  priority?: TaskPriority;
}

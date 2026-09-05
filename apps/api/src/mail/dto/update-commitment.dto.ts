import { IsIn } from 'class-validator';

export class UpdateCommitmentDto {
  @IsIn(['done', 'dismissed', 'open'])
  status!: 'done' | 'dismissed' | 'open';
}

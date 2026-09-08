import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class DossierRequestDto {
  @IsEmail()
  email!: string;
}

export class MeetingPrepRequestDto {
  @IsString()
  @IsNotEmpty()
  eventId!: string;
}

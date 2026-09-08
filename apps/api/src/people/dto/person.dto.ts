import { IsEmail } from 'class-validator';

export class PersonDossierQueryDto {
  @IsEmail()
  email!: string;
}

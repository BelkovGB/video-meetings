import { Transform } from 'class-transformer';
import { IsDateString, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateMeetingDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsDateString()
  @Matches(/^(?:20\d{2}|2100)-/, {
    message: 'date year must be between 2000 and 2100',
  })
  date!: string;
}

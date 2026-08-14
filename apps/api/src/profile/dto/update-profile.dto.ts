import { Transform } from 'class-transformer';
import {
  IsString,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'isDisplayNameLength', async: false })
class IsDisplayNameLengthConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === 'string' && Array.from(value).length >= 1 && Array.from(value).length <= 100
    );
  }

  defaultMessage(): string {
    return 'displayName must contain between 1 and 100 Unicode characters';
  }
}

export class UpdateProfileDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Validate(IsDisplayNameLengthConstraint)
  displayName!: string;
}

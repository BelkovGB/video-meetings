import {
  IsNotEmpty,
  IsString,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const minimumPasswordLength = 9;
const maximumPasswordBytes = 72;

@ValidatorConstraint({ name: 'isNewPassword', async: false })
class IsNewPasswordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return (
      typeof value === 'string' &&
      Array.from(value).length >= minimumPasswordLength &&
      Buffer.byteLength(value, 'utf8') <= maximumPasswordBytes
    );
  }

  defaultMessage() {
    return `newPassword must contain at least ${minimumPasswordLength} characters and no more than ${maximumPasswordBytes} UTF-8 bytes`;
  }
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @Validate(IsNewPasswordConstraint)
  newPassword!: string;

  @IsString()
  @IsNotEmpty()
  confirmation!: string;
}

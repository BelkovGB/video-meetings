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
    if (typeof value !== 'string') {
      return false;
    }

    const normalizedValue = value.normalize('NFC');
    return (
      Array.from(normalizedValue).length >= minimumPasswordLength &&
      Buffer.byteLength(normalizedValue, 'utf8') <= maximumPasswordBytes
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

import { Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

import { AuthCredentialsDto } from './auth-credentials.dto';

const minimumPasswordLength = 9;
const maximumPasswordBytes = 72;

@ValidatorConstraint({ name: 'isRegistrationPassword', async: false })
class IsRegistrationPasswordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return (
      typeof value === 'string' &&
      Array.from(value).length >= minimumPasswordLength &&
      Buffer.byteLength(value, 'utf8') <= maximumPasswordBytes
    );
  }

  defaultMessage() {
    return `password must contain at least ${minimumPasswordLength} characters and no more than ${maximumPasswordBytes} UTF-8 bytes`;
  }
}

export class RegisterCredentialsDto extends AuthCredentialsDto {
  @Validate(IsRegistrationPasswordConstraint)
  declare password: string;
}

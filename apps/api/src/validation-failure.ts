import { BadRequestException, HttpStatus } from '@nestjs/common';
import { ValidationError } from 'class-validator';

/** A rejected property, addressed by the dotted path a request body uses. */
type FlatValidationError = { path: string; messages: string[] };

/**
 * Flattens `@ValidateNested` errors the way Nest's own exception factory does:
 * a parent carries `children` instead of `constraints`, so reading one level
 * deep would answer an empty `message` and name only the parent.
 */
function flatten(errors: ValidationError[], parentPath = ''): FlatValidationError[] {
  return errors.flatMap((error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const children = flatten(error.children ?? [], path);
    const messages = Object.values(error.constraints ?? {});

    // A parent that only groups rejected children contributes no message of its
    // own, and naming it would route a client to a property that is fine.
    return messages.length > 0 || children.length === 0
      ? [{ path, messages }, ...children]
      : children;
  });
}

/**
 * Names the rejected properties next to a stable `code`, so a client can route
 * a validation failure to its field without matching the English `message`.
 * Rewording a constraint message must not silently stop that routing.
 */
export function validationFailure(errors: ValidationError[]): BadRequestException {
  const rejected = flatten(errors);

  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    message: rejected.flatMap((error) => error.messages),
    error: 'Bad Request',
    code: 'VALIDATION_FAILED',
    fields: rejected.map((error) => error.path),
  });
}

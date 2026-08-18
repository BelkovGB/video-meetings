import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsString, Length, ValidateNested } from 'class-validator';

import { validationFailure } from '../src/validation-failure';

/**
 * The `VALIDATION_FAILED` body every endpoint rejects with.
 *
 * Replacing Nest's default exception factory took over its flattening of nested
 * errors, whose failure would be silent and global: a parent `ValidationError`
 * carries `children` rather than `constraints`, so reading one level deep would
 * answer `message: []` and name only the parent in `fields`. Every client then
 * degrades at once, with nothing failing to say so.
 */

class ScheduleDto {
  @IsString()
  @Length(1, 10)
  timezone!: string;
}

class MeetingDto {
  @IsString()
  @Length(1, 5)
  title!: string;

  @ValidateNested()
  @Type(() => ScheduleDto)
  schedule!: ScheduleDto;
}

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: validationFailure,
});

async function rejectionOf(body: unknown): Promise<BadRequestException> {
  const rejection = await pipe
    .transform(body, { type: 'body', metatype: MeetingDto })
    .then(() => null)
    .catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(BadRequestException);
  return rejection as BadRequestException;
}

it('names a rejected top-level property and returns its constraint message', async () => {
  const rejection = await rejectionOf({ title: 'far too long', schedule: { timezone: 'Europe' } });

  expect(rejection.getResponse()).toEqual({
    statusCode: 400,
    message: [expect.stringContaining('title')],
    error: 'Bad Request',
    code: 'VALIDATION_FAILED',
    fields: ['title'],
  });
});

it('flattens a nested rejection into a dotted path and keeps its child constraint message', async () => {
  const rejection = await rejectionOf({ title: 'ok', schedule: { timezone: '' } });

  expect(rejection.getResponse()).toEqual({
    statusCode: 400,
    message: [expect.stringContaining('timezone')],
    error: 'Bad Request',
    code: 'VALIDATION_FAILED',
    fields: ['schedule.timezone'],
  });
});

it('reports a parent and a child rejection side by side', async () => {
  const rejection = await rejectionOf({ title: 'far too long', schedule: { timezone: '' } });

  expect(rejection.getResponse()).toMatchObject({
    code: 'VALIDATION_FAILED',
    fields: ['title', 'schedule.timezone'],
  });
  expect((rejection.getResponse() as { message: string[] }).message).toHaveLength(2);
});

it('names a property that is rejected as a whole rather than through a child', async () => {
  const rejection = await rejectionOf({ title: 'ok', schedule: 'not an object' });

  expect(rejection.getResponse()).toMatchObject({
    code: 'VALIDATION_FAILED',
    fields: ['schedule'],
  });
});

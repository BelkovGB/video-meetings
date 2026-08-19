import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MeetingUploaderAvatarService } from './services/meeting-uploader-avatar.service';

/**
 * Reads a `uploadedBy.handle` from the meeting-file representation, so one
 * uploader has one avatar URL per meeting however many files they uploaded.
 * The route is not under `files` for that reason: its subject is the uploader
 * within the meeting, not a single file.
 */
@Controller('meetings/:meetingId/uploaders')
@UseGuards(JwtAuthGuard)
export class MeetingUploadersController {
  constructor(private readonly uploaderAvatars: MeetingUploaderAvatarService) {}

  @Get(':uploaderHandle/avatar')
  async getAvatar(
    @Param('meetingId') meetingId: string,
    @Param('uploaderHandle') uploaderHandle: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    // Set before anything below can throw. Every failure path of this route is
    // `404`, which is heuristically cacheable, and the route deliberately makes
    // this URL cache-eligible otherwise; without these a shared cache could
    // store the outsider's denial and replay it to an actual participant.
    // The response body depends on the meeting, not on the caller, but the
    // permission to read it does; `Vary` keeps any cache that ignores `private`
    // from handing it to a caller outside the meeting.
    response.set({
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    varyOnAuthorization(response);

    const version = await this.uploaderAvatars.describe(
      meetingId,
      uploaderHandle,
      request.user.sub,
    );

    if (matchesEntityTag(request.headers['if-none-match'], version.etag)) {
      allowRevalidatedReuse(response, version.etag);
      response.status(HttpStatus.NOT_MODIFIED);

      return undefined;
    }

    // Opened before the validator is published: `open` still answers `404` when
    // the avatar row or its stored object disappears between the two calls, and
    // an error body must never ship labelled with the image's `ETag` — a client
    // would revalidate it successfully and keep serving the error as the image.
    const avatar = await this.uploaderAvatars.open(version.uploaderId);

    // The opened avatar's own tag, not `describe`'s: a replacement in the window
    // between the two reads would otherwise label these bytes with the previous
    // version, leaving the client a cache entry its validator misdescribes.
    allowRevalidatedReuse(response, avatar.etag);
    response.set({
      'Content-Length': String(avatar.sizeBytes),
      'Content-Type': avatar.mimeType,
    });

    return new StreamableFile(avatar.stream);
  }
}

/**
 * Replaces the route's `no-store` default once there is a real avatar version to
 * revalidate against. `max-age=0` is explicit because `must-revalidate` alone
 * constrains reuse only after an entry is already stale, and a response with no
 * stated lifetime may be assigned a heuristic one (RFC 9111 4.2.2) — a replaced
 * or removed avatar could then keep rendering unchecked. Revalidation is cheap
 * here: the 304 path opens no file.
 */
function allowRevalidatedReuse(response: Response, etag: string): void {
  response.set({ 'Cache-Control': 'private, max-age=0, must-revalidate', ETag: etag });
  varyOnAuthorization(response);
}

/**
 * `response.set` writes a header field whole, so naming `Vary` there would drop
 * the `Origin` the CORS layer already appended — and this route is the one that
 * made this URL cache-eligible, so a short `Vary` is exactly the hazard it must
 * not introduce. Express's `vary` helper appends instead, and is idempotent, so
 * every exit of the route may call it.
 */
function varyOnAuthorization(response: Response): void {
  response.vary('Authorization');
}

function matchesEntityTag(header: string | undefined, etag: string): boolean {
  if (!header) {
    return false;
  }
  if (header.trim() === '*') {
    return true;
  }

  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(etag);
}

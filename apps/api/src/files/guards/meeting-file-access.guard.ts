import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { MeetingAccessService } from '../services/meeting-access.service';

@Injectable()
export class MeetingFileAccessGuard implements CanActivate {
  constructor(private readonly meetingAccess: MeetingAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const meetingId = Array.isArray(request.params.meetingId)
      ? request.params.meetingId[0]
      : request.params.meetingId;
    await this.meetingAccess.requireAccess(meetingId, request.user.sub);

    return true;
  }
}

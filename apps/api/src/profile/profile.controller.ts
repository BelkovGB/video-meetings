import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  getCurrentProfile(@Req() request: AuthenticatedRequest) {
    return this.profileService.getCurrentProfile(request.user.sub);
  }

  @Patch()
  updateCurrentProfile(
    @Body() updateProfileDto: UpdateProfileDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.profileService.updateCurrentProfile(request.user.sub, updateProfileDto.displayName);
  }
}

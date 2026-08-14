import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

const profileSelect = {
  id: true,
  email: true,
  displayName: true,
} as const;

export type Profile = {
  id: string;
  email: string;
  displayName: string | null;
};

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentProfile(userId: string): Promise<Profile> {
    const profile = await this.prisma.user.findUnique({
      where: { id: userId },
      select: profileSelect,
    });

    if (!profile) {
      throw new NotFoundException('User not found');
    }

    return profile;
  }

  async updateCurrentProfile(userId: string, displayName: string): Promise<Profile> {
    await this.getCurrentProfile(userId);

    return this.prisma.user.update({
      where: { id: userId },
      data: { displayName },
      select: profileSelect,
    });
  }
}

import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { MeetingSummaryStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * Flips summary jobs left PROCESSING by an unclean previous process exit to
 * an error state. A single in-process runner cannot leave a job PROCESSING
 * any other way, so this only needs to run once at boot.
 */
@Injectable()
export class MeetingSummaryReconciliationService implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.prisma.meetingSummary.updateMany({
      where: { status: MeetingSummaryStatus.PROCESSING },
      data: {
        status: MeetingSummaryStatus.FAILED,
        failureCode: 'INTERRUPTED',
        finishedAt: new Date(),
      },
    });
  }
}

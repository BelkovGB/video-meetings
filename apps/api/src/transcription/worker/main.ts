import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { transcriptionConfig } from '../transcription.config';
import { TranscriptionWorker } from './transcription-worker';
import { TranscriptionWorkerModule } from './transcription-worker.module';

async function bootstrap(): Promise<void> {
  if (!transcriptionConfig.command) {
    throw new Error('TRANSCRIPTION_COMMAND must be set to the recognition executable');
  }

  const context = await NestFactory.createApplicationContext(TranscriptionWorkerModule);
  const worker = context.get(TranscriptionWorker);
  const logger = new Logger('TranscriptionWorkerProcess');
  let shuttingDown = false;

  const shutDown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.log(`Stopping on ${signal}, finishing the job in flight`);
    await worker.stop();
    await context.close();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutDown(signal).catch((error: unknown) => {
        logger.error(
          'Failed to stop the transcription worker',
          error instanceof Error ? error.stack : undefined,
        );
        process.exitCode = 1;
      });
    });
  }

  worker.run();
  logger.log('Transcription worker started');
}

void bootstrap();

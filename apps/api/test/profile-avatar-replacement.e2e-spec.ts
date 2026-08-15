import { AvatarValidationService } from '../src/profile/avatar-validation.service';
import { LocalAvatarStorageService } from '../src/profile/local-avatar-storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProfileService } from '../src/profile/profile.service';

describe('ProfileService avatar replacement', () => {
  const userId = 'user-id';
  const existingStorageKey = 'existing-avatar';
  const file = { path: 'temporary-avatar.part' } as Express.Multer.File;
  const avatar = { mimeType: 'image/png', sizeBytes: 123 };

  function createService(options?: { finalizeError?: Error; updateError?: Error }) {
    const prisma: any = {};
    Object.assign(prisma, {
      $transaction: jest.fn(async (operation: (client: typeof prisma) => unknown) =>
        operation(prisma),
      ),
      $executeRaw: jest.fn().mockResolvedValue(1),
      user: {
        findUnique: jest.fn().mockResolvedValue({ avatarStorageKey: existingStorageKey }),
        update: options?.updateError
          ? jest.fn().mockRejectedValue(options.updateError)
          : jest.fn().mockResolvedValue(undefined),
      },
      avatarStorageReservation: {
        create: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    });
    const avatars = {
      finalize: options?.finalizeError
        ? jest.fn().mockRejectedValue(options.finalizeError)
        : jest.fn().mockResolvedValue(undefined),
      discard: jest.fn().mockResolvedValue(undefined),
      discardEventually: jest.fn(async (storageKey: string | null) => {
        try {
          await avatars.discard(storageKey);
        } catch {
          // The storage service queues retryable deletion failures.
        }
      }),
      discardTemp: jest.fn().mockResolvedValue(undefined),
    };
    const validation = { validate: jest.fn().mockResolvedValue(avatar) };

    return {
      service: new ProfileService(
        prisma as unknown as PrismaService,
        avatars as unknown as LocalAvatarStorageService,
        validation as unknown as AvatarValidationService,
      ),
      prisma,
      avatars,
    };
  }

  it('keeps the previous avatar when retaining the replacement fails', async () => {
    const storageError = new Error('storage unavailable');
    const { service, prisma, avatars } = createService({ finalizeError: storageError });

    await expect(service.uploadAvatar(userId, file)).rejects.toThrow(storageError);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(avatars.discard).not.toHaveBeenCalledWith(existingStorageKey);
    expect(prisma.avatarStorageReservation.delete).not.toHaveBeenCalled();
    expect(avatars.discardTemp).toHaveBeenCalledWith(file.path);
  });

  it('keeps the previous avatar and removes the retained replacement when persistence fails', async () => {
    const persistenceError = new Error('database unavailable');
    const { service, prisma, avatars } = createService({ updateError: persistenceError });

    await expect(service.uploadAvatar(userId, file)).rejects.toThrow(persistenceError);

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(avatars.discard).toHaveBeenCalledWith(expect.any(String));
    expect(avatars.discard).not.toHaveBeenCalledWith(existingStorageKey);
    expect(prisma.avatarStorageReservation.delete).not.toHaveBeenCalled();
    expect(avatars.discardTemp).toHaveBeenCalledWith(file.path);
  });

  it('does not fail a successful replacement when deleting the superseded avatar is transiently unavailable', async () => {
    const { service, avatars } = createService();
    avatars.discard.mockRejectedValueOnce(new Error('storage temporarily unavailable'));

    await expect(service.uploadAvatar(userId, file)).resolves.toMatchObject(avatar);

    expect(avatars.discard).toHaveBeenCalledWith(existingStorageKey);
    expect(avatars.discardTemp).toHaveBeenCalledWith(file.path);
  });

  it('keeps a durable reservation while the finalized replacement awaits its database reference', async () => {
    const { service, prisma, avatars } = createService();

    await expect(service.uploadAvatar(userId, file)).resolves.toMatchObject(avatar);

    expect(prisma.avatarStorageReservation.create).toHaveBeenCalledWith({
      data: { storageKey: expect.any(String) },
    });
    expect(prisma.avatarStorageReservation.create.mock.invocationCallOrder[0]).toBeLessThan(
      avatars.finalize.mock.invocationCallOrder[0],
    );
    expect(prisma.avatarStorageReservation.delete.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.user.update.mock.invocationCallOrder[0],
    );
  });

  it('serializes replacements for the same user so every superseded avatar is discarded', async () => {
    let releaseFirstFinalize: (() => void) | undefined;
    const firstFinalizeStarted = new Promise<void>((resolve) => {
      releaseFirstFinalize = resolve;
    });
    let continueFirstFinalize: (() => void) | undefined;
    const firstFinalizeCanFinish = new Promise<void>((resolve) => {
      continueFirstFinalize = resolve;
    });
    let transactionTail: Promise<unknown> = Promise.resolve();
    const prisma: any = {};
    Object.assign(prisma, {
      $transaction: jest.fn((operation: (client: typeof prisma) => Promise<unknown>) => {
        const result = transactionTail.then(() => operation(prisma));
        transactionTail = result.catch(() => undefined);
        return result;
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ avatarStorageKey: existingStorageKey })
          .mockResolvedValueOnce({ avatarStorageKey: 'first-avatar' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      avatarStorageReservation: {
        create: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    });
    const avatars = {
      finalize: jest.fn(async () => {
        if (avatars.finalize.mock.calls.length === 1) {
          releaseFirstFinalize?.();
          await firstFinalizeCanFinish;
        }
      }),
      discard: jest.fn().mockResolvedValue(undefined),
      discardEventually: jest.fn(async (storageKey: string | null) => {
        try {
          await avatars.discard(storageKey);
        } catch {
          // The storage service queues retryable deletion failures.
        }
      }),
      discardTemp: jest.fn().mockResolvedValue(undefined),
    };
    const firstService = new ProfileService(
      prisma as unknown as PrismaService,
      avatars as unknown as LocalAvatarStorageService,
      { validate: jest.fn().mockResolvedValue(avatar) } as unknown as AvatarValidationService,
    );
    const secondService = new ProfileService(
      prisma as unknown as PrismaService,
      avatars as unknown as LocalAvatarStorageService,
      { validate: jest.fn().mockResolvedValue(avatar) } as unknown as AvatarValidationService,
    );

    const first = firstService.uploadAvatar(userId, { ...file, path: 'first.part' });
    await firstFinalizeStarted;
    const second = secondService.uploadAvatar(userId, { ...file, path: 'second.part' });

    await new Promise((resolve) => setImmediate(resolve));
    expect(avatars.finalize).toHaveBeenCalledTimes(1);

    continueFirstFinalize?.();
    await Promise.all([first, second]);

    expect(avatars.discard).toHaveBeenCalledWith(existingStorageKey);
    expect(avatars.discard).toHaveBeenCalledWith('first-avatar');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
  });
});

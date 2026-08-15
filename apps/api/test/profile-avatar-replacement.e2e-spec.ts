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
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ avatarStorageKey: existingStorageKey }),
        update: options?.updateError
          ? jest.fn().mockRejectedValue(options.updateError)
          : jest.fn().mockResolvedValue(undefined),
      },
    };
    const avatars = {
      finalize: options?.finalizeError
        ? jest.fn().mockRejectedValue(options.finalizeError)
        : jest.fn().mockResolvedValue(undefined),
      discard: jest.fn().mockResolvedValue(undefined),
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
    expect(avatars.discard).not.toHaveBeenCalledWith(existingStorageKey);
    expect(avatars.discardTemp).toHaveBeenCalledWith(file.path);
  });

  it('keeps the previous avatar and removes the retained replacement when persistence fails', async () => {
    const persistenceError = new Error('database unavailable');
    const { service, prisma, avatars } = createService({ updateError: persistenceError });

    await expect(service.uploadAvatar(userId, file)).rejects.toThrow(persistenceError);

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(avatars.discard).toHaveBeenCalledWith(expect.any(String));
    expect(avatars.discard).not.toHaveBeenCalledWith(existingStorageKey);
    expect(avatars.discardTemp).toHaveBeenCalledWith(file.path);
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
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ avatarStorageKey: existingStorageKey })
          .mockResolvedValueOnce({ avatarStorageKey: 'first-avatar' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const avatars = {
      finalize: jest.fn(async () => {
        if (avatars.finalize.mock.calls.length === 1) {
          releaseFirstFinalize?.();
          await firstFinalizeCanFinish;
        }
      }),
      discard: jest.fn().mockResolvedValue(undefined),
      discardTemp: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ProfileService(
      prisma as unknown as PrismaService,
      avatars as unknown as LocalAvatarStorageService,
      { validate: jest.fn().mockResolvedValue(avatar) } as unknown as AvatarValidationService,
    );

    const first = service.uploadAvatar(userId, { ...file, path: 'first.part' });
    await firstFinalizeStarted;
    const second = service.uploadAvatar(userId, { ...file, path: 'second.part' });

    await new Promise((resolve) => setImmediate(resolve));
    expect(avatars.finalize).toHaveBeenCalledTimes(1);

    continueFirstFinalize?.();
    await Promise.all([first, second]);

    expect(avatars.discard).toHaveBeenCalledWith(existingStorageKey);
    expect(avatars.discard).toHaveBeenCalledWith('first-avatar');
  });
});

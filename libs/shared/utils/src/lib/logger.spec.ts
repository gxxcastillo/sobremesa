import { describe, it, expect, vi } from 'vitest';
import { logBestEffort } from './logger';

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('logBestEffort', () => {
  it('runs fn and does not log when it succeeds', async () => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    const fn = vi.fn().mockResolvedValue('ok');

    await logBestEffort(
      mockLogger as any,
      fn,
      { id: '1' },
      'should not appear',
    );

    expect(fn).toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('catches a thrown error and logs at warn level by default, without rethrowing', async () => {
    mockLogger.warn.mockClear();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      logBestEffort(mockLogger as any, fn, { id: '1' }, 'it broke'),
    ).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { id: '1', error: expect.any(Error) },
      'it broke',
    );
  });

  it('logs at the requested level instead of warn when specified', async () => {
    mockLogger.error.mockClear();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await logBestEffort(
      mockLogger as any,
      fn,
      { id: '2' },
      'it really broke',
      'error',
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      { id: '2', error: expect.any(Error) },
      'it really broke',
    );
  });

  it('never rethrows, regardless of what fn throws', async () => {
    const fn = vi.fn().mockImplementation(() => {
      throw 'a non-Error throw';
    });

    await expect(
      logBestEffort(mockLogger as any, fn, {}, 'message'),
    ).resolves.toBeUndefined();
  });
});

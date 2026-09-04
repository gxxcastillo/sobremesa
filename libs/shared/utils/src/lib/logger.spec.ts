import { describe, it, expect, vi, afterEach } from 'vitest';
import { logBestEffort, resolveSessionLogPath } from './logger';

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

describe('resolveSessionLogPath', () => {
  const ORIGINAL = {
    NODE_ENV: process.env['NODE_ENV'],
    SESSION_LOG: process.env['SESSION_LOG'],
    SESSION_LOG_PATH: process.env['SESSION_LOG_PATH'],
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('never enables in production, even with SESSION_LOG set', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SESSION_LOG'] = '1';

    expect(resolveSessionLogPath()).toBeUndefined();
  });

  it('is disabled by default outside production', () => {
    delete process.env['NODE_ENV'];
    delete process.env['SESSION_LOG'];

    expect(resolveSessionLogPath()).toBeUndefined();
  });

  it('treats "0" and "false" as disabled', () => {
    delete process.env['NODE_ENV'];
    process.env['SESSION_LOG'] = '0';
    expect(resolveSessionLogPath()).toBeUndefined();

    process.env['SESSION_LOG'] = 'false';
    expect(resolveSessionLogPath()).toBeUndefined();
  });

  it('honors an explicit SESSION_LOG_PATH override', () => {
    delete process.env['NODE_ENV'];
    process.env['SESSION_LOG'] = '1';
    process.env['SESSION_LOG_PATH'] = '/tmp/my-session.log';

    expect(resolveSessionLogPath()).toBe('/tmp/my-session.log');
  });

  it('defaults to a path under tmp/session-logs', () => {
    delete process.env['NODE_ENV'];
    process.env['SESSION_LOG'] = '1';
    delete process.env['SESSION_LOG_PATH'];

    const path = resolveSessionLogPath();
    expect(path).toMatch(/tmp[/\\]session-logs[/\\]session-.*\.db$/);
  });
});

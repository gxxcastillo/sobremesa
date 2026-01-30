import { describe, it, expect } from 'vitest';
import {
  verifyTelegramLogin,
  parseTelegramLoginParams,
  buildDisplayName,
} from './telegram-verify';
import type { TelegramLoginData } from './types';

describe('telegram-verify', () => {
  describe('verifyTelegramLogin', () => {
    const MOCK_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

    it('should verify valid Telegram login data', () => {
      // This is a real example from Telegram docs (modified)
      const validData: TelegramLoginData = {
        id: 123456789,
        first_name: 'John',
        last_name: 'Doe',
        username: 'johndoe',
        photo_url: 'https://t.me/i/userpic/320/johndoe.jpg',
        auth_date: Math.floor(Date.now() / 1000) - 60, // 1 minute ago
        hash: 'mock-hash', // Will be replaced with actual hash
      };

      // For testing, we'll use the actual verification logic
      // In a real test, you'd use a known valid hash
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { hash, ...dataWithoutHash } = validData;
      const dataCheckString = Object.keys(dataWithoutHash)
        .sort()
        .map(
          (key) =>
            `${key}=${dataWithoutHash[key as keyof typeof dataWithoutHash]}`,
        )
        .join('\n');

      const { createHash, createHmac } = require('crypto');
      const secretKey = createHash('sha256').update(MOCK_BOT_TOKEN).digest();
      const calculatedHash = createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      validData.hash = calculatedHash;

      const result = verifyTelegramLogin(validData, MOCK_BOT_TOKEN);
      expect(result).toBe(true);
    });

    it('should reject data with invalid hash', () => {
      const invalidData: TelegramLoginData = {
        id: 123456789,
        first_name: 'John',
        auth_date: Math.floor(Date.now() / 1000),
        hash: 'invalid-hash',
      };

      const result = verifyTelegramLogin(invalidData, MOCK_BOT_TOKEN);
      expect(result).toBe(false);
    });

    it('should reject expired data (older than 24 hours)', () => {
      const expiredData: TelegramLoginData = {
        id: 123456789,
        first_name: 'John',
        auth_date: Math.floor(Date.now() / 1000) - 86401, // 24 hours + 1 second ago
        hash: 'some-hash',
      };

      const result = verifyTelegramLogin(expiredData, MOCK_BOT_TOKEN);
      expect(result).toBe(false);
    });

    it('should accept data within 24 hour window', () => {
      const recentData: TelegramLoginData = {
        id: 123456789,
        first_name: 'John',
        auth_date: Math.floor(Date.now() / 1000) - 86399, // Just under 24 hours
        hash: 'mock-hash',
      };

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { hash, ...dataWithoutHash } = recentData;
      const dataCheckString = Object.keys(dataWithoutHash)
        .sort()
        .map(
          (key) =>
            `${key}=${dataWithoutHash[key as keyof typeof dataWithoutHash]}`,
        )
        .join('\n');

      const { createHash, createHmac } = require('crypto');
      const secretKey = createHash('sha256').update(MOCK_BOT_TOKEN).digest();
      const calculatedHash = createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      recentData.hash = calculatedHash;

      const result = verifyTelegramLogin(recentData, MOCK_BOT_TOKEN);
      expect(result).toBe(true);
    });
  });

  describe('parseTelegramLoginParams', () => {
    it('should parse valid URLSearchParams with all fields', () => {
      const params = new URLSearchParams({
        id: '123456789',
        first_name: 'John',
        last_name: 'Doe',
        username: 'johndoe',
        photo_url: 'https://t.me/i/userpic/320/johndoe.jpg',
        auth_date: '1234567890',
        hash: 'abc123',
      });

      const result = parseTelegramLoginParams(params);

      expect(result).toEqual({
        id: 123456789,
        first_name: 'John',
        last_name: 'Doe',
        username: 'johndoe',
        photo_url: 'https://t.me/i/userpic/320/johndoe.jpg',
        auth_date: 1234567890,
        hash: 'abc123',
      });
    });

    it('should parse params with only required fields', () => {
      const params = new URLSearchParams({
        id: '123456789',
        first_name: 'John',
        auth_date: '1234567890',
        hash: 'abc123',
      });

      const result = parseTelegramLoginParams(params);

      expect(result).toEqual({
        id: 123456789,
        first_name: 'John',
        auth_date: 1234567890,
        hash: 'abc123',
      });
    });

    it('should return null if missing required field (id)', () => {
      const params = new URLSearchParams({
        first_name: 'John',
        auth_date: '1234567890',
        hash: 'abc123',
      });

      const result = parseTelegramLoginParams(params);
      expect(result).toBeNull();
    });

    it('should return null if missing required field (first_name)', () => {
      const params = new URLSearchParams({
        id: '123456789',
        auth_date: '1234567890',
        hash: 'abc123',
      });

      const result = parseTelegramLoginParams(params);
      expect(result).toBeNull();
    });

    it('should return null if missing required field (auth_date)', () => {
      const params = new URLSearchParams({
        id: '123456789',
        first_name: 'John',
        hash: 'abc123',
      });

      const result = parseTelegramLoginParams(params);
      expect(result).toBeNull();
    });

    it('should return null if missing required field (hash)', () => {
      const params = new URLSearchParams({
        id: '123456789',
        first_name: 'John',
        auth_date: '1234567890',
      });

      const result = parseTelegramLoginParams(params);
      expect(result).toBeNull();
    });

    it('should return null if id is not a valid number', () => {
      const params = new URLSearchParams({
        id: 'not-a-number',
        first_name: 'John',
        auth_date: '1234567890',
        hash: 'abc123',
      });

      const result = parseTelegramLoginParams(params);
      expect(result).toBeNull();
    });

    it('should return null if auth_date is not a valid number', () => {
      const params = new URLSearchParams({
        id: '123456789',
        first_name: 'John',
        auth_date: 'not-a-number',
        hash: 'abc123',
      });

      const result = parseTelegramLoginParams(params);
      expect(result).toBeNull();
    });
  });

  describe('buildDisplayName', () => {
    it('should build display name from first and last name', () => {
      const data: TelegramLoginData = {
        id: 123,
        first_name: 'John',
        last_name: 'Doe',
        auth_date: 1234567890,
        hash: 'abc',
      };

      const result = buildDisplayName(data);
      expect(result).toBe('John Doe');
    });

    it('should build display name from first name only', () => {
      const data: TelegramLoginData = {
        id: 123,
        first_name: 'John',
        auth_date: 1234567890,
        hash: 'abc',
      };

      const result = buildDisplayName(data);
      expect(result).toBe('John');
    });

    it('should handle username if provided', () => {
      const data: TelegramLoginData = {
        id: 123,
        first_name: 'John',
        username: 'johndoe',
        auth_date: 1234567890,
        hash: 'abc',
      };

      const result = buildDisplayName(data);
      // Function should return first_name (maybe with last_name), not username
      // Adjust based on actual implementation
      expect(result).toBe('John');
    });
  });
});

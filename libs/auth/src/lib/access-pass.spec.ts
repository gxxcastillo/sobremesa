import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, validateAccessPass } from './access-pass';
import type { AccessPass } from './types';

describe('access-pass', () => {
  describe('generateToken', () => {
    it('should generate a 64-character hex string', () => {
      const token = generateToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate unique tokens', () => {
      const token1 = generateToken();
      const token2 = generateToken();
      expect(token1).not.toBe(token2);
    });

    it('should generate cryptographically secure tokens', () => {
      // Generate multiple tokens and ensure they're all different
      const tokens = new Set();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateToken());
      }
      expect(tokens.size).toBe(100);
    });
  });

  describe('hashToken', () => {
    it('should hash a token using SHA-256', () => {
      const token = 'test-token-123';
      const hash = hashToken(token);

      // SHA-256 produces a 64-character hex string
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce consistent hashes for the same input', () => {
      const token = 'consistent-token';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = hashToken('token1');
      const hash2 = hashToken('token2');
      expect(hash1).not.toBe(hash2);
    });

    it('should be case-sensitive', () => {
      const hash1 = hashToken('Token');
      const hash2 = hashToken('token');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('validateAccessPass', () => {
    it('should validate a pending, non-expired pass', () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
      const pass: AccessPass = {
        id: 'test-id',
        tokenHash: 'hash',
        familyId: 'family-id',
        role: 'member',
        provider: 'telegram',
        providerUserId: '123',
        identityId: null,
        chatId: 'chat-123',
        expiresAt: futureDate,
        status: 'pending',
        createdAt: new Date(),
        redeemedAt: null,
        redeemedByIdentityId: null,
      };

      const result = validateAccessPass(pass);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject an expired pass (by date)', () => {
      const pastDate = new Date(Date.now() - 1000); // 1 second ago
      const pass: AccessPass = {
        id: 'test-id',
        tokenHash: 'hash',
        familyId: 'family-id',
        role: 'member',
        provider: 'telegram',
        providerUserId: '123',
        identityId: null,
        chatId: 'chat-123',
        expiresAt: pastDate,
        status: 'pending',
        createdAt: new Date(),
        redeemedAt: null,
        redeemedByIdentityId: null,
      };

      const result = validateAccessPass(pass);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('This access pass has expired');
    });

    it('should reject a redeemed pass', () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pass: AccessPass = {
        id: 'test-id',
        tokenHash: 'hash',
        familyId: 'family-id',
        role: 'member',
        provider: 'telegram',
        providerUserId: '123',
        identityId: 'identity-id',
        chatId: 'chat-123',
        expiresAt: futureDate,
        status: 'redeemed',
        createdAt: new Date(),
        redeemedAt: new Date(),
        redeemedByIdentityId: 'identity-id',
      };

      const result = validateAccessPass(pass);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('This access pass has already been used');
    });

    it('should reject an expired pass (by status)', () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pass: AccessPass = {
        id: 'test-id',
        tokenHash: 'hash',
        familyId: 'family-id',
        role: 'member',
        provider: 'telegram',
        providerUserId: '123',
        identityId: null,
        chatId: 'chat-123',
        expiresAt: futureDate,
        status: 'expired',
        createdAt: new Date(),
        redeemedAt: null,
        redeemedByIdentityId: null,
      };

      const result = validateAccessPass(pass);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('This access pass has expired');
    });

    it('should reject a revoked pass', () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const pass: AccessPass = {
        id: 'test-id',
        tokenHash: 'hash',
        familyId: 'family-id',
        role: 'member',
        provider: 'telegram',
        providerUserId: '123',
        identityId: null,
        chatId: 'chat-123',
        expiresAt: futureDate,
        status: 'revoked',
        createdAt: new Date(),
        redeemedAt: null,
        redeemedByIdentityId: null,
      };

      const result = validateAccessPass(pass);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('This access pass has been revoked');
    });

    it('should handle edge case: pass expiring 1 millisecond in the future', () => {
      const almostExpired = new Date(Date.now() + 1); // 1ms in the future
      const pass: AccessPass = {
        id: 'test-id',
        tokenHash: 'hash',
        familyId: 'family-id',
        role: 'member',
        provider: 'telegram',
        providerUserId: '123',
        identityId: null,
        chatId: 'chat-123',
        expiresAt: almostExpired,
        status: 'pending',
        createdAt: new Date(),
        redeemedAt: null,
        redeemedByIdentityId: null,
      };

      // Should still be valid (not yet expired)
      const result = validateAccessPass(pass);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});

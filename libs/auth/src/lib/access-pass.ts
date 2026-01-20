/**
 * Access Pass generation and validation
 *
 * Access passes are one-time tokens that allow chat users to
 * authenticate with the Studio web app. They are generated via
 * chat commands (e.g., /sobremesa studio-link) and sent via DM.
 */

import { createHash, randomBytes } from 'crypto';
import type {
  AccessPass,
  CreateAccessPassInput,
  CreateAccessPassResult,
  FamilyRole,
} from './types';
import { getServiceClient } from '@sobremesa/database';
import { mapRowToCamelCase } from '@sobremesa/database';

/**
 * Default expiry time for access passes (24 hours)
 */
const DEFAULT_EXPIRY_HOURS = 24;

/**
 * Token length in bytes (32 bytes = 64 hex chars)
 */
const TOKEN_LENGTH = 32;

/**
 * Generate a cryptographically secure random token
 */
export function generateToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('hex');
}

/**
 * Hash a token using SHA-256
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Create an access pass and store it in the database
 */
export async function createAccessPass(
  input: CreateAccessPassInput,
): Promise<CreateAccessPassResult> {
  const {
    familyId,
    role,
    provider,
    providerUserId,
    identityId,
    chatId,
    expiresInHours = DEFAULT_EXPIRY_HOURS,
  } = input;

  // Generate token and hash
  const token = generateToken();
  const tokenHash = hashToken(token);

  // Calculate expiry time
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  const client = getServiceClient();

  // First, expire any existing pending passes for this user+family combination
  await client
    .from('access_passes')
    .update({ status: 'expired' })
    .eq('provider', provider)
    .eq('provider_user_id', providerUserId)
    .eq('family_id', familyId)
    .eq('status', 'pending');

  // Insert new access pass (no profile data stored - just lookup fields)
  const { error } = await client.from('access_passes').insert({
    token_hash: tokenHash,
    family_id: familyId,
    role,
    provider,
    provider_user_id: providerUserId,
    identity_id: identityId || null,
    chat_id: chatId,
    expires_at: expiresAt.toISOString(),
    status: 'pending',
  });

  if (error) {
    console.error('Failed to create access pass:', error);
    return {
      success: false,
      error: 'Failed to create access pass',
    };
  }

  return {
    success: true,
    token,
    expiresAt,
  };
}

/**
 * Find an access pass by token
 */
export async function findAccessPassByToken(
  token: string,
): Promise<AccessPass | null> {
  const tokenHash = hashToken(token);
  const client = getServiceClient();

  const { data, error } = await client
    .from('access_passes')
    .select('*')
    .eq('token_hash', tokenHash)
    .single();

  if (error || !data) {
    return null;
  }

  return mapRowToCamelCase(data) as AccessPass;
}

/**
 * Validate an access pass (check if it's pending and not expired)
 */
export function validateAccessPass(pass: AccessPass): {
  valid: boolean;
  error?: string;
} {
  if (pass.status !== 'pending') {
    return {
      valid: false,
      error:
        pass.status === 'redeemed'
          ? 'This access pass has already been used'
          : pass.status === 'expired'
            ? 'This access pass has expired'
            : 'This access pass has been revoked',
    };
  }

  if (new Date(pass.expiresAt) < new Date()) {
    return {
      valid: false,
      error: 'This access pass has expired',
    };
  }

  return { valid: true };
}

/**
 * Mark an access pass as redeemed
 */
export async function markAccessPassRedeemed(
  passId: string,
  identityId: string,
): Promise<boolean> {
  const client = getServiceClient();

  const { error } = await client
    .from('access_passes')
    .update({
      status: 'redeemed',
      redeemed_at: new Date().toISOString(),
      redeemed_by_identity_id: identityId,
    })
    .eq('id', passId)
    .eq('status', 'pending');

  return !error;
}

/**
 * Expire all pending passes that have passed their expiry time
 * (Cleanup function, can be run periodically)
 */
export async function expireOldPasses(): Promise<number> {
  const client = getServiceClient();

  const { data, error } = await client
    .from('access_passes')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString())
    .select('id');

  if (error) {
    console.error('Failed to expire old passes:', error);
    return 0;
  }

  return data?.length || 0;
}

/**
 * Build the access pass URL
 */
export function buildAccessPassUrl(token: string, baseUrl: string): string {
  return `${baseUrl}/pass/${token}`;
}

/**
 * Determine role based on chat admin status
 */
export function determineRoleFromAdminStatus(isAdmin: boolean): FamilyRole {
  return isAdmin ? 'admin' : 'member';
}

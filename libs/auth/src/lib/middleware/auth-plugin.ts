/**
 * Elysia Auth Plugin
 *
 * Derives auth context from Bearer token in request headers.
 * Adds `auth` to the request context with user info and permissions.
 */

import { Elysia } from 'elysia';
import * as jose from 'jose';
import type { AuthContext, SessionPayload } from '../types';
import { UserRepository } from '../repositories/user-repository';
import { AuthIdentityRepository } from '../repositories/auth-identity-repository';
import { FamilyAccessRepository } from '../repositories/family-access-repository';

/**
 * Get the secret key for signing/verifying JWTs
 */
function getSecretKey(): Uint8Array {
  const secret = process.env.ACCESS_PASS_SECRET;
  if (!secret) {
    throw new Error('ACCESS_PASS_SECRET environment variable is required');
  }
  return new TextEncoder().encode(secret);
}

/**
 * Create a JWT session token (HS256)
 */
export async function createSessionToken(
  payload: SessionPayload,
): Promise<string> {
  const secret = getSecretKey();

  return await new jose.SignJWT(payload as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

/**
 * Verify and decode a JWT
 */
export async function verifySessionToken(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const secret = getSecretKey();
    const { payload } = await jose.jwtVerify(token, secret);
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const parts = authorization.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Create the auth plugin for Elysia
 *
 * This plugin:
 * 1. Extracts the Bearer token from the Authorization header
 * 2. Verifies the JWT and extracts the session payload
 * 3. Loads the full user, identity, and membership data
 * 4. Makes auth context available via `auth` in request handlers
 */
export const authPlugin = new Elysia({ name: 'auth' })
  .derive(async ({ request }): Promise<{ auth: AuthContext }> => {
    const authorization = request.headers.get('authorization');
    const token = extractBearerToken(authorization || undefined);

    // Default unauthenticated context
    const unauthenticatedContext: AuthContext = {
      user: null,
      identity: null,
      isAuthenticated: false,
      isSuperAdmin: false,
      familyAccess: [],
    };

    if (!token) {
      return { auth: unauthenticatedContext };
    }

    // Verify token
    const sessionPayload = await verifySessionToken(token);
    if (!sessionPayload) {
      return { auth: unauthenticatedContext };
    }

    // Load user from database (primary identity)
    const userRepo = new UserRepository();
    const user = await userRepo.findById(sessionPayload.userId);

    if (!user) {
      return { auth: unauthenticatedContext };
    }

    // Load identity from database
    const identityRepo = new AuthIdentityRepository();
    const identity = await identityRepo.findById(sessionPayload.identityId);

    if (!identity) {
      return { auth: unauthenticatedContext };
    }

    // Load family access records
    const accessRepo = new FamilyAccessRepository();
    const accessRecords = await accessRepo.findByIdentity(identity.id);

    return {
      auth: {
        user,
        identity,
        isAuthenticated: true,
        isSuperAdmin: user.role === 'super_admin',
        familyAccess: accessRecords,
      },
    };
  })
  .as('scoped');

/**
 * Type for handlers that receive auth context
 */
export type AuthenticatedContext = {
  auth: AuthContext;
};

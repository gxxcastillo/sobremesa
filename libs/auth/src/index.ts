export type * from './lib/types';

// Telegram verification
export {
  verifyTelegramLogin,
  parseTelegramLoginParams,
  buildDisplayName,
} from './lib/telegram-verify';

// Access pass utilities
export {
  generateToken,
  hashToken,
  createAccessPass,
  findAccessPassByToken,
  validateAccessPass,
  claimAccessPass,
  markAccessPassRedeemed,
  expireOldPasses,
  buildAccessPassUrl,
  determineRoleFromAdminStatus,
} from './lib/access-pass';

// Repositories
export {
  UserRepository,
  AuthIdentityRepository,
  FamilyAccessRepository,
  ChatAdminRepository,
  type TelegramAdminInfo,
} from './lib/repositories';

// Middleware
export {
  createAuthPlugin,
  createSessionToken,
  verifySessionToken,
  type AuthenticatedContext,
  type AuthPluginConfig,
  requireAuth,
  requireSuperAdmin,
  requireFamilyMember,
  requireFamilyAdmin,
  createFamilyMemberGuard,
  hasAccessToFamily,
  getFamilyRole,
  checkFamilyAccess,
  getAuth,
} from './lib/middleware';

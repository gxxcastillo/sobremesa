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
  TelegramChatAdminRepository,
  type TelegramAdminInfo,
} from './lib/repositories';

// Middleware
export {
  authPlugin,
  createSessionToken,
  verifySessionToken,
  type AuthenticatedContext,
  requireAuth,
  requireSuperAdmin,
  requireFamilyMember,
  requireFamilyAdmin,
  createFamilyMemberGuard,
  hasAccessToFamily,
  getFamilyRole,
  checkFamilyAccess,
} from './lib/middleware';

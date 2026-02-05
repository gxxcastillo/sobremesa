/**
 * Auth Context for Solid.js
 *
 * Manages authentication state across the application:
 * - Current user
 * - Family memberships
 * - Current selected family
 * - Auth token management
 */

import {
  createContext,
  useContext,
  createSignal,
  type ParentComponent,
  onMount,
  createEffect,
} from 'solid-js';
import {
  StudioApiClient,
  type AuthUser,
  type FamilyWithRole,
} from '@sobremesa/api-client';

export interface AuthState {
  user: AuthUser | null;
  families: FamilyWithRole[];
  currentFamily: FamilyWithRole | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface AuthContextValue {
  state: AuthState;
  login: (token: string, user: AuthUser, families: FamilyWithRole[]) => void;
  logout: () => void;
  selectFamily: (familyId: string) => void;
  getToken: () => string | null;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>();

const TOKEN_STORAGE_KEY = 'sobremesa_auth_token';
const FAMILY_STORAGE_KEY = 'sobremesa_current_family';

export const AuthProvider: ParentComponent = (props) => {
  const [user, setUser] = createSignal<AuthUser | null>(null);
  const [families, setFamilies] = createSignal<FamilyWithRole[]>([]);
  const [currentFamily, setCurrentFamily] = createSignal<FamilyWithRole | null>(
    null,
  );
  const [isLoading, setIsLoading] = createSignal(true);

  const client = new StudioApiClient();

  /**
   * Get stored token
   */
  const getToken = (): string | null => {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  };

  /**
   * Store token
   */
  const storeToken = (token: string): void => {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  };

  /**
   * Clear token
   */
  const clearToken = (): void => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  };

  /**
   * Store current family selection
   */
  const storeCurrentFamily = (familyId: string): void => {
    localStorage.setItem(FAMILY_STORAGE_KEY, familyId);
  };

  /**
   * Get stored family selection
   */
  const getStoredFamily = (): string | null => {
    return localStorage.getItem(FAMILY_STORAGE_KEY);
  };

  /**
   * Clear stored family selection
   */
  const clearStoredFamily = (): void => {
    localStorage.removeItem(FAMILY_STORAGE_KEY);
  };

  /**
   * Login with token and user data
   */
  const login = (
    token: string,
    userData: AuthUser,
    userFamilies: FamilyWithRole[],
  ): void => {
    storeToken(token);
    setUser(userData);
    setFamilies(userFamilies);

    // Try to restore previous family selection or use first family
    const storedFamilyId = getStoredFamily();
    const matchingFamily = userFamilies.find(
      (f) => f.familyId === storedFamilyId,
    );

    if (matchingFamily) {
      setCurrentFamily(matchingFamily);
    } else if (userFamilies.length > 0) {
      setCurrentFamily(userFamilies[0]);
      storeCurrentFamily(userFamilies[0].familyId);
    }
  };

  /**
   * Logout and clear all auth state
   */
  const logout = (): void => {
    clearToken();
    clearStoredFamily();
    setUser(null);
    setFamilies([]);
    setCurrentFamily(null);
    client.logout();
  };

  /**
   * Select a different family
   */
  const selectFamily = (familyId: string): void => {
    const family = families().find((f) => f.familyId === familyId);
    if (family) {
      setCurrentFamily(family);
      storeCurrentFamily(familyId);
    }
  };

  /**
   * Refresh user data from API
   */
  const refreshUser = async (): Promise<void> => {
    const token = getToken();
    if (!token) {
      setIsLoading(false);
      return;
    }

    try {
      client.setAuthToken(token);
      const response = await client.getMe();
      setUser(response.user);
      setFamilies(response.families);

      // Auto-detect and save timezone if not set
      if (!response.user.timezone) {
        try {
          const browserTimezone =
            Intl.DateTimeFormat().resolvedOptions().timeZone;
          await client.updateMyTimezone(browserTimezone);
          // Update local user state with the new timezone
          setUser({ ...response.user, timezone: browserTimezone });
        } catch (tzError) {
          // Non-critical - just log and continue
          console.warn('Failed to auto-detect timezone:', tzError);
        }
      }

      // Restore family selection
      const storedFamilyId = getStoredFamily();
      const matchingFamily = response.families.find(
        (f) => f.familyId === storedFamilyId,
      );

      if (matchingFamily) {
        setCurrentFamily(matchingFamily);
      } else if (response.families.length > 0) {
        setCurrentFamily(response.families[0]);
        storeCurrentFamily(response.families[0].familyId);
      }
    } catch (error) {
      console.error('Failed to refresh user:', error);
      // Token might be invalid, clear it
      logout();
    } finally {
      setIsLoading(false);
    }
  };

  // Initialize auth state on mount
  onMount(() => {
    refreshUser();
  });

  // Keep client token in sync
  createEffect(() => {
    const token = getToken();
    if (token) {
      client.setAuthToken(token);
    }
  });

  const state = (): AuthState => ({
    user: user(),
    families: families(),
    currentFamily: currentFamily(),
    isAuthenticated: !!user(),
    isLoading: isLoading(),
  });

  const value: AuthContextValue = {
    get state() {
      return state();
    },
    login,
    logout,
    selectFamily,
    getToken,
    refreshUser,
  };

  return (
    <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// ============================================================================
// Types
// ============================================================================

export interface FamilySummary {
  familyId?: string;
  familyName: string;
  people: Person[];
  relationships: Relationship[];
  places: Place[];
  events: TimelineEvent[];
  stories: Story[];
  questions: QuestionStats;
}

export interface Person {
  name: string;
  aliases?: string[];
  birth_year?: number;
  death_year?: number;
  notes_original?: string;
}

export interface Relationship {
  relationship_type: string;
  person_a: { name: string };
  person_b: { name: string };
}

export interface Place {
  name: string;
  type?: string;
  city?: string;
  region?: string;
  country?: string;
  context_original?: string;
}

export interface TimelineEvent {
  title: string;
  event_type?: string;
  date_text?: string;
  date_year?: number;
  description_original?: string;
}

export interface Story {
  title?: string;
  content_original?: string;
  themes?: string[];
  completeness?: string;
}

export interface QuestionStats {
  proposed: number;
  asked: number;
  answered: number;
}

export interface AllowedChat {
  chatId: string;
  source: string;
  note: string | null;
}

// ============================================================================
// Auth Types
// ============================================================================

/**
 * User profile from the API
 * Note: `id` is the user ID (from users table), not the identity ID
 */
export interface AuthUser {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  provider: string;
  providerUsername: string | null;
  role: 'user' | 'super_admin';
}

export interface FamilyWithRole {
  familyId: string;
  familyName: string;
  role: 'admin' | 'member' | 'viewer';
  grantedAt: string;
}

export interface TelegramLoginData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface TelegramLoginResponse {
  token: string;
  user: AuthUser;
  families: FamilyWithRole[];
  isNewUser: boolean;
}

export interface AccessPassRedemptionResponse {
  token: string;
  user: AuthUser;
  families: FamilyWithRole[];
  grantedFamilyId: string;
  grantedRole: string;
}

export interface MeResponse {
  user: AuthUser;
  families: FamilyWithRole[];
}

export interface PublicStats {
  totalFamilies: number;
  totalPeople: number;
  totalStories: number;
  totalEvents: number;
}

// ============================================================================
// API Client
// ============================================================================

/**
 * API Client for Studio app
 * Communicates with the backend API to fetch family summaries and manage admin actions
 */
export class StudioApiClient {
  private baseUrl: string;
  private authToken: string | null = null;

  constructor(baseUrl = '') {
    // Prefer explicit env override, then passed-in value, then current origin (no explicit port), then fallback
    const envBase =
      (typeof import.meta !== 'undefined' &&
        (import.meta as any).env?.VITE_API_URL) ||
      '';
    const originFallback =
      typeof window !== 'undefined' ? window.location.origin : '';
    this.baseUrl =
      envBase || baseUrl || originFallback || 'https://sobremesa.x:3000';
  }

  /**
   * Set the auth token for authenticated requests
   */
  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  /**
   * Clear the auth token
   */
  clearAuthToken(): void {
    this.authToken = null;
  }

  /**
   * Logout - clear token
   */
  logout(): void {
    this.clearAuthToken();
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/api${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    // Add auth header if token is set
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      headers,
      ...options,
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `API error: ${response.status}`);
    }

    return response.json();
  }

  // ============================================================================
  // Auth Methods
  // ============================================================================

  /**
   * Login with Telegram Login Widget data
   */
  async loginWithTelegram(
    data: TelegramLoginData,
  ): Promise<TelegramLoginResponse> {
    const response = await this.request<TelegramLoginResponse>(
      '/auth/telegram',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    );

    // Auto-set token on successful login
    this.setAuthToken(response.token);

    return response;
  }

  /**
   * Redeem an access pass token
   */
  async redeemAccessPass(token: string): Promise<AccessPassRedemptionResponse> {
    const response = await this.request<AccessPassRedemptionResponse>(
      `/auth/pass/${encodeURIComponent(token)}`,
    );

    // Auto-set token on successful redemption
    this.setAuthToken(response.token);

    return response;
  }

  /**
   * Get current user info
   */
  async getMe(): Promise<MeResponse> {
    return this.request<MeResponse>('/auth/me');
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Get public aggregate stats
   */
  async getPublicStats(): Promise<PublicStats> {
    return this.request<PublicStats>('/public/stats');
  }

  // ============================================================================
  // Family Methods
  // ============================================================================

  /**
   * Fetch the family summary from the API
   * @returns Promise<FamilySummary>
   */
  async getFamilySummary(): Promise<FamilySummary> {
    return this.request<FamilySummary>('/family/summary');
  }

  /**
   * Fetch a specific family's summary by ID
   * @param familyId The family ID
   * @returns Promise<FamilySummary>
   */
  async getFamilySummaryById(familyId: string): Promise<FamilySummary> {
    return this.request<FamilySummary>(`/family/${familyId}/summary`);
  }

  /**
   * Generate a narrative for a family
   * @param familyId The family ID
   * @param audience Target audience (e.g., 'child', 'graduate', 'researcher')
   * @returns Promise<string> The generated narrative
   */
  async generateNarrative(
    familyId: string,
    audience = 'general',
  ): Promise<string> {
    const response = await this.request<{ narrative: string }>(
      '/narrative/generate',
      {
        method: 'POST',
        body: JSON.stringify({ familyId, audience }),
      },
    );
    return response.narrative;
  }

  /**
   * Generate a full book about a family
   * @param familyId The family ID
   * @param audience Target audience
   * @returns Promise<Blob> The generated book (PDF or similar)
   */
  async generateBook(familyId: string, audience = 'general'): Promise<Blob> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(`${this.baseUrl}/api/book/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ familyId, audience }),
    });

    if (!response.ok) {
      throw new Error(`Failed to generate book: ${response.statusText}`);
    }

    return response.blob();
  }

  // ============================================================================
  // Admin Methods (Super Admin only)
  // ============================================================================

  /**
   * Get list of allowed chats
   * @returns Promise<AllowedChat[]>
   */
  async getAllowedChats(): Promise<AllowedChat[]> {
    return this.request<AllowedChat[]>('/admin/chats');
  }

  /**
   * Authorize a chat ID
   * @param chatId The chat ID to authorize
   * @param note Optional note about the authorization
   */
  async authorizeChat(chatId: string, note?: string): Promise<void> {
    await this.request<void>('/admin/chats', {
      method: 'POST',
      body: JSON.stringify({ chatId, note }),
    });
  }

  /**
   * Remove a chat ID from the allowlist
   * @param chatId The chat ID to remove
   */
  async removeChat(chatId: string): Promise<void> {
    await this.request<void>(`/admin/chats/${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
    });
  }
}

export default StudioApiClient;

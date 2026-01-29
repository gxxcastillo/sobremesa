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
// Identity Types
// ============================================================================

export interface PersonSuggestion {
  id: string;
  name: string;
  aliases: string[];
  birthYear: number | null;
  deathYear: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  matchReason: string | null;
  notes?: string | null;
}

export interface IdentityResponse {
  currentClaim: PersonSuggestion | null;
  suggestion: PersonSuggestion | null;
  topPeople: PersonSuggestion[];
  displayName: string | null;
}

export interface ClaimIdentityResponse {
  success: boolean;
  claimed: {
    personId: string;
    personName: string;
  };
}

export interface FamilyPerson {
  id: string;
  name: string;
  aliases: string[];
  birthYear: number | null;
  deathYear: number | null;
}

export interface ListPeopleResponse {
  people: FamilyPerson[];
}

export interface CreatePersonRequest {
  name: string;
  aliases?: string[];
  birthYear?: number;
  notes?: string;
}

export interface CreatePersonResponse {
  success: boolean;
  person: FamilyPerson;
}

export interface UpdatePersonRequest {
  name?: string;
  aliases?: string[];
  birthYear?: number | null;
  notes?: string;
}

export interface UpdatePersonResponse {
  success: boolean;
  person: FamilyPerson & { notes: string | null };
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
  // Identity Methods
  // ============================================================================

  /**
   * Get current identity claim and suggestions for a family
   * @param familyId The family ID
   * @returns Identity info including current claim, suggestion, and top people
   */
  async getIdentity(familyId: string): Promise<IdentityResponse> {
    return this.request<IdentityResponse>(`/family/${familyId}/identity`);
  }

  /**
   * Claim a person as your identity in a family
   * @param familyId The family ID
   * @param personId The person ID to claim
   * @returns The claimed person info
   */
  async claimIdentity(
    familyId: string,
    personId: string,
  ): Promise<ClaimIdentityResponse> {
    return this.request<ClaimIdentityResponse>(
      `/family/${familyId}/identity/claim`,
      {
        method: 'POST',
        body: JSON.stringify({ personId }),
      },
    );
  }

  /**
   * Remove your identity claim in a family
   * @param familyId The family ID
   */
  async unclaimIdentity(familyId: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(
      `/family/${familyId}/identity/claim`,
      {
        method: 'DELETE',
      },
    );
  }

  /**
   * List all people in a family for manual selection
   * @param familyId The family ID
   * @param search Optional search filter
   * @returns List of people
   */
  async listPeople(familyId: string, search?: string): Promise<FamilyPerson[]> {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const response = await this.request<ListPeopleResponse>(
      `/family/${familyId}/people${query}`,
    );
    return response.people;
  }

  /**
   * Create a new person record (self-registration)
   * @param familyId The family ID
   * @param data The person data to create
   * @returns The created person
   */
  async createPerson(
    familyId: string,
    data: CreatePersonRequest,
  ): Promise<FamilyPerson> {
    const response = await this.request<CreatePersonResponse>(
      `/family/${familyId}/people`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    );
    return response.person;
  }

  /**
   * Update your claimed person record
   * @param familyId The family ID
   * @param personId The person ID to update (must be your claimed identity)
   * @param data The fields to update
   * @returns The updated person
   */
  async updatePerson(
    familyId: string,
    personId: string,
    data: UpdatePersonRequest,
  ): Promise<FamilyPerson & { notes: string | null }> {
    const response = await this.request<UpdatePersonResponse>(
      `/family/${familyId}/people/${personId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      },
    );
    return response.person;
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

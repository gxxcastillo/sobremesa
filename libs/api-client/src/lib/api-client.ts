// ============================================================================
// Types
// ============================================================================

export type LanguageCode = 'en' | 'es' | 'pt' | 'fr' | 'de' | 'unknown';

export interface ParsedMessage {
  externalEventId: string;
  rawTimestamp: string;
  occurredAt: Date;
  actorRawName: string;
  actorDisplayName: string;
  eventType:
    | 'message'
    | 'photo'
    | 'video'
    | 'audio'
    | 'document'
    | 'sticker'
    | 'system';
  content: string;
  messageNumber: number;
}

export interface ParticipantConfig {
  rawName: string;
  displayName: string;
  timezone: string;
  role: 'admin' | 'member';
}

export interface ImportConfig {
  family: {
    name: string;
    defaultLanguage: LanguageCode;
    timezone: string;
  };
  participants: ParticipantConfig[];
}

export type ImportJobStatus =
  | 'pending'
  | 'creating_family'
  | 'creating_identities'
  | 'submitting'
  | 'awaiting_intern'
  | 'running_intern'
  | 'intern_complete'
  | 'processing_scribe'
  | 'processing'
  | 'hydrating'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface ImportStatus {
  jobId: string;
  status: ImportJobStatus;
  progress: {
    current: number;
    total: number;
    percentage: number;
  };
  stage: string;
  batchId?: string;
  familyId?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  internStats?: {
    toProcess: number;
    toSkip: number;
    overridden: number;
  };
}

export type InternDecisionType = 'process' | 'skip';

export interface MessageWithDecision {
  id: string;
  occurredAt: Date;
  actorDisplayName: string;
  content: string;
  eventType: string;
  decision: InternDecisionType;
  reason: string | null;
  overridden: boolean;
}

export interface MessageFingerprint {
  occurredAt: Date | string;
  actorRawName: string;
  contentPrefix: string;
}

export interface DuplicateCheckResult {
  totalMessages: number;
  alreadyExist: number;
  newMessages: number;
  existingFamilyId?: string;
  existingFamilyName?: string;
}

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
  /** IANA timezone (e.g., 'America/New_York'). Null if not set. */
  timezone: string | null;
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

  /**
   * Update current user's timezone
   * @param timezone IANA timezone string (e.g., 'America/New_York')
   */
  async updateMyTimezone(timezone: string): Promise<void> {
    await this.request<{ success: boolean; timezone: string }>(
      '/auth/me/timezone',
      {
        method: 'PATCH',
        body: JSON.stringify({ timezone }),
      },
    );
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
      `/family/${familyId}/narrative`,
      {
        method: 'POST',
        body: JSON.stringify({ audience }),
      },
    );
    return response.narrative;
  }

  /**
   * Reprocess all messages for a family through the Scribe
   * @param familyId The family ID
   * @param options Reprocessing options
   * @returns Result with counts of enqueued, skipped, and total messages
   */
  async reprocessFamily(
    familyId: string,
    options: {
      includeAlreadyProcessed?: boolean;
      skipInQueue?: boolean;
    } = {},
  ): Promise<{
    success: boolean;
    message: string;
    enqueued: number;
    skipped: number;
    errors?: number;
    total: number;
  }> {
    return this.request<{
      success: boolean;
      message: string;
      enqueued: number;
      skipped: number;
      errors?: number;
      total: number;
    }>(`/family/${familyId}/reprocess`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  /**
   * Get processing queue statistics for a family
   * @param familyId The family ID
   * @returns Queue stats and processing counts
   */
  async getQueueStats(familyId: string): Promise<{
    queue: { queued: number; processing: number; done: number; error: number };
    totalEvents: number;
    processedEvents: number;
    unprocessedEvents: number;
  }> {
    return this.request<{
      queue: {
        queued: number;
        processing: number;
        done: number;
        error: number;
      };
      totalEvents: number;
      processedEvents: number;
      unprocessedEvents: number;
    }>(`/family/${familyId}/queue-stats`);
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

    const response = await fetch(
      `${this.baseUrl}/api/family/${familyId}/book`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ audience }),
      },
    );

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
    return this.request<AllowedChat[]>('/chats');
  }

  /**
   * Authorize a chat ID
   * @param chatId The chat ID to authorize
   * @param note Optional note about the authorization
   */
  async authorizeChat(chatId: string, note?: string): Promise<void> {
    await this.request<void>('/chats', {
      method: 'POST',
      body: JSON.stringify({ chatId, note }),
    });
  }

  /**
   * Remove a chat ID from the allowlist
   * @param chatId The chat ID to remove
   */
  async removeChat(chatId: string): Promise<void> {
    await this.request<void>(`/chat/${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
    });
  }

  // ============================================================================
  // Import Methods (Super Admin only)
  // ============================================================================

  /**
   * Check how many messages already exist in the database
   * @param source Import source ('whatsapp', 'telegram', 'other')
   * @param messages Array of message fingerprints to check
   * @returns Duplicate check result with counts
   */
  async checkDuplicates(
    source: 'whatsapp' | 'telegram' | 'other',
    messages: MessageFingerprint[],
  ): Promise<DuplicateCheckResult> {
    return this.request<DuplicateCheckResult>('/imports/check-duplicates', {
      method: 'POST',
      body: JSON.stringify({ source, messages }),
    });
  }

  /**
   * Start a WhatsApp import job
   * @param file The raw WhatsApp export .txt file
   * @param config Import configuration (family, participants)
   * @returns Job ID for tracking progress
   */
  async startWhatsAppImport(
    file: File,
    config: ImportConfig,
  ): Promise<{ jobId: string }> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('config', JSON.stringify(config));
    formData.append('source', 'whatsapp');

    const url = `${this.baseUrl}/api/imports`;
    const headers: Record<string, string> = {};
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    // Don't set Content-Type - browser sets it with multipart boundary
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `API error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get import job status
   * @param jobId The job ID to check
   * @returns Current status of the import job
   */
  async getImportStatus(jobId: string): Promise<ImportStatus> {
    return this.request<ImportStatus>(`/import/${jobId}`);
  }

  /**
   * Cancel an in-progress import job
   * @param jobId The job ID to cancel
   */
  async cancelImport(jobId: string): Promise<void> {
    await this.request<void>(`/import/${jobId}/cancel`, {
      method: 'POST',
    });
  }

  /**
   * Resume a failed import job
   * @param jobId The job ID to resume
   */
  async resumeImport(jobId: string): Promise<void> {
    await this.request<void>(`/import/${jobId}/resume`, {
      method: 'POST',
    });
  }

  // ============================================================================
  // Intern Review Methods (Super Admin only)
  // ============================================================================

  /**
   * Run Intern classification on all messages for a job
   * @param jobId The import job ID
   * @returns Stats on how many messages will be processed/skipped
   */
  async runIntern(jobId: string): Promise<{
    success: boolean;
    stats: { toProcess: number; toSkip: number; overridden: number };
  }> {
    return this.request<{
      success: boolean;
      stats: { toProcess: number; toSkip: number; overridden: number };
    }>(`/import/${jobId}/run-intern`, {
      method: 'POST',
    });
  }

  /**
   * Get Intern decisions for all messages
   * @param jobId The import job ID
   * @param filter Optional filter: 'all', 'process', or 'skip'
   * @returns Messages with their Intern decisions
   */
  async getInternDecisions(
    jobId: string,
    filter?: 'all' | 'process' | 'skip',
  ): Promise<{
    messages: MessageWithDecision[];
    stats: { toProcess: number; toSkip: number; overridden: number };
    total: number;
  }> {
    const params = filter ? `?filter=${filter}` : '';
    return this.request<{
      messages: MessageWithDecision[];
      stats: { toProcess: number; toSkip: number; overridden: number };
      total: number;
    }>(`/import/${jobId}/decisions${params}`);
  }

  /**
   * Override an Intern decision for a specific message
   * @param jobId The import job ID
   * @param eventId The conversation event ID
   * @param decision The new decision: 'process' or 'skip'
   */
  async overrideInternDecision(
    jobId: string,
    eventId: string,
    decision: InternDecisionType,
  ): Promise<{
    success: boolean;
    stats: { toProcess: number; toSkip: number; overridden: number };
  }> {
    return this.request<{
      success: boolean;
      stats: { toProcess: number; toSkip: number; overridden: number };
    }>(`/import/${jobId}/decisions/${eventId}`, {
      method: 'PATCH',
      body: JSON.stringify({ decision }),
    });
  }

  /**
   * Submit selected messages to Scribe for processing
   * @param jobId The import job ID
   */
  async submitToScribe(jobId: string): Promise<{
    success: boolean;
    processed: number;
    skipped: number;
  }> {
    return this.request<{
      success: boolean;
      processed: number;
      skipped: number;
    }>(`/import/${jobId}/submit-scribe`, {
      method: 'POST',
    });
  }
}

export default StudioApiClient;

export interface FamilySummary {
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
  date_year?: number;
  date_month?: number;
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

/**
 * API Client for Studio app
 * Communicates with the backend API to fetch family summaries and manage admin actions
 */
export class StudioApiClient {
  private baseUrl: string;

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

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}/api${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
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
    audience = 'general'
  ): Promise<string> {
    const response = await this.request<{ narrative: string }>(
      '/narrative/generate',
      {
        method: 'POST',
        body: JSON.stringify({ familyId, audience }),
      }
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
    const response = await fetch(`${this.baseUrl}/api/book/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ familyId, audience }),
    });

    if (!response.ok) {
      throw new Error(`Failed to generate book: ${response.statusText}`);
    }

    return response.blob();
  }

  // Admin methods

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
   * Remove a chat ID from the whitelist
   * @param chatId The chat ID to remove
   */
  async removeChat(chatId: string): Promise<void> {
    await this.request<void>(`/admin/chats/${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
    });
  }
}

/** @deprecated Use StudioApiClient instead */
export const PublisherApiClient = StudioApiClient;

export default StudioApiClient;

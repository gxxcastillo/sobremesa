import { SupabaseClient } from '@supabase/supabase-js';
import { getServiceClient } from '../client.js';

/**
 * A verified conversation participant with their person record info.
 */
export interface ConversationParticipant {
  personId: string;
  personName: string;
  identityId: string;
  identityDisplayName: string | null;
}

/**
 * A participant with their family relationships for context.
 * Used by question generation to know who might answer questions about whom.
 */
export interface ParticipantWithContext {
  personId: string;
  personName: string;
  /** Relationships from this person's perspective, e.g., "daughter of Elena", "sister of Juan" */
  relationships: ParticipantRelationship[];
}

export interface ParticipantRelationship {
  /** The type from this participant's perspective, e.g., "daughter", "sister", "spouse" */
  relationshipType: string;
  /** The name of the related person */
  relatedPersonName: string;
  /** The ID of the related person */
  relatedPersonId: string;
}

/**
 * Subject types that can be used to find related participants.
 */
export type SubjectType = 'person' | 'event' | 'place' | 'story';

/**
 * A participant matched to a specific subject with reason for the connection.
 */
export interface ParticipantMatch {
  personId: string;
  personName: string;
  /** How this participant is connected to the subject */
  connectionReason: string;
  /** Connection type for programmatic use */
  connectionType:
    | 'direct'
    | 'relationship'
    | 'story_mention'
    | 'event_participant';
}

/**
 * Repository for family access operations.
 *
 * Handles per-family permissions via the family_access table,
 * including checking if a person is a participant in a conversation.
 */
export class FamilyAccessRepository {
  protected tableName = 'family_access';
  protected client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client = client ?? getServiceClient();
  }

  /**
   * Check if a person is a participant in a conversation.
   *
   * A person is a participant if:
   * 1. They have active family_access with person_id linked
   * 2. Their identity has sent at least one message in the conversation
   *
   * This uses an efficient database function that joins:
   * - conversation_events (to check for messages)
   * - identities (to match provider + provider_user_id)
   * - family_access (to link identity to person)
   *
   * @param familyId - The family ID
   * @param conversationId - The conversation ID (e.g., Telegram chat ID)
   * @param personId - The person ID to check
   * @returns true if the person is a verified participant, false otherwise
   */
  async isPersonParticipant(
    familyId: string,
    conversationId: string,
    personId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('is_person_participant', {
      p_family_id: familyId,
      p_conversation_id: conversationId,
      p_person_id: personId,
    });

    if (error) {
      // Fail safe: if we can't verify, assume not a participant
      // Caller (Facilitator) has its own logger and will log the context
      return false;
    }

    return data === true;
  }

  /**
   * Get all verified participants in a conversation.
   *
   * Returns people who:
   * 1. Have active family_access with person_id linked
   * 2. Their identity has sent at least one message in the conversation
   *
   * This is useful for:
   * - Question generation: knowing who can be targeted
   * - UI: showing who's verified in the chat
   *
   * @param familyId - The family ID
   * @param conversationId - The conversation ID (e.g., Telegram chat ID)
   * @returns Array of verified participants with their person and identity info
   */
  async getConversationParticipants(
    familyId: string,
    conversationId: string,
  ): Promise<ConversationParticipant[]> {
    const { data, error } = await this.client.rpc(
      'get_conversation_participants',
      {
        p_family_id: familyId,
        p_conversation_id: conversationId,
      },
    );

    if (error) {
      // Return empty array on error - caller can handle appropriately
      return [];
    }

    return (data || []).map(
      (row: {
        person_id: string;
        person_name: string;
        identity_id: string;
        identity_display_name: string | null;
      }) => ({
        personId: row.person_id,
        personName: row.person_name,
        identityId: row.identity_id,
        identityDisplayName: row.identity_display_name,
      }),
    );
  }

  /**
   * Get the names of all verified participants in a conversation.
   *
   * Convenience method for question generation - returns just the person names
   * that can be used as valid targetPerson values.
   *
   * @param familyId - The family ID
   * @param conversationId - The conversation ID
   * @returns Array of person names who are verified participants
   */
  async getParticipantNames(
    familyId: string,
    conversationId: string,
  ): Promise<string[]> {
    const participants = await this.getConversationParticipants(
      familyId,
      conversationId,
    );
    return participants.map((p) => p.personName);
  }

  /**
   * Get verified participants with their family relationships.
   *
   * This is essential for intelligent question targeting - it tells the LLM
   * not just WHO is in the chat, but HOW they relate to people in stories.
   *
   * Example output:
   * ```
   * [
   *   {
   *     personId: "...",
   *     personName: "Maria",
   *     relationships: [
   *       { relationshipType: "daughter", relatedPersonName: "Elena", relatedPersonId: "..." },
   *       { relationshipType: "sister", relatedPersonName: "Juan", relatedPersonId: "..." }
   *     ]
   *   }
   * ]
   * ```
   *
   * This allows question generation to reason:
   * "Story mentions Elena's wedding → Maria is Elena's daughter → Ask Maria"
   *
   * @param familyId - The family ID
   * @param conversationId - The conversation ID
   * @returns Participants with their relationships for context
   */
  async getParticipantsWithContext(
    familyId: string,
    conversationId: string,
  ): Promise<ParticipantWithContext[]> {
    const { data, error } = await this.client.rpc(
      'get_participants_with_relationships',
      {
        p_family_id: familyId,
        p_conversation_id: conversationId,
      },
    );

    if (error) {
      return [];
    }

    // Group by person_id and collect relationships
    const participantMap = new Map<string, ParticipantWithContext>();

    for (const row of data || []) {
      const personId = row.person_id as string;

      if (!participantMap.has(personId)) {
        participantMap.set(personId, {
          personId,
          personName: row.person_name as string,
          relationships: [],
        });
      }

      // Add relationship if present
      if (row.relationship_type && row.related_person_name) {
        const participant = participantMap.get(personId);
        if (participant) {
          participant.relationships.push({
            relationshipType: row.relationship_type as string,
            relatedPersonName: row.related_person_name as string,
            relatedPersonId: row.related_person_id as string,
          });
        }
      }
    }

    return Array.from(participantMap.values());
  }

  /**
   * Format participants with context as a string for LLM prompts.
   *
   * Returns a human-readable format like:
   * ```
   * - Maria (daughter of Elena, sister of Juan)
   * - Juan (son of Elena, brother of Maria)
   * - Rosa (spouse of Carlos)
   * ```
   *
   * @param familyId - The family ID
   * @param conversationId - The conversation ID
   * @returns Formatted string for LLM context
   */
  async getParticipantContextForPrompt(
    familyId: string,
    conversationId: string,
  ): Promise<string> {
    const participants = await this.getParticipantsWithContext(
      familyId,
      conversationId,
    );

    if (participants.length === 0) {
      return 'No verified participants found.';
    }

    return participants
      .map((p) => {
        if (p.relationships.length === 0) {
          return `- ${p.personName}`;
        }
        const rels = p.relationships
          .map((r) => `${r.relationshipType} of ${r.relatedPersonName}`)
          .join(', ');
        return `- ${p.personName} (${rels})`;
      })
      .join('\n');
  }

  /**
   * Find participants who are connected to a specific subject (person, event, place, or story).
   *
   * This is the key function for intelligent question targeting. Given a subject
   * (e.g., "Elena" or "Elena's wedding"), it returns only the participants who
   * have a meaningful connection to that subject.
   *
   * Connection types by subject:
   * - **person**: Participants with family relationships to that person
   * - **event**: Participants linked via event_people (they were involved)
   * - **place**: Participants linked via events at that place
   * - **story**: Participants mentioned in that story via story_people
   *
   * @param familyId - The family ID
   * @param conversationId - The conversation ID
   * @param subjectType - Type of subject: 'person', 'event', 'place', or 'story'
   * @param subjectId - ID of the subject entity
   * @returns Participants with their connection reason
   */
  async getParticipantsRelatedToSubject(
    familyId: string,
    conversationId: string,
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<ParticipantMatch[]> {
    const { data, error } = await this.client.rpc(
      'get_participants_related_to_subject',
      {
        p_family_id: familyId,
        p_conversation_id: conversationId,
        p_subject_type: subjectType,
        p_subject_id: subjectId,
      },
    );

    if (error) {
      return [];
    }

    return (data || []).map(
      (row: {
        person_id: string;
        person_name: string;
        connection_reason: string;
        connection_type: string;
      }) => ({
        personId: row.person_id,
        personName: row.person_name,
        connectionReason: row.connection_reason,
        connectionType:
          row.connection_type as ParticipantMatch['connectionType'],
      }),
    );
  }

  /**
   * Format participants related to a subject as a string for LLM prompts.
   *
   * @param familyId - The family ID
   * @param conversationId - The conversation ID
   * @param subjectType - Type of subject
   * @param subjectId - ID of the subject
   * @param subjectName - Human-readable name of subject (for context)
   * @returns Formatted string for LLM context
   */
  async getRelatedParticipantsForPrompt(
    familyId: string,
    conversationId: string,
    subjectType: SubjectType,
    subjectId: string,
    subjectName: string,
  ): Promise<string> {
    const matches = await this.getParticipantsRelatedToSubject(
      familyId,
      conversationId,
      subjectType,
      subjectId,
    );

    if (matches.length === 0) {
      return `No participants in the chat are connected to ${subjectName}.`;
    }

    const header = `Participants connected to "${subjectName}":`;
    const lines = matches.map(
      (m) => `- ${m.personName}: ${m.connectionReason}`,
    );
    return [header, ...lines].join('\n');
  }
}

import type { DatabaseClient } from '../client';
import type { FamilyAccess, OnboardingState } from '@sobremesa/shared-types';
import { mapRowToCamelCase } from '../base-repository.js';

/**
 * Repository for family access operations.
 *
 * Handles per-family permissions via the family_access table,
 * including checking if a person is a participant in a conversation.
 */
export class FamilyAccessRepository {
  protected tableName = 'family_access';
  protected client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.client = client;
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

  // ===========================================================================
  // Onboarding Methods
  // ===========================================================================

  /**
   * Find a family access record by identity and family.
   */
  async findByIdentityAndFamily(
    identityId: string,
    familyId: string,
  ): Promise<FamilyAccess | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('identity_id', identityId)
      .eq('family_id', familyId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find family access: ${error.message}`);
    }

    return mapRowToCamelCase<FamilyAccess>(data);
  }

  /**
   * Update the onboarding state for a user in a family.
   */
  async updateOnboardingState(
    identityId: string,
    familyId: string,
    state: OnboardingState,
  ): Promise<FamilyAccess | null> {
    const updateData: Record<string, unknown> = {
      onboarding_state: state,
    };

    // Set timestamp when DM is sent
    if (state === 'dm_sent') {
      updateData.onboarding_dm_sent_at = new Date().toISOString();
    }

    const { data, error } = await this.client
      .from(this.tableName)
      .update(updateData)
      .eq('identity_id', identityId)
      .eq('family_id', familyId)
      .select()
      .single();

    if (error || !data) {
      return null;
    }

    return mapRowToCamelCase<FamilyAccess>(data);
  }

  /**
   * Find all family access records needing onboarding for a family.
   * Returns identities with onboarding_state = 'not_started'.
   */
  async findNeedingOnboarding(familyId: string): Promise<FamilyAccess[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('onboarding_state', 'not_started');

    if (error) {
      throw new Error(
        `Failed to find identities needing onboarding: ${error.message}`,
      );
    }

    return (data || []).map((row) => mapRowToCamelCase<FamilyAccess>(row));
  }

  /**
   * Update the family relation for a user in a family.
   */
  async updateFamilyRelation(
    identityId: string,
    familyId: string,
    familyRelation: string,
  ): Promise<FamilyAccess | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({ family_relation: familyRelation })
      .eq('identity_id', identityId)
      .eq('family_id', familyId)
      .select()
      .single();

    if (error || !data) {
      return null;
    }

    return mapRowToCamelCase<FamilyAccess>(data);
  }
}

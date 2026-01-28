import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FamilyAccessRepository } from './family-access-repository';

// Mock Supabase client
const mockSupabaseClient = {
  rpc: vi.fn(),
};

describe('FamilyAccessRepository', () => {
  let repo: FamilyAccessRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new FamilyAccessRepository(mockSupabaseClient as any);
  });

  describe('isPersonParticipant', () => {
    const familyId = 'family-123';
    const conversationId = 'chat-456';
    const personId = 'person-789';

    it('returns true when person is a verified participant', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: true,
        error: null,
      });

      const result = await repo.isPersonParticipant(
        familyId,
        conversationId,
        personId,
      );

      expect(result).toBe(true);
      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'is_person_participant',
        {
          p_family_id: familyId,
          p_conversation_id: conversationId,
          p_person_id: personId,
        },
      );
    });

    it('returns false when person is not a participant', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: false,
        error: null,
      });

      const result = await repo.isPersonParticipant(
        familyId,
        conversationId,
        personId,
      );

      expect(result).toBe(false);
    });

    it('returns false on database error (fail-safe)', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: null,
        error: { message: 'Database connection failed' },
      });

      const result = await repo.isPersonParticipant(
        familyId,
        conversationId,
        personId,
      );

      expect(result).toBe(false);
    });

    it('returns false when data is null', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: null,
        error: null,
      });

      const result = await repo.isPersonParticipant(
        familyId,
        conversationId,
        personId,
      );

      expect(result).toBe(false);
    });
  });

  describe('getConversationParticipants', () => {
    const familyId = 'family-123';
    const conversationId = 'chat-456';

    it('returns mapped participants when found', async () => {
      const dbData = [
        {
          person_id: 'person-1',
          person_name: 'María García',
          identity_id: 'identity-1',
          identity_display_name: 'Maria G',
        },
        {
          person_id: 'person-2',
          person_name: 'Juan García',
          identity_id: 'identity-2',
          identity_display_name: null,
        },
      ];

      mockSupabaseClient.rpc.mockResolvedValue({
        data: dbData,
        error: null,
      });

      const result = await repo.getConversationParticipants(
        familyId,
        conversationId,
      );

      expect(result).toEqual([
        {
          personId: 'person-1',
          personName: 'María García',
          identityId: 'identity-1',
          identityDisplayName: 'Maria G',
        },
        {
          personId: 'person-2',
          personName: 'Juan García',
          identityId: 'identity-2',
          identityDisplayName: null,
        },
      ]);

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'get_conversation_participants',
        {
          p_family_id: familyId,
          p_conversation_id: conversationId,
        },
      );
    });

    it('returns empty array when no participants found', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: [],
        error: null,
      });

      const result = await repo.getConversationParticipants(
        familyId,
        conversationId,
      );

      expect(result).toEqual([]);
    });

    it('returns empty array on database error', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: null,
        error: { message: 'Database error' },
      });

      const result = await repo.getConversationParticipants(
        familyId,
        conversationId,
      );

      expect(result).toEqual([]);
    });
  });

  describe('getParticipantNames', () => {
    const familyId = 'family-123';
    const conversationId = 'chat-456';

    it('returns array of participant names', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            person_id: 'person-1',
            person_name: 'María',
            identity_id: 'id-1',
            identity_display_name: 'M',
          },
          {
            person_id: 'person-2',
            person_name: 'Juan',
            identity_id: 'id-2',
            identity_display_name: 'J',
          },
        ],
        error: null,
      });

      const result = await repo.getParticipantNames(familyId, conversationId);

      expect(result).toEqual(['María', 'Juan']);
    });
  });

  describe('getParticipantsWithContext', () => {
    const familyId = 'family-123';
    const conversationId = 'chat-456';

    it('groups relationships by person', async () => {
      const dbData = [
        {
          person_id: 'person-1',
          person_name: 'María',
          relationship_type: 'daughter',
          related_person_id: 'person-3',
          related_person_name: 'Elena',
        },
        {
          person_id: 'person-1',
          person_name: 'María',
          relationship_type: 'sister',
          related_person_id: 'person-2',
          related_person_name: 'Juan',
        },
        {
          person_id: 'person-2',
          person_name: 'Juan',
          relationship_type: 'son',
          related_person_id: 'person-3',
          related_person_name: 'Elena',
        },
      ];

      mockSupabaseClient.rpc.mockResolvedValue({
        data: dbData,
        error: null,
      });

      const result = await repo.getParticipantsWithContext(
        familyId,
        conversationId,
      );

      expect(result).toHaveLength(2);

      const maria = result.find((p) => p.personName === 'María');
      expect(maria).toBeDefined();
      expect(maria?.relationships).toHaveLength(2);
      expect(maria?.relationships).toContainEqual({
        relationshipType: 'daughter',
        relatedPersonId: 'person-3',
        relatedPersonName: 'Elena',
      });
      expect(maria?.relationships).toContainEqual({
        relationshipType: 'sister',
        relatedPersonId: 'person-2',
        relatedPersonName: 'Juan',
      });

      const juan = result.find((p) => p.personName === 'Juan');
      expect(juan).toBeDefined();
      expect(juan?.relationships).toHaveLength(1);
    });

    it('handles participants with no relationships', async () => {
      const dbData = [
        {
          person_id: 'person-1',
          person_name: 'María',
          relationship_type: null,
          related_person_id: null,
          related_person_name: null,
        },
      ];

      mockSupabaseClient.rpc.mockResolvedValue({
        data: dbData,
        error: null,
      });

      const result = await repo.getParticipantsWithContext(
        familyId,
        conversationId,
      );

      expect(result).toHaveLength(1);
      expect(result[0].personName).toBe('María');
      expect(result[0].relationships).toHaveLength(0);
    });

    it('returns empty array on error', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: null,
        error: { message: 'Database error' },
      });

      const result = await repo.getParticipantsWithContext(
        familyId,
        conversationId,
      );

      expect(result).toEqual([]);
    });
  });

  describe('getParticipantContextForPrompt', () => {
    const familyId = 'family-123';
    const conversationId = 'chat-456';

    it('formats participants with relationships for LLM prompt', async () => {
      const dbData = [
        {
          person_id: 'person-1',
          person_name: 'María',
          relationship_type: 'daughter',
          related_person_id: 'person-3',
          related_person_name: 'Elena',
        },
        {
          person_id: 'person-1',
          person_name: 'María',
          relationship_type: 'sister',
          related_person_id: 'person-2',
          related_person_name: 'Juan',
        },
      ];

      mockSupabaseClient.rpc.mockResolvedValue({
        data: dbData,
        error: null,
      });

      const result = await repo.getParticipantContextForPrompt(
        familyId,
        conversationId,
      );

      expect(result).toContain('María');
      expect(result).toContain('daughter of Elena');
      expect(result).toContain('sister of Juan');
    });

    it('formats participants without relationships', async () => {
      const dbData = [
        {
          person_id: 'person-1',
          person_name: 'Solo Person',
          relationship_type: null,
          related_person_id: null,
          related_person_name: null,
        },
      ];

      mockSupabaseClient.rpc.mockResolvedValue({
        data: dbData,
        error: null,
      });

      const result = await repo.getParticipantContextForPrompt(
        familyId,
        conversationId,
      );

      expect(result).toBe('- Solo Person');
    });

    it('returns message when no participants found', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: [],
        error: null,
      });

      const result = await repo.getParticipantContextForPrompt(
        familyId,
        conversationId,
      );

      expect(result).toBe('No verified participants found.');
    });
  });

  describe('getParticipantsRelatedToSubject', () => {
    const familyId = 'family-123';
    const conversationId = 'chat-456';

    it('returns participants related to a person subject', async () => {
      const dbData = [
        {
          person_id: 'person-1',
          person_name: 'María',
          connection_reason: 'daughter of Elena',
          connection_type: 'relationship',
        },
      ];

      mockSupabaseClient.rpc.mockResolvedValue({
        data: dbData,
        error: null,
      });

      const result = await repo.getParticipantsRelatedToSubject(
        familyId,
        conversationId,
        'person',
        'elena-id',
      );

      expect(result).toEqual([
        {
          personId: 'person-1',
          personName: 'María',
          connectionReason: 'daughter of Elena',
          connectionType: 'relationship',
        },
      ]);

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'get_participants_related_to_subject',
        {
          p_family_id: familyId,
          p_conversation_id: conversationId,
          p_subject_type: 'person',
          p_subject_id: 'elena-id',
        },
      );
    });

    it('returns empty array on error', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: null,
        error: { message: 'Database error' },
      });

      const result = await repo.getParticipantsRelatedToSubject(
        familyId,
        conversationId,
        'event',
        'event-id',
      );

      expect(result).toEqual([]);
    });
  });

  describe('getRelatedParticipantsForPrompt', () => {
    const familyId = 'family-123';
    const conversationId = 'chat-456';

    it('formats related participants for LLM prompt', async () => {
      const dbData = [
        {
          person_id: 'person-1',
          person_name: 'María',
          connection_reason: 'was at the wedding',
          connection_type: 'event_participant',
        },
      ];

      mockSupabaseClient.rpc.mockResolvedValue({
        data: dbData,
        error: null,
      });

      const result = await repo.getRelatedParticipantsForPrompt(
        familyId,
        conversationId,
        'event',
        'wedding-id',
        "Elena's Wedding",
      );

      expect(result).toContain('Participants connected to "Elena\'s Wedding"');
      expect(result).toContain('María: was at the wedding');
    });

    it('returns message when no related participants', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: [],
        error: null,
      });

      const result = await repo.getRelatedParticipantsForPrompt(
        familyId,
        conversationId,
        'person',
        'unknown-id',
        'Unknown Person',
      );

      expect(result).toBe(
        'No participants in the chat are connected to Unknown Person.',
      );
    });
  });
});

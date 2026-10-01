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
});

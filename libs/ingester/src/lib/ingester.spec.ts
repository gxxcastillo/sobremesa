import { describe, expect, it, vi } from 'vitest';
import {
  MessageIngester,
  type ActorInfo,
  type AudioMessageInput,
  type EditMessageInput,
  type PhotoMessageInput,
  type VoiceMessageInput,
} from './ingester';
import type {
  ConversationEventRepository,
  EventLogRepository,
  IdentityRepository,
  ProcessingQueueRepository,
} from '@sobremesa/database';

const FAMILY_ID = 'family-1';
const ACTOR: ActorInfo = {
  externalId: 'actor-1',
  displayName: 'Gabriela',
  username: 'gabriela',
};

function makeFakeClient() {
  return {
    from: () => ({
      upsert: async () => ({ error: null }),
    }),
  } as any;
}

function makeIngester(overrides?: { existing?: boolean }) {
  const insertedEvents: Record<string, unknown>[] = [];
  const enqueueCalls: Array<{ familyId: string; eventId: string }> = [];
  const loggedEvents: Array<Record<string, unknown>> = [];
  let idCounter = 0;

  const conversationEvents = {
    findByExternalId: vi
      .fn()
      .mockResolvedValue(overrides?.existing ? { id: 'already-there' } : null),
    insert: vi
      .fn()
      .mockImplementation(async (data: Record<string, unknown>) => {
        const event = { id: `evt-${++idCounter}`, ...data };
        insertedEvents.push(event);
        return event;
      }),
  } as unknown as ConversationEventRepository;

  const queueRepo = {
    enqueue: vi
      .fn()
      .mockImplementation(async (familyId: string, eventId: string) => {
        enqueueCalls.push({ familyId, eventId });
      }),
  } as unknown as ProcessingQueueRepository;

  const eventLog = {
    log: vi.fn().mockImplementation(async (entry: Record<string, unknown>) => {
      loggedEvents.push(entry);
      return {} as any;
    }),
  } as unknown as EventLogRepository;

  const identityRepo = {
    findOrCreate: vi
      .fn()
      .mockResolvedValue({ identity: { id: 'identity-1' }, created: false }),
  } as unknown as IdentityRepository;

  const ingester = new MessageIngester({
    dbClient: makeFakeClient(),
    conversationEvents,
    queueRepo,
    eventLog,
    identityRepo,
  });

  return {
    ingester,
    insertedEvents,
    enqueueCalls,
    loggedEvents,
    conversationEvents,
  };
}

describe('MessageIngester.ingestVoiceMessage', () => {
  it('persists a voice event and enqueues it, capture-only (no content)', async () => {
    const { ingester, insertedEvents, enqueueCalls } = makeIngester();
    const input: VoiceMessageInput = {
      type: 'voice',
      source: 'telegram',
      conversationId: 'chat-1',
      externalEventId: 'msg-1',
      actor: ACTOR,
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      fileId: 'file-1',
      fileUniqueId: 'unique-1',
      duration: 12,
      mimeType: 'audio/ogg',
    };

    const eventId = await ingester.ingestVoiceMessage(FAMILY_ID, input);

    expect(eventId).toBe('evt-1');
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]).toMatchObject({
      eventType: 'voice',
      contentOriginal: undefined,
      metadata: expect.objectContaining({
        fileId: 'file-1',
        fileUniqueId: 'unique-1',
        duration: 12,
        mimeType: 'audio/ogg',
      }),
    });
    expect(enqueueCalls).toEqual([{ familyId: FAMILY_ID, eventId: 'evt-1' }]);
  });

  it('skips a voice message already ingested', async () => {
    const { ingester, insertedEvents } = makeIngester({ existing: true });

    const eventId = await ingester.ingestVoiceMessage(FAMILY_ID, {
      type: 'voice',
      source: 'telegram',
      conversationId: 'chat-1',
      externalEventId: 'msg-1',
      actor: ACTOR,
      occurredAt: new Date(),
      fileId: 'file-1',
      fileUniqueId: 'unique-1',
    });

    expect(eventId).toBeNull();
    expect(insertedEvents).toHaveLength(0);
  });
});

describe('MessageIngester.ingestAudioMessage', () => {
  it('persists an audio event with file metadata', async () => {
    const { ingester, insertedEvents } = makeIngester();
    const input: AudioMessageInput = {
      type: 'audio',
      source: 'telegram',
      conversationId: 'chat-1',
      externalEventId: 'msg-2',
      actor: ACTOR,
      occurredAt: new Date(),
      fileId: 'file-2',
      fileUniqueId: 'unique-2',
      performer: 'Mariachi Band',
      title: 'Cielito Lindo',
    };

    const eventId = await ingester.ingestAudioMessage(FAMILY_ID, input);

    expect(eventId).toBe('evt-1');
    expect(insertedEvents[0]).toMatchObject({
      eventType: 'audio',
      metadata: expect.objectContaining({
        performer: 'Mariachi Band',
        title: 'Cielito Lindo',
      }),
    });
  });
});

describe('MessageIngester.ingestEditMessage', () => {
  it('appends a new event carrying editOfExternalId, never mutating the original', async () => {
    const { ingester, insertedEvents } = makeIngester();
    const input: EditMessageInput = {
      type: 'edit',
      source: 'telegram',
      conversationId: 'chat-1',
      externalEventId: 'edit_100_5001',
      editOfExternalId: '100',
      actor: ACTOR,
      occurredAt: new Date('2026-01-02T00:00:00Z'),
      text: 'Corrected: it was 1978, not 1979.',
    };

    const eventId = await ingester.ingestEditMessage(FAMILY_ID, input);

    expect(eventId).toBe('evt-1');
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]).toMatchObject({
      externalEventId: 'edit_100_5001',
      eventType: 'edit',
      contentOriginal: 'Corrected: it was 1978, not 1979.',
      metadata: expect.objectContaining({ editOfExternalId: '100' }),
    });
  });

  it('two edits of the same original message are both kept as distinct events', async () => {
    const { ingester, conversationEvents } = makeIngester();
    // Each edit mints its own externalEventId (caller's responsibility -- the
    // original message id alone is never reused), so the dedup check below
    // never matches a prior edit of the same message.
    (conversationEvents.findByExternalId as any).mockResolvedValue(null);

    await ingester.ingestEditMessage(FAMILY_ID, {
      type: 'edit',
      source: 'telegram',
      conversationId: 'chat-1',
      externalEventId: 'edit_100_5001',
      editOfExternalId: '100',
      actor: ACTOR,
      occurredAt: new Date(),
      text: 'First correction.',
    });
    await ingester.ingestEditMessage(FAMILY_ID, {
      type: 'edit',
      source: 'telegram',
      conversationId: 'chat-1',
      externalEventId: 'edit_100_5002',
      editOfExternalId: '100',
      actor: ACTOR,
      occurredAt: new Date(),
      text: 'Second correction.',
    });

    expect(conversationEvents.findByExternalId).toHaveBeenCalledTimes(2);
  });
});

describe('MessageIngester media_group_id passthrough', () => {
  it('carries metadata.mediaGroupId through to the stored event for media types', async () => {
    const { ingester, insertedEvents } = makeIngester();
    const input: PhotoMessageInput = {
      type: 'photo',
      source: 'telegram',
      conversationId: 'chat-1',
      externalEventId: 'msg-3',
      actor: ACTOR,
      occurredAt: new Date(),
      fileId: 'file-3',
      fileUniqueId: 'unique-3',
      metadata: { mediaGroupId: 'album-42' },
    };

    await ingester.ingestPhotoMessage(FAMILY_ID, input);

    expect(insertedEvents[0]).toMatchObject({
      metadata: expect.objectContaining({ mediaGroupId: 'album-42' }),
    });
  });
});

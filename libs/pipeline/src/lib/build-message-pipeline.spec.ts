import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockProvider } from '@sobremesa/ai-provider';
import { MessageProcessor } from '@sobremesa/queue';
import type { DatabaseClient } from '@sobremesa/database';
import type { MessageSender } from '@sobremesa/shared-types';
import {
  buildMessagePipeline,
  type PipelineStage,
} from './build-message-pipeline';

const dbClient = {} as DatabaseClient;
const provider = new MockProvider();
const messageSender = { sendMessage: vi.fn() } as unknown as MessageSender;

function stageSet(...names: PipelineStage[]): Set<PipelineStage> {
  return new Set(names);
}

describe('buildMessagePipeline', () => {
  let setRouter: ReturnType<typeof vi.spyOn>;
  let setFilter: ReturnType<typeof vi.spyOn>;
  let setImageLinker: ReturnType<typeof vi.spyOn>;
  let setScribe: ReturnType<typeof vi.spyOn>;
  let setRegistrar: ReturnType<typeof vi.spyOn>;
  let setAdminProcessor: ReturnType<typeof vi.spyOn>;
  let setHistorianProcessor: ReturnType<typeof vi.spyOn>;
  let setStoryFollowupHook: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setRouter = vi.spyOn(MessageProcessor.prototype, 'setRouter');
    setFilter = vi.spyOn(MessageProcessor.prototype, 'setFilter');
    setImageLinker = vi.spyOn(MessageProcessor.prototype, 'setImageLinker');
    setScribe = vi.spyOn(MessageProcessor.prototype, 'setScribe');
    setRegistrar = vi.spyOn(MessageProcessor.prototype, 'setRegistrar');
    setAdminProcessor = vi.spyOn(
      MessageProcessor.prototype,
      'setAdminProcessor',
    );
    setHistorianProcessor = vi.spyOn(
      MessageProcessor.prototype,
      'setHistorianProcessor',
    );
    setStoryFollowupHook = vi.spyOn(
      MessageProcessor.prototype,
      'setStoryFollowupHook',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wires only scribe + registrar when that is all that is requested', () => {
    buildMessagePipeline({
      dbClient,
      stages: stageSet('scribe', 'registrar'),
      providers: { scribe: provider },
      models: { scribe: 'mock-model' },
    });

    expect(setScribe).toHaveBeenCalledTimes(1);
    expect(setRegistrar).toHaveBeenCalledTimes(1);
    expect(setRouter).not.toHaveBeenCalled();
    expect(setFilter).not.toHaveBeenCalled();
    expect(setImageLinker).not.toHaveBeenCalled();
    expect(setAdminProcessor).not.toHaveBeenCalled();
    expect(setHistorianProcessor).not.toHaveBeenCalled();
  });

  it('wires router/filter/imageLinker off one Intern instance', () => {
    buildMessagePipeline({
      dbClient,
      stages: stageSet('router', 'filter', 'imageLinker'),
      providers: { intern: provider },
      models: { intern: 'mock-model' },
    });

    expect(setRouter).toHaveBeenCalledTimes(1);
    expect(setFilter).toHaveBeenCalledTimes(1);
    expect(setImageLinker).toHaveBeenCalledTimes(1);
  });

  it('wires admin given a message sender', () => {
    buildMessagePipeline({
      dbClient,
      stages: stageSet('admin'),
      providers: {},
      models: {},
      messageSender,
    });

    expect(setAdminProcessor).toHaveBeenCalledTimes(1);
  });

  it('wires historian (Historian answer + Facilitator response formatting)', () => {
    buildMessagePipeline({
      dbClient,
      stages: stageSet('historian'),
      providers: { historian: provider, facilitator: provider },
      models: { historian: 'mock-model', facilitator: 'mock-model' },
      messageSender,
    });

    expect(setHistorianProcessor).toHaveBeenCalledTimes(1);
  });

  it('wires registrar + facilitatorNudge together', () => {
    buildMessagePipeline({
      dbClient,
      stages: stageSet('registrar', 'facilitatorNudge'),
      providers: { facilitator: provider },
      models: { facilitator: 'mock-model' },
      messageSender,
    });

    expect(setRegistrar).toHaveBeenCalledTimes(1);
  });

  it('omitting facilitatorNudge from an import-shaped pipeline registers no nudge stage', () => {
    // The stage that would send an outbound question is simply absent --
    // this is what guarantees imports can't trigger a question send.
    buildMessagePipeline({
      dbClient,
      stages: stageSet(
        'router',
        'filter',
        'imageLinker',
        'scribe',
        'registrar',
      ),
      providers: { intern: provider, scribe: provider },
      models: { intern: 'mock-model', scribe: 'mock-model' },
    });

    expect(setRegistrar).toHaveBeenCalledTimes(1);
    expect(setHistorianProcessor).not.toHaveBeenCalled();
  });

  it('wires registrar + storyFollowup together', () => {
    buildMessagePipeline({
      dbClient,
      stages: stageSet('registrar', 'storyFollowup'),
      providers: { followup: provider },
      models: { followup: 'mock-model' },
    });

    expect(setRegistrar).toHaveBeenCalledTimes(1);
    expect(setStoryFollowupHook).toHaveBeenCalledTimes(1);
  });

  it('omitting storyFollowup registers no follow-up hook', () => {
    buildMessagePipeline({
      dbClient,
      stages: stageSet(
        'router',
        'filter',
        'imageLinker',
        'scribe',
        'registrar',
      ),
      providers: { intern: provider, scribe: provider },
      models: { intern: 'mock-model', scribe: 'mock-model' },
    });

    expect(setStoryFollowupHook).not.toHaveBeenCalled();
  });

  describe('validation', () => {
    it('throws requesting admin without messageSender', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('admin'),
          providers: {},
          models: {},
        }),
      ).toThrow(/messageSender/);
    });

    it('throws requesting historian without messageSender', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('historian'),
          providers: { historian: provider },
          models: { historian: 'mock-model' },
        }),
      ).toThrow(/messageSender/);
    });

    it('throws requesting facilitatorNudge without messageSender', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('registrar', 'facilitatorNudge'),
          providers: { facilitator: provider },
          models: {},
        }),
      ).toThrow(/messageSender/);
    });

    it('throws requesting router/filter/imageLinker without providers.intern', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('router'),
          providers: {},
          models: {},
        }),
      ).toThrow(/providers\.intern/);
    });

    it('throws requesting scribe without providers.scribe', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('scribe'),
          providers: {},
          models: {},
        }),
      ).toThrow(/providers\.scribe/);
    });

    it('throws requesting historian without providers.historian', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('historian'),
          providers: {},
          models: {},
          messageSender,
        }),
      ).toThrow(/providers\.historian/);
    });

    it('throws requesting facilitatorNudge without providers.facilitator', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('registrar', 'facilitatorNudge'),
          providers: {},
          models: {},
          messageSender,
        }),
      ).toThrow(/providers\.facilitator/);
    });

    it('throws requesting facilitatorNudge without registrar', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('facilitatorNudge'),
          providers: { facilitator: provider },
          models: { facilitator: 'mock-model' },
          messageSender,
        }),
      ).toThrow(/registrar/);
    });

    it('throws requesting historian without models.facilitator', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('historian'),
          providers: { historian: provider, facilitator: provider },
          models: { historian: 'mock-model' },
          messageSender,
        }),
      ).toThrow(/providers\.facilitator and models\.facilitator/);
    });

    it('throws requesting facilitatorNudge without models.facilitator', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('registrar', 'facilitatorNudge'),
          providers: { facilitator: provider },
          models: {},
          messageSender,
        }),
      ).toThrow(/providers\.facilitator and models\.facilitator/);
    });

    it('throws requesting storyFollowup without providers.followup', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('registrar', 'storyFollowup'),
          providers: {},
          models: {},
        }),
      ).toThrow(/providers\.followup and models\.followup/);
    });

    it('throws requesting storyFollowup without models.followup', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('registrar', 'storyFollowup'),
          providers: { followup: provider },
          models: {},
        }),
      ).toThrow(/providers\.followup and models\.followup/);
    });

    it('throws requesting storyFollowup without registrar', () => {
      expect(() =>
        buildMessagePipeline({
          dbClient,
          stages: stageSet('storyFollowup'),
          providers: { followup: provider },
          models: { followup: 'mock-model' },
        }),
      ).toThrow(/registrar/);
    });
  });
});

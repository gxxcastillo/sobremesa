import { describe, expect, it } from 'vitest';
import {
  compareStableSnapshots,
  type StablePipelineSnapshot,
} from './pipeline-snapshot';

const snapshot: StablePipelineSnapshot = {
  conversationEvents: [
    {
      sequenceNumber: 1,
      sender: 'Minnie',
      content: 'Rosa moved in 1965.',
    },
  ],
  people: [{ name: 'Rosa', aliases: [] }],
  places: [],
  events: [],
  stories: [],
  claims: [
    {
      subject: 'Rosa',
      claimType: 'date',
      claimValue: { value: '1965' },
      claimedBy: 'Minnie',
      claimedBySource: 'direct',
    },
  ],
  relationships: [],
  linkCounts: {
    claimEntities: 1,
    claimRelationships: 0,
    storyPeople: 0,
    storyPlaces: 0,
    storyEvents: 0,
    storyConversationEvents: 0,
    eventPeople: 0,
    eventPlaces: 0,
  },
};

describe('compareStableSnapshots', () => {
  it('passes identical snapshots', () => {
    expect(compareStableSnapshots(snapshot, snapshot)).toEqual({
      passed: true,
      mismatches: [],
    });
  });

  it('reports the mismatched section', () => {
    const expected: StablePipelineSnapshot = {
      ...snapshot,
      people: [{ name: 'Rosa Maria', aliases: [] }],
    };

    const comparison = compareStableSnapshots(snapshot, expected);

    expect(comparison.passed).toBe(false);
    expect(comparison.mismatches).toHaveLength(1);
    expect(comparison.mismatches[0]).toContain('people mismatch');
  });
});

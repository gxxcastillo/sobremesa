import type { EvalSender } from '../lib/scenario';
import type { StablePipelineSnapshot } from '../lib/pipeline-snapshot';

export interface PipelineSnapshotMessage {
  sender: string;
  text: string;
  cannedScribe: Record<string, unknown>;
}

export interface PipelineSnapshotScenario {
  id: string;
  description: string;
  senders: Record<string, EvalSender>;
  messages: PipelineSnapshotMessage[];
  familyConfig?: Record<string, unknown>;
  expected: StablePipelineSnapshot;
}

const senders = {
  minnie: {
    id: 'eval-minnie',
    displayName: 'Minnie',
    username: 'minnie-mouse',
  },
  donald: {
    id: 'eval-donald',
    displayName: 'Donald',
    username: 'donald-duck',
  },
  mickey: {
    id: 'eval-mickey',
    displayName: 'Mickey',
    username: 'mickey-mouse',
  },
} satisfies Record<string, EvalSender>;

export const pipelineSnapshotScenarios: PipelineSnapshotScenario[] = [
  {
    id: 'pipeline-family-history',
    description:
      'Canned Scribe JSON persists people, places, one dated event, relationships, and a location claim.',
    senders,
    messages: [
      {
        sender: 'donald',
        text: 'Abuela Rosa moved from Oaxaca to Guadalajara around 1965, Ernesto was her husband, and Carlos is their son.',
        cannedScribe: {
          detected_language: 'en',
          people: [{ name: 'Rosa' }, { name: 'Ernesto' }, { name: 'Carlos' }],
          places: [
            { name: 'Oaxaca', type: 'city' },
            { name: 'Guadalajara', type: 'city' },
          ],
          events: [
            {
              title: "Rosa's move to Guadalajara",
              event_type: 'migration',
              date: { year: 1965, text: 'around 1965' },
              people_involved: ['Rosa'],
              place: 'Guadalajara',
            },
          ],
          relationships: [
            {
              person_a: 'Rosa',
              person_b: 'Ernesto',
              relationship_type: 'spouse',
            },
            {
              person_a: 'Rosa',
              person_b: 'Carlos',
              relationship_type: 'parent',
            },
            {
              person_a: 'Ernesto',
              person_b: 'Carlos',
              relationship_type: 'parent',
            },
          ],
          claims: [
            {
              claim_type: 'location',
              subject: 'Rosa',
              claim_value: 'moved to Guadalajara around 1965',
              claimed_by: 'Donald',
              claimed_by_source: 'direct',
              referenced_places: ['Guadalajara'],
            },
          ],
        },
      },
    ],
    familyConfig: {
      culturalTerms: ['abuela'],
    },
    expected: {
      conversationEvents: [
        {
          sequenceNumber: 1,
          sender: 'Donald',
          content:
            'Abuela Rosa moved from Oaxaca to Guadalajara around 1965, Ernesto was her husband, and Carlos is their son.',
        },
      ],
      people: [
        { name: 'Carlos', aliases: [] },
        { name: 'Ernesto', aliases: [] },
        { name: 'Rosa', aliases: [] },
      ],
      places: [
        { name: 'Guadalajara', type: 'city' },
        { name: 'Oaxaca', type: 'city' },
      ],
      events: [
        {
          title: "Rosa's move to Guadalajara",
          eventType: 'migration',
          dateText: 'around 1965',
          dateYear: 1965,
        },
      ],
      stories: [],
      claims: [
        {
          subject: 'Rosa',
          claimType: 'location',
          claimValue: { value: 'moved to Guadalajara around 1965' },
          claimedBy: 'Donald',
          claimedBySource: 'direct',
        },
      ],
      relationships: [
        {
          personA: 'Ernesto',
          personB: 'Carlos',
          relationshipType: 'parent',
        },
        {
          personA: 'Rosa',
          personB: 'Carlos',
          relationshipType: 'parent',
        },
        {
          personA: 'Ernesto',
          personB: 'Rosa',
          relationshipType: 'spouse',
        },
      ],
      linkCounts: {
        claimEntities: 2,
        claimRelationships: 0,
        storyPeople: 0,
        storyPlaces: 0,
        storyEvents: 0,
        storyConversationEvents: 0,
        eventPeople: 1,
        eventPlaces: 0,
      },
    },
  },
  {
    id: 'pipeline-same-event-continuation',
    description:
      'Two canned messages mentioning the same dated event persist one event and link the added person.',
    senders,
    messages: [
      {
        sender: 'minnie',
        text: "Sofia's wedding in Puerto Vallarta was in June 2022.",
        cannedScribe: {
          detected_language: 'en',
          people: [{ name: 'Sofia' }],
          places: [{ name: 'Puerto Vallarta', type: 'city' }],
          events: [
            {
              title: "Sofia's wedding",
              event_type: 'marriage',
              date: { year: 2022, text: 'June 2022' },
              people_involved: ['Sofia'],
              place: 'Puerto Vallarta',
            },
          ],
          claims: [
            {
              claim_type: 'date',
              subject: "Sofia's wedding",
              claim_value: 'June 2022',
              claimed_by: 'Minnie',
              claimed_by_source: 'direct',
              referenced_people: ['Sofia'],
              referenced_places: ['Puerto Vallarta'],
            },
          ],
        },
      },
      {
        sender: 'mickey',
        text: 'Carlos walked her down the aisle and cried the whole time.',
        cannedScribe: {
          detected_language: 'en',
          people: [{ name: 'Carlos' }, { name: 'Sofia' }],
          events: [
            {
              title: "Sofia's wedding",
              event_type: 'marriage',
              date: { year: 2022, text: 'June 2022' },
              people_involved: ['Sofia', 'Carlos'],
              place: 'Puerto Vallarta',
            },
          ],
          claims: [
            {
              claim_type: 'detail',
              subject: "Sofia's wedding",
              claim_value: 'Carlos walked Sofia down the aisle',
              claimed_by: 'Mickey',
              claimed_by_source: 'direct',
              referenced_people: ['Carlos', 'Sofia'],
            },
          ],
        },
      },
    ],
    expected: {
      conversationEvents: [
        {
          sequenceNumber: 1,
          sender: 'Minnie',
          content: "Sofia's wedding in Puerto Vallarta was in June 2022.",
        },
        {
          sequenceNumber: 2,
          sender: 'Mickey',
          content: 'Carlos walked her down the aisle and cried the whole time.',
        },
      ],
      people: [
        { name: 'Carlos', aliases: [] },
        { name: 'Sofia', aliases: [] },
      ],
      places: [{ name: 'Puerto Vallarta', type: 'city' }],
      events: [
        {
          title: "Sofia's wedding",
          eventType: 'marriage',
          dateText: 'June 2022',
          dateYear: 2022,
        },
      ],
      stories: [],
      claims: [
        {
          subject: "Sofia's wedding",
          claimType: 'date',
          claimValue: { value: 'June 2022' },
          claimedBy: 'Minnie',
          claimedBySource: 'direct',
        },
        {
          subject: "Sofia's wedding",
          claimType: 'detail',
          claimValue: { value: 'Carlos walked Sofia down the aisle' },
          claimedBy: 'Mickey',
          claimedBySource: 'direct',
        },
      ],
      relationships: [],
      linkCounts: {
        // 2nd claim's referencedPeople is ['Carlos', 'Sofia']: subject (event) +
        // Carlos + Sofia = 3 links, plus the 1st claim's subject (event) + Sofia +
        // Puerto Vallarta = 3 links = 6 total.
        claimEntities: 6,
        claimRelationships: 0,
        storyPeople: 0,
        storyPlaces: 0,
        storyEvents: 0,
        storyConversationEvents: 0,
        eventPeople: 2,
        eventPlaces: 0,
      },
    },
  },
];

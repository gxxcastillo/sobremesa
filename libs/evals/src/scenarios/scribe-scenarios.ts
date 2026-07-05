import type { EvalSender, ScribeEvalScenario } from '../lib/scenario';

const senders = {
  mickey: {
    id: 'eval-mickey',
    displayName: 'Mickey',
    username: 'mickey-mouse',
  },
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
  daisy: {
    id: 'eval-daisy',
    displayName: 'Daisy',
    username: 'daisy-duck',
  },
  carmencita: {
    id: 'eval-carmencita',
    displayName: 'Carmencita',
    username: 'sobremesa-bot',
  },
} satisfies Record<string, EvalSender>;

export const scribeEvalScenarios: ScribeEvalScenario[] = [
  {
    id: 'pronoun-chain-sister',
    description:
      'Pronoun chain resolves "her parents" through Ralphy -> sister context.',
    senders,
    initialContext: [
      {
        sender: 'mickey',
        text: 'Ralphy never recovered after losing the high school football game.',
      },
      {
        sender: 'minnie',
        text: 'His sister seemed delighted by it, which was pretty cruel.',
      },
    ],
    messages: [
      {
        sender: 'daisy',
        text: "I don't know why her parents were so hard on him afterward.",
      },
    ],
    golden: {
      requiredPeople: [
        { name: 'Ralphy' },
        { name: { anyOf: ["Ralphy's sister", 'sister'] } },
      ],
      requiredClaims: [
        {
          subject: {
            anyOf: ["Ralphy's sister's parents", 'her parents', 'parents'],
          },
          valueIncludes: { anyOf: ['hard on Ralphy', 'hard on him'] },
          claimedBySource: 'direct',
        },
      ],
      forbidden: {
        people: ['her parents', 'him afterward'],
        claimSubjects: ['Scribe', 'Carmencita'],
      },
    },
  },
  {
    id: 'oldest-son-disagreement',
    description:
      'Inline pronoun and disagreement preserve Minnie claiming Mark was Marcus oldest son.',
    senders,
    initialContext: [
      {
        sender: 'donald',
        text: "Ralph is Marcus's oldest son.",
      },
    ],
    messages: [
      {
        sender: 'minnie',
        text: 'I thought it was Mark? Mom always said he was the firstborn.',
      },
    ],
    golden: {
      requiredPeople: [{ name: 'Ralph' }, { name: 'Marcus' }, { name: 'Mark' }],
      requiredClaims: [
        {
          subject: 'Mark',
          valueIncludes: { anyOf: ['firstborn', 'oldest son'] },
          attributedTo: 'Mom',
          claimedBySource: 'attributed',
        },
      ],
      forbidden: {
        people: ['it'],
        claimSubjects: ['it was Mark'],
      },
    },
  },
  {
    id: 'full-schema-family-history',
    description:
      'Rich family-history message extracts people, places, events, relationships, and claims.',
    senders,
    messages: [
      {
        sender: 'donald',
        text: "Abuela Rosa moved from Oaxaca to Guadalajara around 1965, and her husband Ernesto built their house there. Carlos is their son, and Sofia's wedding in Puerto Vallarta was in June 2022.",
      },
    ],
    familyConfig: {
      culturalTerms: ['abuela'],
    },
    golden: {
      requiredPeople: [
        { name: 'Rosa' },
        { name: 'Ernesto' },
        { name: 'Carlos' },
        { name: 'Sofia' },
      ],
      requiredPlaces: [
        { name: 'Oaxaca' },
        { name: 'Guadalajara' },
        { name: 'Puerto Vallarta' },
      ],
      requiredEvents: [
        {
          title: { anyOf: ["Rosa's move to Guadalajara", 'moved from Oaxaca'] },
          dateYear: 1965,
        },
        {
          title: { anyOf: ["Sofia's wedding", 'wedding in Puerto Vallarta'] },
          dateYear: 2022,
        },
      ],
      requiredRelationships: [
        { personA: 'Rosa', personB: 'Ernesto', relationshipType: 'spouse' },
        {
          personA: { anyOf: ['Rosa', 'Ernesto'] },
          personB: 'Carlos',
          relationshipType: 'parent',
        },
      ],
      requiredClaims: [
        {
          subject: 'Rosa',
          valueIncludes: { anyOf: ['1965', 'Guadalajara'] },
          claimedBySource: 'direct',
        },
      ],
    },
  },
  {
    id: 'dedup-same-event-continuation',
    description:
      'Same event continued across messages should not become duplicate current-message events.',
    senders,
    messages: [
      {
        sender: 'minnie',
        text: "Sofia's wedding in Puerto Vallarta was in June 2022.",
      },
      {
        sender: 'mickey',
        text: 'Carlos walked her down the aisle and cried the whole time.',
      },
    ],
    golden: {
      requiredPeople: [{ name: 'Sofia' }, { name: 'Carlos' }],
      requiredEvents: [
        {
          title: { anyOf: ["Sofia's wedding", 'wedding in Puerto Vallarta'] },
          dateYear: 2022,
        },
      ],
      requiredClaims: [
        {
          subject: { anyOf: ["Sofia's wedding", 'wedding in Puerto Vallarta'] },
          valueIncludes: {
            anyOf: ['Carlos walked', 'walked her down the aisle'],
          },
          claimedBySource: 'direct',
        },
      ],
    },
  },
  {
    id: 'dedup-distinct-events-same-title',
    description:
      'Two similar wedding events with years more than five years apart stay distinct.',
    senders,
    messages: [
      {
        sender: 'daisy',
        text: "Maria's wedding in Oaxaca was in 1998.",
      },
      {
        sender: 'donald',
        text: "Different Maria, but Maria's wedding in Seattle was in 2010.",
      },
    ],
    golden: {
      requiredPeople: [{ name: 'Maria' }],
      requiredPlaces: [{ name: 'Oaxaca' }, { name: 'Seattle' }],
      requiredEvents: [
        {
          title: { anyOf: ["Maria's wedding in Oaxaca", 'wedding in Oaxaca'] },
          dateYear: 1998,
        },
        {
          title: {
            anyOf: ["Maria's wedding in Seattle", 'wedding in Seattle'],
          },
          dateYear: 2010,
        },
      ],
    },
  },
  {
    id: 'dedup-untitled-stories-need-anchor',
    description:
      'Untitled stories from the same speaker do not merge without a shared person or theme anchor.',
    senders,
    messages: [
      {
        sender: 'mickey',
        text: 'When I was little, abuela taught me to make tamales every Christmas Eve.',
      },
      {
        sender: 'mickey',
        text: 'Another thing I remember is the bus ride to León with Uncle Tito, totally separate trip.',
      },
    ],
    familyConfig: {
      culturalTerms: ['abuela', 'tamales', 'León'],
    },
    golden: {
      requiredPeople: [
        { name: 'Mickey' },
        { name: { anyOf: ['abuela', 'grandmother'] } },
        { name: 'Tito' },
      ],
      requiredPlaces: [{ name: 'León' }],
      requiredStories: [
        { contentIncludes: { anyOf: ['tamales', 'Christmas Eve'] } },
        { contentIncludes: { anyOf: ['bus ride to León', 'separate trip'] } },
      ],
    },
  },
  {
    id: 'dedup-multilingual-possessive-subject',
    description:
      'Spanish possessive subject "la boda de María" keeps Maria as the event owner.',
    senders,
    messages: [
      {
        sender: 'minnie',
        text: 'La boda de María fue en Granada en 2005, en la iglesia del barrio.',
      },
    ],
    familyConfig: {
      culturalTerms: ['boda'],
    },
    golden: {
      requiredPeople: [{ name: 'María' }],
      requiredPlaces: [{ name: 'Granada' }],
      requiredEvents: [
        {
          title: { anyOf: ['boda de María', "María's wedding"] },
          dateYear: 2005,
        },
      ],
      requiredClaims: [
        {
          subject: { anyOf: ['boda de María', "María's wedding"] },
          valueIncludes: { anyOf: ['Granada', 'iglesia'] },
          claimedBySource: 'direct',
        },
      ],
      forbidden: {
        people: ['boda'],
      },
    },
  },
  {
    id: 'order-dependent-pronoun-chronology',
    description:
      'Pronoun resolution follows true chronological context, not newest-first prompt order.',
    senders,
    initialContext: [
      {
        sender: 'mickey',
        text: 'Aunt Rosa moved to Chicago in 1950.',
      },
      {
        sender: 'minnie',
        text: 'Aunt Elena moved to Miami in 1962.',
      },
    ],
    messages: [
      {
        sender: 'daisy',
        text: 'She later opened a bakery there.',
      },
    ],
    golden: {
      requiredPeople: [{ name: 'Elena' }],
      requiredPlaces: [{ name: 'Miami' }],
      requiredClaims: [
        {
          subject: 'Elena',
          valueIncludes: { anyOf: ['bakery', 'opened a bakery'] },
          claimedBySource: 'direct',
        },
      ],
      forbidden: {
        claimSubjects: ['Rosa'],
      },
    },
  },
  {
    id: 'reply-to-old-message',
    description:
      'Reply block resolves a short answer to the replied-to message even outside the context window.',
    senders,
    contextWindow: 1,
    initialContext: [
      {
        sender: 'mickey',
        text: "Tía Elena's cafe was in León.",
      },
      {
        sender: 'donald',
        text: 'Rosa used to talk about the school in Granada.',
      },
      {
        sender: 'minnie',
        text: 'Carlos remembered the train station in Managua.',
      },
    ],
    messages: [
      {
        sender: 'daisy',
        replyTo: 0,
        text: 'It opened in 1978.',
      },
    ],
    familyConfig: {
      culturalTerms: ['Tía', 'León'],
    },
    golden: {
      requiredPeople: [{ name: 'Elena' }],
      requiredPlaces: [{ name: 'León' }],
      requiredClaims: [
        {
          subject: { anyOf: ["Elena's cafe", 'cafe'] },
          valueIncludes: '1978',
          claimedBySource: 'direct',
        },
      ],
      forbidden: {
        claimSubjects: ['Rosa', 'Carlos', 'train station'],
      },
    },
  },
  {
    id: 'context-bleed-trap',
    description:
      'A bare agreement after another speaker states a fact must not restamp that fact to the current speaker.',
    senders,
    initialContext: [
      {
        sender: 'donald',
        text: 'Grandpa Ernesto was born in 1939.',
      },
    ],
    messages: [
      {
        sender: 'minnie',
        text: 'That sounds right to me.',
      },
    ],
    golden: {
      requiredPeople: [],
      requiredClaims: [],
      forbidden: {
        claimSubjects: ['Ernesto', 'Grandpa Ernesto'],
      },
    },
  },
  {
    id: 'bot-question-answer',
    description:
      'Bare answer to a bot question uses context without extracting the bot as a family person.',
    senders,
    messages: [
      {
        sender: 'daisy',
        answeredQuestion: {
          askedByName: 'Carmencita',
          content:
            'If you happen to remember, what year did Rosa move to Guadalajara?',
        },
        text: '1965, I think.',
      },
    ],
    golden: {
      requiredPeople: [{ name: 'Rosa' }],
      requiredPlaces: [{ name: 'Guadalajara' }],
      requiredClaims: [
        {
          subject: 'Rosa',
          claimType: 'date',
          valueIncludes: '1965',
          claimedBySource: 'direct',
        },
      ],
      forbidden: {
        people: ['Carmencita', 'Sobremesa'],
        claimSubjects: ['Carmencita'],
      },
    },
  },
  {
    id: 'bot-question-confirmation',
    description:
      'A bare yes-confirmation of a bot question asserts the confirmed fact (the question was never itself recorded), unlike a bare agreement with a family member.',
    senders,
    messages: [
      {
        sender: 'minnie',
        answeredQuestion: {
          askedByName: 'Carmencita',
          content: "Was Sofia's wedding in Puerto Vallarta in June 2022?",
        },
        text: 'Yes, that is right.',
      },
    ],
    golden: {
      // The question confirms two facts (place and date); extracting either
      // one claim per fact or a combined claim covering both is acceptable.
      requiredClaims: [
        {
          subject: { anyOf: ["Sofia's wedding", 'Sofia'] },
          valueIncludes: { anyOf: ['2022', 'June'] },
        },
        {
          subject: { anyOf: ["Sofia's wedding", 'Sofia'] },
          valueIncludes: 'Puerto Vallarta',
        },
      ],
      forbidden: {
        people: ['Carmencita', 'Sobremesa'],
      },
    },
  },
];

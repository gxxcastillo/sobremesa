import {
  ClaimRepository,
  ClaimEntityRepository,
  PersonRepository,
  PlaceRepository,
  TimelineEventRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import type {
  Claim,
  Person,
  Place,
  TimelineEvent,
} from '@sobremesa/shared-types';
import {
  classifyPersonName,
  normalizeNameKey,
  textMentionsName,
} from '@sobremesa/shared-utils';
import type { RecordContext } from './types';

/** Cap on how many of an entity's claims (each side of the message split) go
 * into the prompt -- an unbounded record for a long-tracked person would
 * blow the prompt budget. */
const CLAIMS_PER_ENTITY_CAP = 8;

/**
 * Cap on how many people/places a text-only fallback lookup (#10) adds to
 * the record, each -- a context budget so a common name shared by many
 * family members can't balloon the prompt.
 */
const FALLBACK_LOOKUP_CAP = 3;

/**
 * Groups entities by exact normalized name and drops any group with more
 * than one member. Two different real people can share a literal name (e.g.
 * two "Michel Vega"s); a text-only mention can't tell them apart, and
 * guessing either one risks attaching the wrong person's history to a story
 * (#10) -- precision over recall (AGENTS.md), so an ambiguous name is
 * excluded rather than resolved by assumption.
 */
function excludingAmbiguousNames<T extends { name: string }>(
  entities: T[],
): T[] {
  const byName = new Map<string, T[]>();
  for (const entity of entities) {
    const key = normalizeNameKey(entity.name);
    const group = byName.get(key) ?? [];
    group.push(entity);
    byName.set(key, group);
  }
  return [...byName.values()]
    .filter((group) => group.length === 1)
    .map((group) => group[0]);
}

export interface RecordContextBuilderOptions {
  dbClient?: DatabaseClient;
  claimRepo?: ClaimRepository;
  claimEntityRepo?: ClaimEntityRepository;
  personRepo?: PersonRepository;
  placeRepo?: PlaceRepository;
  timelineEventRepo?: TimelineEventRepository;
}

/**
 * Builds the "what the family record already holds" block and hints for one
 * message. Ports `buildRecordContext` from
 * `.agents/scripts/question-wording.ts` (the W experiment) onto
 * repositories. Every query it depends on is explicitly ordered -- W found
 * that an unordered query changed which claims a capped list showed the
 * model between otherwise-identical calls.
 *
 * Unlike the experiment script, this never sees claims from a "later"
 * message: the live queue processes one family's events strictly in order
 * (spec/overview.md), so by the time this runs for event N, no event after N
 * has been persisted yet.
 */
export class RecordContextBuilder {
  private claimRepo!: ClaimRepository;
  private claimEntityRepo!: ClaimEntityRepository;
  private personRepo!: PersonRepository;
  private placeRepo!: PlaceRepository;
  private timelineEventRepo!: TimelineEventRepository;

  constructor(options?: RecordContextBuilderOptions) {
    const dbClient = options?.dbClient;

    if (options?.claimRepo) {
      this.claimRepo = options.claimRepo;
    } else if (dbClient) {
      this.claimRepo = new ClaimRepository(dbClient);
    }

    if (options?.claimEntityRepo) {
      this.claimEntityRepo = options.claimEntityRepo;
    } else if (dbClient) {
      this.claimEntityRepo = new ClaimEntityRepository(dbClient);
    }

    if (options?.personRepo) {
      this.personRepo = options.personRepo;
    } else if (dbClient) {
      this.personRepo = new PersonRepository(dbClient);
    }

    if (options?.placeRepo) {
      this.placeRepo = options.placeRepo;
    } else if (dbClient) {
      this.placeRepo = new PlaceRepository(dbClient);
    }

    if (options?.timelineEventRepo) {
      this.timelineEventRepo = options.timelineEventRepo;
    } else if (dbClient) {
      this.timelineEventRepo = new TimelineEventRepository(dbClient);
    }

    if (
      !this.claimRepo ||
      !this.claimEntityRepo ||
      !this.personRepo ||
      !this.placeRepo ||
      !this.timelineEventRepo
    ) {
      throw new Error(
        'RecordContextBuilder requires either dbClient or all repository instances',
      );
    }
  }

  /**
   * `messageText` is used only as a bounded, read-only fallback (#10) when
   * the current event produced no claims at all -- an Intern-ignored
   * message never reaches Scribe, so `fetchNamedEntities` (claim-linked)
   * always comes back empty even when the text names a well-documented
   * person. Never merges entities or writes claims.
   */
  async build(
    familyId: string,
    eventId: string,
    messageText?: string,
  ): Promise<RecordContext> {
    let named = await this.fetchNamedEntities(familyId, eventId);

    if (
      messageText &&
      !named.people.length &&
      !named.places.length &&
      !named.events.length
    ) {
      const fallback = await this.fallbackNamedEntities(familyId, messageText);
      if (fallback.people.length || fallback.places.length) {
        named = { ...named, ...fallback };
      }
    }

    const lines: string[] = [];
    const hints: string[] = [];
    const pushClaims = (claims: { prior: Claim[]; fromMessage: Claim[] }) => {
      for (const c of claims.prior) lines.push(`    - ${claimText(c)}`);
      for (const c of claims.fromMessage) {
        lines.push(`    - (from this message) ${claimText(c)}`);
      }
    };

    if (named.people.length) {
      lines.push('People named in this message:');
      for (const person of named.people) {
        const claims = await this.entityClaimsSplit(
          familyId,
          'person',
          person.id,
          eventId,
        );
        const tag = person.isPlaceholder ? ' [unnamed placeholder]' : '';
        lines.push(`- ${person.name}${tag}`);
        pushClaims(claims);
        if (
          person.isPlaceholder &&
          classifyPersonName(person.name) === 'relational'
        ) {
          hints.push(
            `"${person.name}" is a named person the record has never identified.`,
          );
        }
      }
    }

    if (named.places.length) {
      lines.push('Places named in this message:');
      for (const place of named.places) {
        const claims = await this.entityClaimsSplit(
          familyId,
          'place',
          place.id,
          eventId,
        );
        lines.push(`- ${place.name}`);
        pushClaims(claims);
      }
    }

    if (named.events.length) {
      lines.push('Events named in this message:');
      for (const event of named.events) {
        const claims = await this.entityClaimsSplit(
          familyId,
          'event',
          event.id,
          eventId,
        );
        const dated = event.dateYear != null || Boolean(event.dateText);
        lines.push(
          `- ${event.title}${dated ? ` (${event.dateText ?? event.dateYear})` : ' [no recorded date]'}`,
        );
        pushClaims(claims);
        if (!dated) {
          hints.push(`The event "${event.title}" has no recorded date.`);
        }
      }
    }

    if (named.disputedHere) {
      hints.push(
        'This message touches a claim the record has flagged as disputed/contradicted.',
      );
    }

    return {
      block: lines.length
        ? lines.join('\n')
        : '(nothing else recorded about people/places/events named here)',
      hints,
    };
  }

  /**
   * The people, places and events named in this message -- found via the
   * claims it produced and the entities those claims link to (Registrar's
   * `claim_entities` rows), the same path
   * `.agents/scripts/question-wording.ts` used.
   */
  private async fetchNamedEntities(
    familyId: string,
    eventId: string,
  ): Promise<{
    people: Person[];
    places: Place[];
    events: TimelineEvent[];
    disputedHere: boolean;
  }> {
    const claims = await this.claimRepo.findByConversationEvent(
      familyId,
      eventId,
    );
    const disputedHere = claims.some((c) => c.status === 'disputed');
    if (!claims.length) {
      return { people: [], places: [], events: [], disputedHere };
    }

    const links = await this.claimEntityRepo.findByClaims(
      familyId,
      claims.map((c) => c.id),
    );

    const idsFor = (entityType: string) => [
      ...new Set(
        links.filter((l) => l.entityType === entityType).map((l) => l.entityId),
      ),
    ];
    const personIds = idsFor('person');
    const placeIds = idsFor('place');
    const eventIds = idsFor('event');

    const [people, places, events] = await Promise.all([
      this.personRepo.findByIds(familyId, personIds),
      this.placeRepo.findByIds(familyId, placeIds),
      this.timelineEventRepo.findByIds(familyId, eventIds),
    ]);

    return { people, places, events, disputedHere };
  }

  /**
   * Bounded, read-only text-mention fallback (#10) for when
   * `fetchNamedEntities` found nothing to link from -- scans every active,
   * non-placeholder person/place the family has and keeps the ones the
   * message text actually names (whole-word, `textMentionsName`). Never
   * touches the database beyond these reads: no entity match is created,
   * merged, or otherwise persisted.
   */
  private async fallbackNamedEntities(
    familyId: string,
    messageText: string,
  ): Promise<{ people: Person[]; places: Place[] }> {
    const [people, places] = await Promise.all([
      this.personRepo.findAllActive(familyId),
      this.placeRepo.findAllActive(familyId),
    ]);

    const matchedPeople = excludingAmbiguousNames(
      people.filter(
        (p) => !p.isPlaceholder && textMentionsName(messageText, p.name),
      ),
    ).slice(0, FALLBACK_LOOKUP_CAP);

    const matchedPlaces = excludingAmbiguousNames(
      places.filter((p) => textMentionsName(messageText, p.name)),
    ).slice(0, FALLBACK_LOOKUP_CAP);

    return { people: matchedPeople, places: matchedPlaces };
  }

  /**
   * One entity's active claim history, split into what was already on
   * record (`prior`) and what this message itself contributed
   * (`fromMessage`) -- the record block marks the latter "(from this
   * message)" so the prompt never reads a claim's own source message as
   * something already known (story-followups-plan.md #0).
   */
  private async entityClaimsSplit(
    familyId: string,
    entityType: 'person' | 'place' | 'event',
    entityId: string,
    eventId: string,
  ): Promise<{ prior: Claim[]; fromMessage: Claim[] }> {
    const claims = await this.claimRepo.findByEntity(
      familyId,
      entityType,
      entityId,
    );
    const prior: Claim[] = [];
    const fromMessage: Claim[] = [];
    for (const c of claims) {
      if (c.conversationEventId === eventId) {
        fromMessage.push(c);
      } else {
        prior.push(c);
      }
    }
    return {
      prior: prior.slice(0, CLAIMS_PER_ENTITY_CAP),
      fromMessage: fromMessage.slice(0, CLAIMS_PER_ENTITY_CAP),
    };
  }
}

function claimText(c: Claim): string {
  const v = c.claimValue as Record<string, unknown> | null;
  const value =
    v && typeof v === 'object' && 'value' in v
      ? String(v['value'])
      : JSON.stringify(v);
  return `${c.subject} — ${value} (${c.claimType})`;
}

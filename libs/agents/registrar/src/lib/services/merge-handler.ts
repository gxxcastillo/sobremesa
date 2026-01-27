import type { EntityMerge } from '@sobremesa/shared-types';
import {
  EntityMergeRepository,
  PersonRepository,
  PlaceRepository,
  TimelineEventRepository,
  StoryRepository,
} from '@sobremesa/database';

/**
 * Service for handling entity merge and unmerge operations.
 */
export class MergeHandlerService {
  constructor(
    private entityMergeRepo: EntityMergeRepository,
    private personRepo: PersonRepository,
    private placeRepo: PlaceRepository,
    private eventRepo: TimelineEventRepository,
    private storyRepo: StoryRepository,
  ) {}

  /**
   * Merge two entities together.
   *
   * @param familyId - Family ID
   * @param sourceEntityId - Entity being merged away
   * @param targetEntityId - Entity being kept
   * @param entityType - Type of entity
   * @param options - Merge options
   * @returns The created merge record
   */
  async mergeEntities(
    familyId: string,
    sourceEntityId: string,
    targetEntityId: string,
    entityType: 'person' | 'place' | 'event' | 'story',
    options: {
      strategy: 'fuzzy_match' | 'identity_claim' | 'manual' | 'llm_resolved';
      confidence: number;
      triggerEventId: string;
      reason: string;
    },
  ): Promise<EntityMerge> {
    // 1. Create merge record
    const merge = await this.entityMergeRepo.createMerge(
      familyId,
      sourceEntityId,
      entityType,
      targetEntityId,
      entityType,
      {
        mergeStrategy: options.strategy,
        confidence: options.confidence,
        triggerEventId: options.triggerEventId,
        mergedBy: 'registrar',
        mergeReason: options.reason,
      },
    );

    // 2. Update superseded_by on source entity
    await this.markSuperseded(
      familyId,
      sourceEntityId,
      targetEntityId,
      entityType,
    );

    return merge;
  }

  /**
   * Delete a merge (undo operation).
   *
   * @param familyId - Family ID
   * @param mergeId - Merge record ID to delete
   */
  async deleteMerge(familyId: string, mergeId: string): Promise<void> {
    // Get the merge record first
    const merge = await this.entityMergeRepo.findById(familyId, mergeId);
    if (!merge) {
      throw new Error(`Merge ${mergeId} not found`);
    }

    // 1. Clear superseded_by on source entity
    const repo = this.getRepoForType(merge.sourceEntityType);
    await repo.update(familyId, merge.sourceEntityId, {
      supersededBy: null,
      supersededAt: null,
    } as any);

    // 2. Delete the merge record
    await this.entityMergeRepo.deleteMerge(familyId, mergeId);
  }

  /**
   * Mark an entity as superseded.
   */
  private async markSuperseded(
    familyId: string,
    sourceId: string,
    targetId: string,
    entityType: string,
  ): Promise<void> {
    const repo = this.getRepoForType(entityType);
    await repo.update(familyId, sourceId, {
      supersededBy: targetId,
      supersededAt: new Date(),
    } as any);
  }

  /**
   * Get repository for entity type.
   */
  private getRepoForType(
    entityType: string,
  ):
    | PersonRepository
    | PlaceRepository
    | TimelineEventRepository
    | StoryRepository {
    switch (entityType) {
      case 'person':
        return this.personRepo;
      case 'place':
        return this.placeRepo;
      case 'event':
        return this.eventRepo;
      case 'story':
        return this.storyRepo;
      default:
        throw new Error(`Unknown entity type: ${entityType}`);
    }
  }
}

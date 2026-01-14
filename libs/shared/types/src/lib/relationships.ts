/**
 * Relationship utilities for normalization and derivation.
 *
 * Core model:
 * - Only 'parent' and 'spouse' are structural (backbone of family tree)
 * - Other relationships (sibling, grandparent, cousin) are DERIVED via graph traversal
 * - Categories distinguish biological, legal, functional, honorary, and social
 * - Qualifiers capture nuances (half, step, adoptive, maternal, paternal)
 */

import type { RelationshipCategory, RelationshipType } from './entities';

/**
 * Structural relationship types that form the family tree backbone.
 */
export const STRUCTURAL_TYPES: RelationshipType[] = ['parent', 'spouse'];

/**
 * Symmetric relationship types where person order doesn't matter semantically.
 */
export const SYMMETRIC_TYPES: RelationshipType[] = ['spouse', 'friend'];

/**
 * Default category for each relationship type.
 */
export const DEFAULT_CATEGORIES: Record<string, RelationshipCategory> = {
  parent: 'biological',
  spouse: 'legal',
  guardian: 'legal',
  godparent: 'honorary',
  mentor: 'social',
  friend: 'social',
  caregiver: 'functional',
};

/**
 * Result of normalizing a relationship.
 */
export interface NormalizedRelationship {
  personAId: string;
  personBId: string;
  relationshipType: RelationshipType;
  category: RelationshipCategory;
}

/**
 * Normalize a relationship for consistent storage.
 *
 * Rules:
 * - 'parent': personA is always the parent, personB is the child
 * - 'spouse' and other symmetric types: order by UUID (lower first)
 * - Other types: personA is the role-holder, personB is the recipient
 *
 * @param personAId - First person as stated
 * @param personBId - Second person as stated
 * @param relationshipType - The relationship type
 * @param category - Optional category (defaults based on type)
 * @returns Normalized relationship with consistent ordering
 */
export function normalizeRelationship(
  personAId: string,
  personBId: string,
  relationshipType: string,
  category?: RelationshipCategory
): NormalizedRelationship {
  const type = relationshipType.toLowerCase();
  const resolvedCategory = category || DEFAULT_CATEGORIES[type] || 'biological';

  // Handle 'child' input -> convert to 'parent' with swapped order
  if (type === 'child') {
    return {
      personAId: personBId, // The "child" input means personB is actually the parent
      personBId: personAId,
      relationshipType: 'parent',
      category: resolvedCategory,
    };
  }

  // Handle symmetric relationships - order by UUID for consistency
  if (SYMMETRIC_TYPES.includes(type as RelationshipType)) {
    const [first, second] =
      personAId < personBId ? [personAId, personBId] : [personBId, personAId];

    return {
      personAId: first,
      personBId: second,
      relationshipType: type,
      category: resolvedCategory,
    };
  }

  // Non-symmetric: keep order as-is (personA is role-holder)
  return {
    personAId,
    personBId,
    relationshipType: type,
    category: resolvedCategory,
  };
}

/**
 * Derived relationship types that can be computed from the graph.
 */
export type DerivedRelationshipType =
  | 'sibling'
  | 'half-sibling'
  | 'step-sibling'
  | 'grandparent'
  | 'grandchild'
  | 'aunt'
  | 'uncle'
  | 'niece'
  | 'nephew'
  | 'cousin'
  | 'parent-in-law'
  | 'child-in-law'
  | 'sibling-in-law';

/**
 * Get the inverse perspective of a relationship type.
 *
 * @param type - The relationship type from personA's perspective
 * @returns The relationship type from personB's perspective
 */
export function getInverseType(type: string): string {
  const inverses: Record<string, string> = {
    parent: 'child',
    child: 'parent',
    spouse: 'spouse',
    guardian: 'ward',
    ward: 'guardian',
    godparent: 'godchild',
    godchild: 'godparent',
    mentor: 'mentee',
    mentee: 'mentor',
    friend: 'friend',
    caregiver: 'care-recipient',
    'care-recipient': 'caregiver',
  };

  return inverses[type.toLowerCase()] || type;
}

/**
 * Get the relationship from a specific person's perspective.
 *
 * @param personAId - Stored person A
 * @param personBId - Stored person B
 * @param relationshipType - Stored relationship type
 * @param fromPersonId - The person whose perspective we want
 * @returns The relationship from that person's perspective
 */
export function getRelationshipPerspective(
  personAId: string,
  personBId: string,
  relationshipType: string,
  fromPersonId: string
): { toPersonId: string; relationshipType: string } {
  if (fromPersonId === personAId) {
    return {
      toPersonId: personBId,
      relationshipType: relationshipType,
    };
  }

  if (fromPersonId === personBId) {
    return {
      toPersonId: personAId,
      relationshipType: getInverseType(relationshipType),
    };
  }

  throw new Error(`Person ${fromPersonId} is not part of this relationship`);
}

/**
 * Check if a relationship type is structural (part of tree backbone).
 */
export function isStructuralType(type: string): boolean {
  return STRUCTURAL_TYPES.includes(type as RelationshipType);
}

/**
 * Common qualifiers for relationships.
 */
export const RELATIONSHIP_QUALIFIERS = {
  // Parent/child qualifiers
  biological: 'biological',
  adoptive: 'adoptive',
  step: 'step',
  foster: 'foster',

  // Sibling qualifiers (for derived relationships)
  half: 'half',
  full: 'full',

  // Lineage qualifiers
  maternal: 'maternal',
  paternal: 'paternal',

  // Status qualifiers
  estranged: 'estranged',
} as const;

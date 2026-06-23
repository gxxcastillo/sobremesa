/**
 * Identity Routes
 *
 * Handles identity/person claiming for family members:
 * - GET /api/family/:familyId/identity - Get current identity claim + suggestions
 * - POST /api/family/:familyId/identity/claim - Claim a person
 * - DELETE /api/family/:familyId/identity/claim - Unclaim person
 * - GET /api/family/:familyId/people - List all people for manual selection
 * - POST /api/family/:familyId/people - Create a new person (for self-registration)
 */

import { Elysia, t } from 'elysia';
import { PersonRepository, type DatabaseClient } from '@sobremesa/database';
import { FamilyAccessRepository, hasAccessToFamily } from '@sobremesa/auth';

/**
 * Person suggestion with match info
 */
interface PersonSuggestion {
  id: string;
  name: string;
  aliases: string[];
  birthYear: number | null;
  deathYear: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  matchReason: string | null;
}

/**
 * Identity routes Elysia app
 */
export function identityRoutes(dbClient: DatabaseClient) {
  return (
    new Elysia({ prefix: '/api/family' })
      /**
       * GET /api/family/:familyId/identity
       * Get current identity claim and suggestions
       */
      .get(
        '/:familyId/identity',
        async (ctx) => {
          const {
            params: { familyId },
            set,
          } = ctx;
          const auth = (ctx as any).auth;
          if (!auth.isAuthenticated || !auth.identity) {
            set.status = 401;
            return { error: 'Authentication required' };
          }

          if (!hasAccessToFamily(auth, familyId)) {
            set.status = 403;
            return { error: 'Access denied to this family' };
          }

          const accessRepo = new FamilyAccessRepository(dbClient);
          const personRepo = new PersonRepository(dbClient);
          const client = dbClient;

          // Get current family access (includes person_id claim)
          const access = await accessRepo.findByIdentityAndFamily(
            auth.identity.id,
            familyId,
          );

          let currentClaim:
            | (PersonSuggestion & { notes?: string | null })
            | null = null;
          if (access?.personId) {
            const { data: personData } = await client
              .from('people')
              .select(
                'id, name, aliases, birth_year, death_year, notes_original',
              )
              .eq('id', access.personId)
              .single();

            if (personData) {
              currentClaim = {
                id: personData.id,
                name: personData.name,
                aliases: personData.aliases || [],
                birthYear: personData.birth_year ?? null,
                deathYear: personData.death_year ?? null,
                confidence: null,
                matchReason: null,
                notes: personData.notes_original ?? null,
              };
            }
          }

          // Get suggestion based on display name
          let suggestion: PersonSuggestion | null = null;
          const displayName =
            auth.identity.displayName || auth.user?.displayName || null;

          if (displayName && !currentClaim) {
            const match = await personRepo.findBestMatch(
              familyId,
              displayName,
              [],
            );
            if (match) {
              suggestion = {
                id: match.person.id,
                name: match.person.name,
                aliases: match.person.aliases || [],
                birthYear: match.person.birthYear ?? null,
                deathYear: match.person.deathYear ?? null,
                confidence: match.confidence,
                matchReason: match.matchReason,
              };
            }
          }

          // Get top people (most recently active) for manual selection
          const { data: topPeopleData } = await client
            .from('people')
            .select('id, name, aliases, birth_year, death_year')
            .eq('family_id', familyId)
            .eq('redacted', false)
            .or('is_placeholder.is.null,is_placeholder.eq.false')
            .order('updated_at', { ascending: false })
            .limit(10);

          const topPeople: PersonSuggestion[] = (topPeopleData || []).map(
            (p) => ({
              id: p.id,
              name: p.name,
              aliases: p.aliases || [],
              birthYear: p.birth_year ?? null,
              deathYear: p.death_year ?? null,
              confidence: null,
              matchReason: null,
            }),
          );

          return {
            currentClaim,
            suggestion,
            topPeople,
            displayName,
          };
        },
        {
          params: t.Object({ familyId: t.String() }),
          detail: {
            tags: ['Identity'],
            description: 'Get current identity claim and suggestions',
          },
        },
      )
      /**
       * POST /api/family/:familyId/identity/claim
       * Claim a person as your identity in this family
       */
      .post(
        '/:familyId/identity/claim',
        async (ctx) => {
          const {
            params: { familyId },
            body,
            set,
          } = ctx;
          const auth = (ctx as any).auth;
          if (!auth.isAuthenticated || !auth.identity) {
            set.status = 401;
            return { error: 'Authentication required' };
          }

          if (!hasAccessToFamily(auth, familyId)) {
            set.status = 403;
            return { error: 'Access denied to this family' };
          }

          const { personId } = body;
          const client = dbClient;

          // Verify person exists in this family
          const { data: person, error: personError } = await client
            .from('people')
            .select('id, name')
            .eq('id', personId)
            .eq('family_id', familyId)
            .eq('redacted', false)
            .single();

          if (personError || !person) {
            set.status = 404;
            return { error: 'Person not found in this family' };
          }

          // Check if this person is already claimed by someone else
          const { data: existingClaim } = await client
            .from('family_access')
            .select('identity_id')
            .eq('family_id', familyId)
            .eq('person_id', personId)
            .neq('identity_id', auth.identity.id)
            .eq('status', 'active')
            .single();

          if (existingClaim) {
            set.status = 409;
            return { error: 'This person is already claimed by another user' };
          }

          // Claim the person
          const accessRepo = new FamilyAccessRepository(dbClient);
          await accessRepo.claimPerson(auth.identity.id, familyId, personId);

          return {
            success: true,
            claimed: {
              personId: person.id,
              personName: person.name,
            },
          };
        },
        {
          params: t.Object({ familyId: t.String() }),
          body: t.Object({ personId: t.String() }),
          detail: {
            tags: ['Identity'],
            description: 'Claim a person as your identity in this family',
          },
        },
      )
      /**
       * DELETE /api/family/:familyId/identity/claim
       * Remove your identity claim in this family
       */
      .delete(
        '/:familyId/identity/claim',
        async (ctx) => {
          const {
            params: { familyId },
            set,
          } = ctx;
          const auth = (ctx as any).auth;
          if (!auth.isAuthenticated || !auth.identity) {
            set.status = 401;
            return { error: 'Authentication required' };
          }

          if (!hasAccessToFamily(auth, familyId)) {
            set.status = 403;
            return { error: 'Access denied to this family' };
          }

          const accessRepo = new FamilyAccessRepository(dbClient);
          await accessRepo.unclaimPerson(auth.identity.id, familyId);

          return { success: true };
        },
        {
          params: t.Object({ familyId: t.String() }),
          detail: {
            tags: ['Identity'],
            description: 'Remove your identity claim in this family',
          },
        },
      )
      /**
       * GET /api/family/:familyId/people
       * List all people in a family for manual selection
       */
      .get(
        '/:familyId/people',
        async (ctx) => {
          const {
            params: { familyId },
            query,
            set,
          } = ctx;
          const auth = (ctx as any).auth;
          if (!auth.isAuthenticated || !auth.identity) {
            set.status = 401;
            return { error: 'Authentication required' };
          }

          if (!hasAccessToFamily(auth, familyId)) {
            set.status = 403;
            return { error: 'Access denied to this family' };
          }

          const client = dbClient;
          const { search } = query;

          let queryBuilder = client
            .from('people')
            .select('id, name, aliases, birth_year, death_year')
            .eq('family_id', familyId)
            .eq('redacted', false)
            .or('is_placeholder.is.null,is_placeholder.eq.false')
            .order('name', { ascending: true });

          if (search) {
            queryBuilder = queryBuilder.ilike('name', `%${search}%`);
          }

          const { data, error } = await queryBuilder.limit(50);

          if (error) {
            set.status = 500;
            return { error: 'Failed to fetch people' };
          }

          const people = (data || []).map((p) => ({
            id: p.id,
            name: p.name,
            aliases: p.aliases || [],
            birthYear: p.birth_year ?? null,
            deathYear: p.death_year ?? null,
          }));

          return { people };
        },
        {
          params: t.Object({ familyId: t.String() }),
          query: t.Object({ search: t.Optional(t.String()) }),
          detail: {
            tags: ['Identity'],
            description: 'List all people in a family for manual selection',
          },
        },
      )
      /**
       * POST /api/family/:familyId/people
       * Create a new person record (for self-registration)
       */
      .post(
        '/:familyId/people',
        async (ctx) => {
          const {
            params: { familyId },
            body,
            set,
          } = ctx;
          const auth = (ctx as any).auth;
          if (!auth.isAuthenticated || !auth.identity) {
            set.status = 401;
            return { error: 'Authentication required' };
          }

          if (!hasAccessToFamily(auth, familyId)) {
            set.status = 403;
            return { error: 'Access denied to this family' };
          }

          const { name, aliases, birthYear, notes } = body;
          const client = dbClient;

          // Validate name
          if (!name || name.trim().length === 0) {
            set.status = 400;
            return { error: 'Name is required' };
          }

          // Check for duplicate name
          const { data: existing } = await client
            .from('people')
            .select('id')
            .eq('family_id', familyId)
            .ilike('name', name.trim())
            .eq('redacted', false)
            .single();

          if (existing) {
            set.status = 409;
            return { error: 'A person with this name already exists' };
          }

          // Create the person
          // User-provided birth year has highest confidence
          const { data: person, error: createError } = await client
            .from('people')
            .insert({
              family_id: familyId,
              name: name.trim(),
              aliases: aliases?.filter((a: string) => a.trim()) || [],
              birth_year: birthYear || null,
              birth_year_confidence: birthYear ? 'high' : null,
              notes_original: notes?.trim() || null,
              created_by: 'studio_self_registration',
              redacted: false,
              is_placeholder: false,
            })
            .select('id, name, aliases, birth_year, death_year')
            .single();

          if (createError || !person) {
            console.error('Failed to create person:', createError);
            set.status = 500;
            return { error: 'Failed to create person' };
          }

          return {
            success: true,
            person: {
              id: person.id,
              name: person.name,
              aliases: person.aliases || [],
              birthYear: person.birth_year ?? null,
              deathYear: person.death_year ?? null,
            },
          };
        },
        {
          params: t.Object({ familyId: t.String() }),
          body: t.Object({
            name: t.String(),
            aliases: t.Optional(t.Array(t.String())),
            birthYear: t.Optional(t.Number()),
            notes: t.Optional(t.String()),
          }),
          detail: {
            tags: ['Identity'],
            description: 'Create a new person record for self-registration',
          },
        },
      )
      /**
       * PATCH /api/family/:familyId/people/:personId
       * Update a person record (only for your claimed identity)
       */
      .patch(
        '/:familyId/people/:personId',
        async (ctx) => {
          const {
            params: { familyId, personId },
            body,
            set,
          } = ctx;
          const auth = (ctx as any).auth;
          if (!auth.isAuthenticated || !auth.identity) {
            set.status = 401;
            return { error: 'Authentication required' };
          }

          if (!hasAccessToFamily(auth, familyId)) {
            set.status = 403;
            return { error: 'Access denied to this family' };
          }

          const accessRepo = new FamilyAccessRepository(dbClient);
          const client = dbClient;

          // Verify the user has claimed this person
          const access = await accessRepo.findByIdentityAndFamily(
            auth.identity.id,
            familyId,
          );

          if (!access?.personId || access.personId !== personId) {
            set.status = 403;
            return { error: 'You can only update your own claimed identity' };
          }

          const { name, aliases, birthYear, notes } = body;

          // Build update object with only provided fields
          const updates: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
          };

          if (name !== undefined) {
            if (!name.trim()) {
              set.status = 400;
              return { error: 'Name cannot be empty' };
            }
            updates.name = name.trim();
          }

          if (aliases !== undefined) {
            updates.aliases = aliases.filter((a: string) => a.trim());
          }

          if (birthYear !== undefined) {
            updates.birth_year = birthYear || null;
            // User-provided birth year has highest confidence
            updates.birth_year_confidence = birthYear ? 'high' : null;
          }

          if (notes !== undefined) {
            updates.notes_original = notes.trim() || null;
          }

          // Update the person
          const { data: person, error: updateError } = await client
            .from('people')
            .update(updates)
            .eq('id', personId)
            .eq('family_id', familyId)
            .select('id, name, aliases, birth_year, death_year, notes_original')
            .single();

          if (updateError || !person) {
            console.error('Failed to update person:', updateError);
            set.status = 500;
            return { error: 'Failed to update person' };
          }

          return {
            success: true,
            person: {
              id: person.id,
              name: person.name,
              aliases: person.aliases || [],
              birthYear: person.birth_year ?? null,
              deathYear: person.death_year ?? null,
              notes: person.notes_original ?? null,
            },
          };
        },
        {
          params: t.Object({ familyId: t.String(), personId: t.String() }),
          body: t.Object({
            name: t.Optional(t.String()),
            aliases: t.Optional(t.Array(t.String())),
            birthYear: t.Optional(t.Nullable(t.Number())),
            notes: t.Optional(t.String()),
          }),
          detail: {
            tags: ['Identity'],
            description: 'Update your claimed person record',
          },
        },
      )
  );
} // closing brace for function

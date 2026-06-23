#!/usr/bin/env bun
/**
 * Generate a summary of what we know about a family.
 * Run with: bun scripts/summary.ts
 */
import 'dotenv/config';
import { createDatabaseClient } from '../libs/database/src/lib/client.js';
import { FamilyRepository } from '../libs/database/src/lib/repositories/family-repository.js';

async function main() {
  const dbClient = createDatabaseClient({
    url: process.env.SUPABASE_URL as string,
    anonKey: process.env.SUPABASE_ANON_KEY as string,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  });

  const familyRepo = new FamilyRepository(dbClient);

  // Get family
  const families = await familyRepo.findAllActive();
  const family = families.find((f) => f.chatId);

  if (!family) {
    console.log('No family with chat ID found');
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  WHAT WE KNOW: ${family.name}`);
  console.log(`${'='.repeat(60)}\n`);

  // People
  const { data: people } = await dbClient
    .from('people')
    .select('name, aliases, birth_year, death_year, notes_original')
    .eq('family_id', family.id)
    .eq('redacted', false)
    .order('created_at', { ascending: true });

  if (people?.length) {
    console.log(`PEOPLE (${people.length})`);
    console.log('-'.repeat(40));
    for (const p of people) {
      let line = `  • ${p.name}`;
      if (p.aliases?.length) {
        line += ` (aka ${p.aliases.join(', ')})`;
      }
      if (p.birth_year || p.death_year) {
        const birth = p.birth_year || '?';
        const death = p.death_year || (p.birth_year ? 'present' : '?');
        line += ` [${birth}–${death}]`;
      }
      console.log(line);
      if (p.notes_original) {
        console.log(
          `      "${p.notes_original.slice(0, 80)}${
            p.notes_original.length > 80 ? '...' : ''
          }"`,
        );
      }
    }
    console.log('');
  }

  // Relationships
  const { data: relationships } = await dbClient
    .from('relationships')
    .select(
      `
      relationship_type,
      person_a:person_a_id(name),
      person_b:person_b_id(name)
    `,
    )
    .eq('family_id', family.id);

  if (relationships?.length) {
    console.log(`RELATIONSHIPS (${relationships.length})`);
    console.log('-'.repeat(40));
    for (const r of relationships) {
      const rel = r as unknown as {
        relationship_type: string;
        person_a: { name: string };
        person_b: { name: string };
      };
      const personA = rel.person_a?.name || 'Unknown';
      const personB = rel.person_b?.name || 'Unknown';
      console.log(`  • ${personA} → ${rel.relationship_type} → ${personB}`);
    }
    console.log('');
  }

  // Places
  const { data: places } = await dbClient
    .from('places')
    .select('name, type, city, region, country, context_original')
    .eq('family_id', family.id)
    .eq('redacted', false)
    .order('created_at', { ascending: true });

  if (places?.length) {
    console.log(`PLACES (${places.length})`);
    console.log('-'.repeat(40));
    for (const p of places) {
      let line = `  • ${p.name}`;
      if (p.type) line += ` (${p.type})`;
      const location = [p.city, p.region, p.country].filter(Boolean).join(', ');
      if (location && location !== p.name) {
        line += ` - ${location}`;
      }
      console.log(line);
      if (p.context_original) {
        console.log(
          `      "${p.context_original.slice(0, 80)}${
            p.context_original.length > 80 ? '...' : ''
          }"`,
        );
      }
    }
    console.log('');
  }

  // Events
  const { data: events } = await dbClient
    .from('events')
    .select('title, event_type, date_text, date_year, description_original')
    .eq('family_id', family.id)
    .eq('redacted', false)
    .order('date_year', { ascending: true, nullsFirst: false });

  if (events?.length) {
    console.log(`TIMELINE EVENTS (${events.length})`);
    console.log('-'.repeat(40));
    for (const e of events) {
      const date = e.date_text || (e.date_year ? String(e.date_year) : '');
      const dateStr = date ? `[${date}] ` : '';
      const typeStr = e.event_type ? `(${e.event_type}) ` : '';
      console.log(`  • ${dateStr}${typeStr}${e.title}`);
      if (e.description_original) {
        console.log(
          `      "${e.description_original.slice(0, 80)}${
            e.description_original.length > 80 ? '...' : ''
          }"`,
        );
      }
    }
    console.log('');
  }

  // Stories
  const { data: stories } = await dbClient
    .from('stories')
    .select('title, content_original, themes, completeness')
    .eq('family_id', family.id)
    .eq('redacted', false)
    .order('created_at', { ascending: false });

  if (stories?.length) {
    console.log(`STORIES (${stories.length})`);
    console.log('-'.repeat(40));
    for (const s of stories) {
      const title = s.title || 'Untitled';
      const status =
        s.completeness === 'complete'
          ? '✓'
          : s.completeness === 'partial'
            ? '◐'
            : '○';
      console.log(`  ${status} ${title}`);
      if (s.themes?.length) {
        console.log(`      Themes: ${s.themes.join(', ')}`);
      }
      if (s.content_original) {
        console.log(
          `      "${s.content_original.slice(0, 100)}${
            s.content_original.length > 100 ? '...' : ''
          }"`,
        );
      }
    }
    console.log('');
  }

  // Questions status
  const { data: questionStats } = await dbClient
    .from('questions')
    .select('status')
    .eq('family_id', family.id);

  if (questionStats?.length) {
    const proposed = questionStats.filter(
      (q) => q.status === 'proposed',
    ).length;
    const asked = questionStats.filter((q) => q.status === 'asked').length;
    const answered = questionStats.filter(
      (q) => q.status === 'answered',
    ).length;

    console.log('QUESTIONS');
    console.log('-'.repeat(40));
    console.log(`  Waiting to ask: ${proposed}`);
    console.log(`  Asked (awaiting answer): ${asked}`);
    console.log(`  Answered: ${answered}`);
    console.log('');
  }

  // Gaps / what we don't know
  console.log('GAPS (What we still want to know)');
  console.log('-'.repeat(40));

  const { data: pendingQuestions } = await dbClient
    .from('questions')
    .select('content_original, priority')
    .eq('family_id', family.id)
    .eq('status', 'proposed')
    .order('priority', { ascending: false })
    .limit(5);

  if (pendingQuestions?.length) {
    for (const q of pendingQuestions) {
      console.log(`  ? ${q.content_original}`);
    }
  } else {
    console.log('  (No pending questions)');
  }

  // Summary stats
  console.log(`\n${'='.repeat(60)}`);
  console.log('TOTALS');
  console.log(
    `  ${people?.length || 0} people, ${places?.length || 0} places, ${
      events?.length || 0
    } events`,
  );
  console.log(
    `  ${relationships?.length || 0} relationships, ${
      stories?.length || 0
    } stories`,
  );
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(console.error);

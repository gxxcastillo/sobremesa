/**
 * `sbm status [options]`
 *
 * Operator report for hardening J: per family, what failed or is stuck
 * (dead-lettered/stale/backed-up queue rows, failed/unknown/stale-pending
 * sends, follow-up provider/parse failures) kept apart from silence the
 * system chose (follow-up declines, pacing skips, guards, expired or
 * superseded questions). Read-only -- recovery is a separate, deliberate
 * step; see spec/message-lifecycle.md §4.7 for the runbook.
 *
 * `--since` takes a duration (`90m`, `24h`, `7d`) or an ISO timestamp and
 * bounds event-style records (sends, follow-up outcomes); queue state
 * (dead-lettered, stale, backlog) is always current, whatever the window.
 * `--family-id` scopes to one family; omitted, every active family is
 * reported. `--json` prints the raw report. Exits 1 when any failure is
 * reported, so a scheduled run can key off the exit code later.
 *
 * Reads the deployed database only with `--allow-remote-db`.
 */
import 'dotenv/config';
import { defineCommand } from 'citty';
import { createLiveDbClient } from '../db-client';
import {
  FamilyRepository,
  PipelineHealthService,
  type FamilyPipelineHealth,
} from '@sobremesa/database';

const DURATION_UNITS_MS: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

/** `24h`/`90m`/`7d` relative to `now`, or an absolute ISO timestamp. */
export function parseSince(value: string, now = new Date()): Date {
  const match = value.match(/^(\d+)([mhd])$/);
  if (match) {
    return new Date(
      now.getTime() - Number(match[1]) * DURATION_UNITS_MS[match[2]],
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid --since "${value}": use a duration like 24h, 90m or 7d, or an ISO timestamp.`,
    );
  }
  return parsed;
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function formatFamily(name: string, report: FamilyPipelineHealth): string {
  const { failures, silence, activity } = report;
  const lines = [
    `== ${name} (${report.familyId})`,
    `FAILURES: ${report.failureCount}`,
  ];

  if (failures.queueErrorCount) {
    lines.push(`  queue dead-lettered: ${failures.queueErrorCount}`);
    for (const item of failures.queueErrors) {
      lines.push(
        `    item ${item.itemId} event ${item.eventId} [${item.intent}] attempts=${item.attempts} -- ${item.lastError ?? '(no error text)'}`,
      );
    }
  }
  for (const item of failures.staleProcessing) {
    lines.push(
      `  queue stale lock: item ${item.itemId} event ${item.eventId} locked ${iso(item.at)}`,
    );
  }
  if (failures.backlog) {
    lines.push(
      `  queue backlog: item ${failures.backlog.itemId} [${failures.backlog.intent}] due since ${iso(failures.backlog.at)} -- ${failures.backlog.intent === 'live' ? 'is the bot running? or paused by the daily spend budget (see `spend_limit_reached` in the chatbots logs)?' : 'abandoned import drain?'}`,
    );
  }
  for (const send of failures.outbound) {
    lines.push(
      `  send ${send.status}: ${send.dedupKey} (row ${send.id}) -- ${send.lastError ?? 'no confirmation'}`,
    );
  }
  for (const failure of failures.followup) {
    lines.push(
      `  follow-up ${failure.outcome}: event ${failure.eventId ?? '?'} at ${iso(failure.at)}`,
    );
  }

  const followupSilence = Object.entries(silence.followup)
    .map(([outcome, count]) => `${outcome}=${count}`)
    .join(' ');
  const retired = Object.entries(silence.questionsRetired)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(' ');
  lines.push(
    'SILENCE (chosen, not failures):',
    `  follow-up: ${followupSilence}`,
    `  questions retired: ${retired}`,
    `ACTIVITY: follow-ups proposed=${activity.followupsProposed} questions asked=${activity.questionsAsked}`,
    `SPEND: ${report.spend.status} -- ${report.spend.note}`,
  );
  return lines.join('\n');
}

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Operator report: failures and stuck work vs. chosen silence, per family. Exits 1 if anything failed.',
  },
  args: {
    since: {
      type: 'string',
      description:
        'Window for sends and follow-up outcomes: 90m, 24h, 7d, or an ISO timestamp',
      default: '24h',
    },
    familyId: {
      type: 'string',
      description: 'Report one family only (default: every active family)',
    },
    json: {
      type: 'boolean',
      description: 'Print the raw report as JSON',
      default: false,
    },
    allowRemoteDb: {
      type: 'boolean',
      description: 'Required to target a non-local SUPABASE_URL',
      default: false,
    },
  },
  async run({ args }) {
    const since = parseSince(args.since);
    const dbClient = createLiveDbClient('sbm status', args.allowRemoteDb);
    const familyRepo = new FamilyRepository(dbClient);
    const health = new PipelineHealthService({ dbClient });

    const families = args.familyId
      ? [await familyRepo.findById(args.familyId)].filter(
          (f): f is NonNullable<typeof f> => Boolean(f),
        )
      : await familyRepo.findAllActive();
    if (args.familyId && families.length === 0) {
      throw new Error(`No family with id ${args.familyId}`);
    }

    const reports: { name: string; report: FamilyPipelineHealth }[] = [];
    for (const family of families) {
      reports.push({
        name: family.name,
        report: await health.report(family.id, { since }),
      });
    }

    if (args.json) {
      console.log(JSON.stringify(reports, null, 2));
    } else {
      console.log(`Pipeline status since ${iso(since)}\n`);
      console.log(
        reports
          .map(({ name, report }) => formatFamily(name, report))
          .join('\n\n'),
      );
    }

    const totalFailures = reports.reduce(
      (sum, { report }) => sum + report.failureCount,
      0,
    );
    if (totalFailures > 0) {
      process.exitCode = 1;
    }
  },
});

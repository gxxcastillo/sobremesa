/**
 * Chat export format resolution -- picks the right parser for a raw export,
 * shared by every import entry point (`apps/cli`'s `sbm import`,
 * `apps/api`'s `POST /api/imports`, and `ImportProcessor`'s background
 * re-parse) so "which parser handles this source" is decided in exactly one
 * place instead of drifting across callers.
 */
import type { ImportSource, ParseResult } from '@sobremesa/shared-types';
import { parseWhatsAppExport } from './whatsapp-parser';

/**
 * One parser per supported export format. `ImportSource` (the data model's
 * source enum) is broader than this record -- 'telegram' and 'other' are
 * recognized values but have no parser implemented yet. Add an entry here
 * to support a new format.
 */
export const IMPORT_PARSERS: Partial<
  Record<ImportSource, (rawFileContent: string) => ParseResult>
> = {
  whatsapp: parseWhatsAppExport,
};

export const SUPPORTED_IMPORT_SOURCES = Object.keys(
  IMPORT_PARSERS,
) as ImportSource[];

export const ALL_IMPORT_SOURCES: ImportSource[] = [
  'whatsapp',
  'telegram',
  'other',
];

export interface ResolvedImport {
  source: ImportSource;
  parsed: ParseResult;
}

/**
 * Resolves which parser handles an export: `explicitSource` if given
 * (validated both as "a recognized source at all" and "has a parser"),
 * otherwise auto-detected by trying every supported parser in turn and
 * taking the first one that yields at least one message.
 *
 * Auto-detect only ever recognizes formats in `IMPORT_PARSERS` -- an export
 * in a recognized-but-unimplemented format (e.g. telegram) won't be
 * detected, by design: that's a decision for the caller to make explicitly
 * via an explicit source, not a guess this function makes on their behalf.
 */
export function resolveImportSource(
  rawFileContent: string,
  explicitSource?: string,
): ResolvedImport {
  if (explicitSource) {
    if (!ALL_IMPORT_SOURCES.includes(explicitSource as ImportSource)) {
      throw new Error(
        `Unknown source "${explicitSource}". Recognized sources: ${ALL_IMPORT_SOURCES.join(', ')}.`,
      );
    }
    const source = explicitSource as ImportSource;
    const parse = IMPORT_PARSERS[source];
    if (!parse) {
      throw new Error(
        `source=${source} is recognized but has no parser implemented yet ` +
          `(only ${SUPPORTED_IMPORT_SOURCES.join(', ')} today) -- add one in libs/import-utils.`,
      );
    }
    return { source, parsed: parse(rawFileContent) };
  }

  const entries = Object.entries(IMPORT_PARSERS) as [
    ImportSource,
    (rawFileContent: string) => ParseResult,
  ][];
  for (const [source, parse] of entries) {
    try {
      const parsed = parse(rawFileContent);
      if (parsed.messages.length > 0) return { source, parsed };
    } catch {
      // Not this format -- try the next parser.
    }
  }
  throw new Error(
    `Could not auto-detect the export format (tried: ${SUPPORTED_IMPORT_SOURCES.join(', ')}). ` +
      `Pass a source explicitly (${ALL_IMPORT_SOURCES.join('|')}), or check that this is a ` +
      'supported chat export.',
  );
}

import { describe, expect, it } from 'vitest';
import { SCRIBE_JSON_SCHEMA } from './schema';

describe('SCRIBE_JSON_SCHEMA', () => {
  it('does not emit object-valued additionalProperties for Anthropic structured output', () => {
    const offenders: string[] = [];

    function walk(value: unknown, path: string[]): void {
      if (!value || typeof value !== 'object') return;

      const record = value as Record<string, unknown>;
      if (
        record['type'] === 'object' &&
        record['additionalProperties'] &&
        typeof record['additionalProperties'] === 'object'
      ) {
        offenders.push(path.join('.') || '<root>');
      }

      for (const [key, child] of Object.entries(record)) {
        walk(child, [...path, key]);
      }
    }

    walk(SCRIBE_JSON_SCHEMA.schema, []);

    expect(offenders).toEqual([]);
  });
});

# ADR-028: Data Quality Extraction Rules

## Status

Accepted

## Date

2026-01-27

## Context

The Scribe agent was producing inconsistent and low-quality extractions:

1. **Birth year calculation inconsistency:** "Timothy turned 43 yesterday" calculated birth_year (1983), but "his son, Mike, turned 11" did NOT calculate Mike's birth year
2. **Relative date resolution missing:** "yesterday" stored as-is instead of resolving to "January 26, 2026"
3. **Redundant overlapping claims:** "Betty turns 29 in 2 days" created TWO claims: birthday claim + age detail claim
4. **Wrong year in recurring events:** "Ralph turns 34 in 4 days" stored "January 31, 2026" instead of "January 31, 1992" (birth year)
5. **Pronoun resolution order issue:** "his sister" resolved to wrong person due to resolving dates before subject

Root cause: Scribe prompt lacked explicit instructions and context for proper extraction.

## Decision

Implement four core extraction rules in the Scribe prompt:

### 1. Birth Year Calculation from Ages

**Rule:** Always calculate and include `birth_year` when extracting age or birthday information.

**Implementation:**

- Add `TODAY: [current date]` to Scribe prompt context
- Update prompt: "If extracting age, calculate birth_year using: TODAY.year - age"
- Emphasize: "Birthday claims supersede age claims" (avoid redundancy)

**Example:**

```
Input: "Mike turned 11 yesterday"
TODAY: January 27, 2026
Output: birth_year: 2015 (calculated: 2026 - 11)
```

### 2. Relative Date Resolution

**Rule:** Resolve all relative dates to absolute dates using TODAY context.

**Implementation:**

- Add full date to prompt: "Monday, January 27, 2026"
- Update Events section: "Calculate dates from relative/duration references using TODAY"
- Add examples: "yesterday" → "January 26, 2026", "in 3 days" → "January 30, 2026"

**Example:**

```
Input: "Timothy turned 43 yesterday"
TODAY: Monday, January 27, 2026
Output: claim_value: "January 26, 2026"
```

### 3. Redundant Claim Prevention

**Rule:** Avoid creating overlapping claims when information can be derived.

**Implementation:**

- Add to Claims section: "Avoid redundant overlapping claims"
- Add to People section: "Birthday claims supersede age claims - don't create both"
- Reasoning: Birthday date contains more information than just age

**Example:**

```
Input: "Betty turns 29 in 2 days"
Before: Created birthday claim + age claim (redundant)
After: Created only birthday claim with birth_year calculated
```

### 4. Subject-First Resolution

**Rule:** Identify WHO/WHAT the claim is about BEFORE resolving dates or other details.

**Implementation:**

- Rename section: "Resolve Subjects First" (was "Resolve All Pronouns")
- Add algorithm: "1. Identify subject 2. Then resolve dates/details"
- Add explicit instruction: "Scan CONTEXT top-to-bottom (newest first) to resolve pronouns"

**Example:**

```
Message 1: "Eddie turns 56 in 3 days"
Message 2: "his sister turns 30 that same day"

Subject resolution:
1. Read: "his sister"
2. Scan context → first male = "Eddie"
3. Subject: "Eddie's sister"
4. Then resolve: "that same day" → use Eddie's birthday
Output: subject="Eddie's sister", date="January 30, 2026"
```

**Bonus:** For recurring events (birthdays, anniversaries), extract ORIGINAL date with calculated year:

```
Input: "Ralph turns 34 in 4 days"
birth_year: 1992 (calculated: 2026 - 34)
Output: claim_value: "January 31, 1992" ✅ (not "January 31, 2026")
```

## Consequences

### Positive

- **Consistent birth year calculation:** All age mentions include calculated birth year
- **Accurate dates:** No more ambiguous relative dates ("yesterday", "last week")
- **Reduced noise:** Fewer redundant claims in database
- **Better pronoun accuracy:** Subject-first resolution fixes context references
- **Correct recurring events:** Birthdays use original year, not next occurrence
- **Improved data quality:** More precise, less ambiguous extractions

### Negative

- **Slight prompt complexity:** Added ~50 tokens for TODAY context and instructions
- **Requires timestamp:** System must pass `messageTimestamp` to Scribe
- **More LLM reasoning:** Subject-first resolution may require additional thinking

### Trade-off

**Data quality improvements worth minor prompt complexity.**

These rules address systematic extraction issues that were causing:

- False conflicts (different people with same name creating confusion)
- Missing data (birth years not calculated from ages)
- Ambiguous dates (relative dates never resolved)
- Redundant storage (same information stored multiple ways)

The fix is minimal (small prompt enhancement, pass timestamp) but the quality improvement is significant:

- From inconsistent birth year extraction → 100% consistent
- From ambiguous relative dates → all dates absolute
- From redundant claims → single canonical claim
- From pronoun confusion → clear subject resolution

Cost: ~50 extra tokens per extraction (~$0.0001 per message)
Benefit: Significantly better data quality, fewer conflicts, clearer provenance

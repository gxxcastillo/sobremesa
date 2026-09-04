# ADR-027: Hybrid Claim Strength Scoring

## Status

Accepted

## Date

2026-01-26

## Context

Not all claims are equally reliable. The system needed to:

- Distinguish strong claims ("I was born in 1920") from weak ones ("I think maybe she arrived in 1891")
- Factor in source reliability (direct vs attributed vs hearsay)
- Account for conflicting claims (multiple birth years for same person)
- Identify high-stakes claims requiring extra scrutiny (birth/death dates, legal relationships)
- Do this cost-effectively at scale (can't use LLM for every claim)

Alternatives considered:

1. **Pure algorithmic scoring:** Fast and free, but can't handle nuanced cases
2. **Pure LLM scoring:** Context-aware, but expensive ($0.01 per claim × 100K claims = $1000)
3. **Mandatory LLM for all claims:** Highest quality, but prohibitively expensive and slow

## Decision

Implement a two-tier hybrid approach: algorithmic scoring (always) + selective LLM evaluation (5-10% of claims).

### Phase 1: Algorithmic Scoring (All Claims, $0 Cost)

**Base score by source type:**

- Direct (`claimedBySource: "direct"`): 1.0 - Speaker claims about themselves
- Attributed (`"attributed"`): 0.8 - Speaker quotes someone else
- Hearsay (`"hearsay"`): 0.5 - Vague attribution

**Certainty language modifier:**

- High certainty (1.0): "definitely", "certainly", "absolutely"
- Medium-high (0.9): "probably", "likely", "believe"
- Medium (0.7): "think", "maybe", "perhaps"
- Low (0.6): "might", "could", "possibly", "not sure"

**Conflict penalty (multiplicative):**

- 0.8 per contradicting claim
- Examples: 0 conflicts = 1.0, 1 conflict = 0.8, 2 conflicts = 0.64

**Final algorithmic score:**

```
score = sourceTypeScore × certaintyModifier × conflictPenalty
```

### Phase 2: LLM Evaluation (5-10% of Claims, Selective Cost)

**Trigger LLM evaluation when ANY of:**

- Has conflicts (contradicting claims exist)
- Uncertainty language detected ("think", "maybe", "probably")
- Hearsay source
- High-stakes claim (birth/death dates, legal relationships)
- Low initial score (< 0.6)

**LLM evaluation receives:**

- The claim with full context
- Conflicting claims
- Source conversation event
- Algorithmic score and triggers

**LLM returns:**

- Confidence score (0.0-1.0)
- Reasoning explaining the score
- Factors that influenced the decision

### Phase 3: Score Blending

**If LLM evaluated:**

```
final_score = (algorithmic_score × 0.4) + (llm_score × 0.6)
```

**If not evaluated:**

```
final_score = algorithmic_score
```

### Storage in strength_factors JSONB

```json
{
  "algorithmScore": 0.7,
  "breakdown": {
    "sourceTypeScore": 1.0,
    "certaintyModifier": 0.9,
    "conflictPenalty": 0.8
  },
  "llmScore": 0.85,
  "llmReasoning": "Despite hearsay, specific ship name suggests reliability",
  "final": 0.775,
  "evaluationTriggered": ["hasConflicts", "hearsay"]
}
```

## Consequences

### Positive

- **Cost-efficient:** 90-95% of claims scored for $0, LLM only for complex cases
- **Auditable:** Complete breakdown stored in `strength_factors` JSONB
- **Context-aware:** LLM evaluates nuanced cases with full conversation context
- **Consistent baseline:** Algorithmic scoring provides uniform baseline
- **Transparent:** Can show exactly how each score was calculated
- **Scalable:** Grows cost sub-linearly with claims (only % need LLM)

### Negative

- **Complexity:** Two-tier system more complex than single approach
- **Latency:** LLM evaluation adds delay for flagged claims (handled async via queue)
- **Tuning needed:** Weights (0.4/0.6 blend, 0.6 low-score threshold) require calibration
- **LLM dependency:** Quality depends on LLM prompt engineering

### Trade-off

**Pragmatic balance of cost, quality, and speed.**

The hybrid approach gives us:

- Simple claims get instant scores (no LLM cost or latency)
- Complex/important claims get deeper analysis
- Cost controlled through selective evaluation
- Quality maintained through LLM intelligence where it matters

Example scenarios:

1. Simple claim ("Maria married José in 1920", direct, no conflicts)
   - Algorithmic: 1.0
   - Cost: $0
   - Latency: <1ms

2. Conflicting claims ("arrived 1889" vs "arrived 1891")
   - Algorithmic: 0.7-0.8 each
   - LLM evaluates both
   - Final: One becomes 0.85, other 0.65
   - Cost: 2 LLM calls (~$0.02)
   - Latency: Async via queue

3. Hearsay with detail ("came on ship 'Galicia' in 1889")
   - Algorithmic: 0.6 (hearsay penalty)
   - LLM recognizes specific detail
   - Final: 0.75
   - Cost: 1 LLM call (~$0.01)

This gives us the best of both worlds: speed and cost-efficiency for routine claims, intelligence for edge cases.

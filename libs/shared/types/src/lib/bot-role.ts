/**
 * Internal role identifiers for agents.
 * Display names are configurable via SobremesaConfig.
 */
export enum BotRole {
  FACILITATOR = 'facilitator',
  ADMIN = 'admin',
  SCRIBE = 'scribe',
  CURATOR = 'curator',
  REGISTRAR = 'registrar',
}

/**
 * Roles that are visible to family members in chat.
 */
export const VISIBLE_ROLES = [BotRole.FACILITATOR, BotRole.ADMIN] as const;

/**
 * Roles that are hidden (backend processing only).
 */
export const HIDDEN_ROLES = [
  BotRole.SCRIBE,
  BotRole.CURATOR,
  BotRole.REGISTRAR,
] as const;

/**
 * Roles that call the Claude API.
 */
export const AI_ROLES = [
  BotRole.FACILITATOR,
  BotRole.ADMIN,
  BotRole.SCRIBE,
  BotRole.CURATOR,
] as const;

export type VisibleRole = (typeof VISIBLE_ROLES)[number];
export type HiddenRole = (typeof HIDDEN_ROLES)[number];
export type AIRole = (typeof AI_ROLES)[number];

export {
  InternAgent,
  type InternAgentOptions,
  type FilterResult,
  type ImageLinkResult,
  type ImageReferenceType,
  type InternConfig,
  type RoutingAction,
  type RoutingResult,
  DEFAULT_INTERN_CONFIG,
} from './lib/intern';

import packageJson from '../package.json' with { type: 'json' };
export const INTERN_VERSION = packageJson.version;

export { ScribeAgent, type ScribeAgentOptions } from './lib/scribe';
export { type ScribeConfig, DEFAULT_SCRIBE_CONFIG } from './lib/types';

import packageJson from '../package.json' with { type: 'json' };
export const SCRIBE_VERSION = packageJson.version;

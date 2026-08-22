import { resolve } from 'node:path';

import { config } from 'dotenv';

// The key is a per-machine credential, so it lives in apps/api/.env, which
// .gitignore keeps out of the repository. It is loaded here rather than in
// src/config/environment.ts because that module holds what the API cannot start
// without: a missing key has to leave the rest of the API bootable.
config({ path: resolve(__dirname, '../../.env') });

/** An Anthropic API key from the Claude Console, of the form `sk-ant-api03-…`. */
export const claudeAgentApiKey = process.env.ANTHROPIC_API_KEY;

export const claudeAgentModel = 'claude-haiku-4-5';

/**
 * Where the child agent keeps its own configuration.
 *
 * It must not be the developer's `~/.claude`: a developer running this suite is
 * usually logged into Claude Code, the child would otherwise authenticate with
 * that login instead of the API key, and the test would pass with any key at
 * all — which is what happened before this directory was set.
 */
export const claudeAgentConfigDirectory = resolve(__dirname, '../../var/claude-agent');

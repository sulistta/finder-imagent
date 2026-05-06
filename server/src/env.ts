import * as fs from 'fs';
import * as path from 'path';

import type { ApiKeyConfig, GoogleRuntimeConfig, ModelConfig } from './types.js';

export interface ServerEnv {
  port: number;
  dataDir: string;
  googleHeadless: boolean;
  apiKeys: ApiKeyConfig[];
  models: ModelConfig;
  google: GoogleRuntimeConfig;
}

export function loadServerEnv(cwd = process.cwd()): ServerEnv {
  loadDotEnv(path.join(cwd, '.env'));

  return {
    port: readPositiveInt(process.env.IMAGE_FINDER_PORT, 5174),
    dataDir: process.env.IMAGE_FINDER_DATA_DIR || '.image-finder-data',
    googleHeadless: readBoolean(process.env.GOOGLE_HEADLESS, false),
    apiKeys: readGoogleApiKeys(),
    models: {
      query: process.env.GEMINI_QUERY_MODEL || '',
      ranking: process.env.GEMINI_RANKING_MODEL || '',
      visual: process.env.GEMINI_VISUAL_MODEL || '',
      metadata: process.env.GEMINI_METADATA_MODEL || '',
      baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    },
    google: {
      delayMinMs: readNonNegativeInt(process.env.GOOGLE_DELAY_MIN_MS, 2_000),
      delayMaxMs: readNonNegativeInt(process.env.GOOGLE_DELAY_MAX_MS, 5_000),
      maxQueries: readPositiveInt(process.env.GOOGLE_MAX_QUERIES, 6),
      maxCandidatesPerQuery: readPositiveInt(process.env.GOOGLE_MAX_CANDIDATES_PER_QUERY, 5),
    },
  };
}

export function maskKey(key: string): string {
  if (key.length <= 8) return 'key:****';
  return `key:${key.slice(0, 4)}...${key.slice(-4)}`;
}

function readGoogleApiKeys(): ApiKeyConfig[] {
  const keys: string[] = [];
  const combined = process.env.GOOGLE_API_KEYS;
  if (combined) {
    keys.push(...combined.split(',').map((key) => key.trim()).filter(Boolean));
  }

  const numberedKeys = Object.entries(process.env)
    .filter(([name, value]) => /^GOOGLE_API_KEY_\d+$/.test(name) && value?.trim())
    .sort(([left], [right]) => Number(left.split('_').at(-1)) - Number(right.split('_').at(-1)))
    .map(([, value]) => value!.trim());
  keys.push(...numberedKeys);

  return [...new Set(keys)].map((key, index) => ({
    id: `google-key-${index + 1}`,
    label: `Google ${index + 1} (${maskKey(key)})`,
    key,
  }));
}

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 0) continue;
    const name = line.slice(0, index).trim();
    if (!name || process.env[name] !== undefined) continue;
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    process.env[name] = value;
  }
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

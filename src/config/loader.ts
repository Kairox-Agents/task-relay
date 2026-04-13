import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { Config } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';

/**
 * Get config search paths. Evaluated at call time so env vars are current.
 */
function getConfigPaths(): string[] {
  return [
    process.env.TASK_RELAY_CONFIG,
    join(homedir(), '.task-relay', 'config.yaml'),
    '/etc/task-relay/config.yaml',
  ].filter(Boolean) as string[];
}

/**
 * Interpolate environment variables in config values.
 * Supports ${VAR_NAME} syntax.
 */
function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(`Environment variable ${varName} not found in config`);
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value);
    }
    return result;
  }

  return obj;
}

/**
 * Find and load config file from standard locations.
 */
async function findConfigFile(): Promise<string | null> {
  for (const path of getConfigPaths()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

/**
 * Load config from YAML file and merge with defaults.
 */
export async function loadConfig(): Promise<Config> {
  const configPath = await findConfigFile();

  if (!configPath) {
    console.warn('No config file found. Using defaults.');
    return DEFAULT_CONFIG;
  }

  const content = await readFile(configPath, 'utf-8');
  const rawConfig = parseYaml(content);
  const interpolatedConfig = interpolateEnvVars(rawConfig);

  // Deep merge with defaults
  return mergeDeep(DEFAULT_CONFIG, interpolatedConfig) as Config;
}

/**
 * Deep merge two objects.
 */
function mergeDeep(target: unknown, source: unknown): unknown {
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const targetObj = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
    const result: Record<string, unknown> = { ...targetObj };

    for (const [key, value] of Object.entries(source)) {
      const targetValue = (targetObj as Record<string, unknown>)[key];
      result[key] = mergeDeep(targetValue, value);
    }

    return result;
  }

  return source;
}

/**
 * Validate config against schema.
 */
export async function validateConfig(config: unknown): Promise<Config> {
  return Config.parse(config);
}

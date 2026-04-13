import type { EnvConfig } from '../config/schema.js';

/**
 * Validate that a working directory is allowed based on paths config.
 */
export function isAllowedPath(workingDir: string, allowedPaths: string[]): boolean {
  if (allowedPaths.length === 0) {
    return true; // No restriction
  }

  const normalizedWorkingDir = workingDir.endsWith('/') ? workingDir : `${workingDir}/`;

  return allowedPaths.some((allowed) => {
    const normalizedAllowed = allowed.endsWith('/') ? allowed : `${allowed}/`;
    return normalizedWorkingDir.startsWith(normalizedAllowed);
  });
}

/**
 * Validate and filter environment variables based on config.
 */
export function validateEnvVars(
  envVars: Record<string, string>,
  config: EnvConfig
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(envVars)) {
    // Check explicit allowlist
    if (config.allowed_keys.includes(key)) {
      result[key] = value;
      continue;
    }

    // Check prefix
    if (key.startsWith(config.allowed_prefix)) {
      result[key] = value;
      continue;
    }

    // Block everything else
    throw new Error(`Environment variable ${key} is not allowed. Must be in allowed_keys or start with ${config.allowed_prefix}`);
  }

  return result;
}

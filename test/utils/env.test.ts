import { describe, it, expect } from 'vitest';
import { isAllowedPath, validateEnvVars } from '../../src/utils/env.js';

describe('Utils', () => {
  describe('isAllowedPath', () => {
    it('should allow path when no restrictions', () => {
      const allowed: string[] = [];
      expect(isAllowedPath('/any/path', allowed)).toBe(true);
    });

    it('should allow path in allowed list', () => {
      const allowed = ['/home/user/projects', '/tmp'];
      expect(isAllowedPath('/home/user/projects/myapp', allowed)).toBe(true);
    });

    it('should reject path not in allowed list', () => {
      const allowed = ['/home/user/projects'];
      expect(isAllowedPath('/etc/passwd', allowed)).toBe(false);
    });

    it('should handle trailing slashes correctly', () => {
      const allowed = ['/home/user/projects'];
      expect(isAllowedPath('/home/user/projects/myapp', allowed)).toBe(true);
      expect(isAllowedPath('/home/user/projectssomething', allowed)).toBe(false);
    });

    it('should allow subdirectories', () => {
      const allowed = ['/home/user'];
      expect(isAllowedPath('/home/user/projects/myapp/src', allowed)).toBe(true);
    });
  });

  describe('validateEnvVars', () => {
    const defaultConfig = {
      allowed_prefix: 'TASK_',
      allowed_keys: ['NODE_ENV', 'GIT_BRANCH'],
    };

    it('should allow explicitly allowed keys', () => {
      const envVars = {
        NODE_ENV: 'production',
        TASK_VAR: 'value',
      };

      const result = validateEnvVars(envVars, defaultConfig);
      expect(result).toEqual(envVars);
    });

    it('should allow keys with allowed prefix', () => {
      const envVars = {
        TASK_SECRET: 'secret123',
        TASK_DEBUG: 'true',
      };

      const result = validateEnvVars(envVars, defaultConfig);
      expect(result).toEqual(envVars);
    });

    it('should reject disallowed keys', () => {
      const envVars = {
        DISALLOWED_KEY: 'value',
      };

      expect(() => validateEnvVars(envVars, defaultConfig)).toThrow('DISALLOWED_KEY is not allowed');
    });

    it('should mix allowed and prefixed keys', () => {
      const envVars = {
        NODE_ENV: 'production',
        TASK_API_KEY: 'secret',
      };

      const result = validateEnvVars(envVars, defaultConfig);
      expect(result.NODE_ENV).toBe('production');
      expect(result.TASK_API_KEY).toBe('secret');
    });

    it('should reject empty key without prefix', () => {
      const envVars = {
        RANDOM_KEY: 'value',
      };

      expect(() => validateEnvVars(envVars, defaultConfig)).toThrow('RANDOM_KEY is not allowed');
    });

    it('should handle custom prefix', () => {
      const config = {
        allowed_prefix: 'CUSTOM_',
        allowed_keys: [],
      };

      const envVars = {
        CUSTOM_VAR: 'value',
      };

      const result = validateEnvVars(envVars, config);
      expect(result).toEqual(envVars);
    });
  });
});

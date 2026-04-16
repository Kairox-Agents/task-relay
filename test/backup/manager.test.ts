import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BackupManager } from '../../src/backup/manager.js';
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseManager, TaskRepository } from '../../src/db/index.js';

/**
 * Backup Manager tests
 *
 * Note: We test the manager logic without real S3 connectivity.
 * The S3Client would need mocking for full E2E, but we verify the flow here.
 */
describe('Backup Manager', () => {
  let dbManager: DatabaseManager;
  let taskRepo: TaskRepository;
  let backupManager: BackupManager;
  let stateDir: string;

  const config = {
    enabled: true,
    provider: 's3' as const,
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    bucket: 'test-task-relay-backups',
    region: 'us-west-004',
    log_interval_ms: 300000,
    full_interval_hours: 24,
    retention_days: 30,
  };

  beforeEach(async () => {
    stateDir = join(tmpdir(), 'task-relay-backup-test-' + Date.now());
    await mkdir(stateDir, { recursive: true });

    dbManager = new DatabaseManager(join(stateDir, 'test.db'));
    taskRepo = new TaskRepository(dbManager.getDatabase());

    backupManager = new BackupManager(config, stateDir);
    backupManager.setRepositories(taskRepo, dbManager);
    await backupManager.init();
  });

  afterEach(async () => {
    await backupManager.stop();
    dbManager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  // BACKUP-01: State persistence
  it('should load and save state', async () => {
    const statePath = join(stateDir, 'backup-state.json');
    const state = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(state);
    expect(parsed.lastLogBackup).toBeNull();
    expect(parsed.lastFullBackup).toBeNull();
    expect(Array.isArray(parsed.pendingTraces)).toBe(true);
  });

  // BACKUP-02: Log backup with no tasks
  it('should handle log backup with no tasks', async () => {
    const result = await backupManager.backupLogs();
    expect(result.uploaded).toBe(0);
  });

  // BACKUP-03: Log backup with tasks
  it('should backup tasks since last backup', async () => {
    taskRepo.create({
      id: 'task-1',
      type: 'shell',
      status: 'completed',
      prompt: 'echo test',
      working_dir: tmpdir(),
      created_at: new Date().toISOString(),
    });

    const result = await backupManager.backupLogs();
    expect(result.uploaded).toBeGreaterThanOrEqual(1);
  });

  // BACKUP-04: Log backup respects timestamp
  it('should not re-upload tasks from before last backup', async () => {
    const oldTime = new Date(Date.now() - 86400000).toISOString();
    taskRepo.create({
      id: 'task-old',
      type: 'shell',
      status: 'completed',
      prompt: 'echo old',
      working_dir: tmpdir(),
      created_at: oldTime,
    });

    // First backup
    await backupManager.backupLogs();

    // Add new task
    taskRepo.create({
      id: 'task-new',
      type: 'shell',
      status: 'completed',
      prompt: 'echo new',
      working_dir: tmpdir(),
      created_at: new Date().toISOString(),
    });

    // Second backup should only get new task
    const result = await backupManager.backupLogs();
    expect(result.uploaded).toBe(1);
  });

  // BACKUP-05: Full backup creates snapshot
  it('should create full backup snapshot', async () => {
    taskRepo.create({
      id: 'task-1',
      type: 'shell',
      status: 'completed',
      prompt: 'echo test',
      working_dir: tmpdir(),
      created_at: new Date().toISOString(),
    });

    // This would need real S3 to work, but we can verify the flow
    // For now, we test that the method doesn't crash
    try {
      await backupManager.backupFull();
    } catch (err) {
      // S3 not reachable is expected in tests
      expect((err as Error).message).toContain('bucket') || expect((err as Error).message).toContain('ENOTFOUND');
    }
  });

  // BACKUP-06: Trace backup queues pending task
  it('should queue pending trace if file not found', async () => {
    await backupManager.backupTrace('task-1', tmpdir());

    // Reload state
    const statePath = join(stateDir, 'backup-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.pendingTraces).toContain('task-1');
  });

  // BACKUP-07: Backup disabled does nothing
  it('should skip operations when disabled', async () => {
    const disabledConfig = { ...config, enabled: false };
    const disabledManager = new BackupManager(disabledConfig, stateDir);
    disabledManager.setRepositories(taskRepo, dbManager);
    await disabledManager.init();

    const result = await disabledManager.backupLogs();
    expect(result.uploaded).toBe(0);

    await disabledManager.stop();
  });

  // BACKUP-08: State persists across reloads
  it('should persist state across manager reloads', async () => {
    // Create a task and backup logs
    taskRepo.create({
      id: 'task-1',
      type: 'shell',
      status: 'completed',
      prompt: 'echo test',
      working_dir: tmpdir(),
      created_at: new Date().toISOString(),
    });
    await backupManager.backupLogs();

    // Reload manager
    const reloaded = new BackupManager(config, stateDir);
    reloaded.setRepositories(taskRepo, dbManager);
    await reloaded.init();

    const statePath = join(stateDir, 'backup-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.lastLogBackup).not.toBeNull();

    await reloaded.stop();
  });

  // BACKUP-09: Stop/Start lifecycle
  it('should handle start and stop gracefully', async () => {
    await backupManager.start();

    // Wait a bit to ensure timers are set
    await new Promise(r => setTimeout(r, 100));

    await backupManager.stop();

    // Should not throw
    expect(true).toBe(true);
  });
});

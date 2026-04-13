import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseManager, TaskRepository } from '../../src/db/index.js';
import type { Task } from '../../src/config/schema.js';
import { v4 as uuidv4 } from 'uuid';

describe('TaskRepository', () => {
  let dbManager: DatabaseManager;
  let taskRepo: TaskRepository;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = join(tmpdir(), 'task-relay-test-db-' + Date.now() + '.db');
    dbManager = new DatabaseManager(testDbPath);
    taskRepo = new TaskRepository(dbManager.getDatabase());
  });

  afterEach(async () => {
    dbManager.close();
    // Better-sqlite3 creates .db, .db-wal, .db-shm files
    const dbDir = join(tmpdir(), 'task-relay-test-db-' + testDbPath.split('-').pop()!.split('.')[0]);
    await rm(dbDir, { recursive: true, force: true });
  });

  const createTestTask = (overrides: Partial<Task> = {}): Task => ({
    id: uuidv4(),
    type: 'shell',
    prompt: 'echo "hello"',
    working_dir: '/tmp',
    isolation: 'host',
    timeout_ms: 30000,
    env: { TEST: 'value' },
    allow_network: false,
    model: 'sonnet',
    max_budget_usd: 1.0,
    acceptance_criteria: null,
    max_iterations: 5,
    judge_model: null,
    current_iteration: 1,
    judge_history: [],
    judge_result: null,
    status: 'pending',
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    exit_code: null,
    error: null,
    output_path: null,
    cost_usd: 0,
    ...overrides,
  });

  describe('create', () => {
    it('should create a new task', () => {
      const task = createTestTask();
      const created = taskRepo.create(task);

      expect(created.id).toBe(task.id);
      expect(created.status).toBe('pending');
    });

    it('should persist task to database', () => {
      const task = createTestTask();
      taskRepo.create(task);

      const retrieved = taskRepo.getById(task.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(task.id);
    });
  });

  describe('getById', () => {
    it('should return null for non-existent task', () => {
      const result = taskRepo.getById(uuidv4());
      expect(result).toBeNull();
    });

    it('should return existing task', () => {
      const task = createTestTask();
      taskRepo.create(task);

      const retrieved = taskRepo.getById(task.id);
      expect(retrieved).toEqual(task);
    });

    it('should deserialize JSON fields correctly', () => {
      const task = createTestTask({
        env: { KEY1: 'value1', KEY2: 'value2' },
        judge_history: [{ iteration: 1, status: 'passed', overall_score: 100, criteria_scores: {}, feedback: 'Good', escalated_at: null }],
      });
      taskRepo.create(task);

      const retrieved = taskRepo.getById(task.id);
      expect(retrieved?.env).toEqual({ KEY1: 'value1', KEY2: 'value2' });
      expect(retrieved?.judge_history).toHaveLength(1);
    });
  });

  describe('updateStatus', () => {
    it('should update task status', () => {
      const task = createTestTask();
      taskRepo.create(task);

      taskRepo.updateStatus(task.id, 'running');
      const updated = taskRepo.getById(task.id);

      expect(updated?.status).toBe('running');
    });
  });

  describe('updateStartedAt', () => {
    it('should update started_at timestamp', () => {
      const task = createTestTask();
      taskRepo.create(task);

      const startTime = new Date().toISOString();
      taskRepo.updateStartedAt(task.id, startTime);
      const updated = taskRepo.getById(task.id);

      expect(updated?.started_at).toBe(startTime);
    });
  });

  describe('updateCompletedAt', () => {
    it('should update completed_at timestamp', () => {
      const task = createTestTask();
      taskRepo.create(task);

      const endTime = new Date().toISOString();
      taskRepo.updateCompletedAt(task.id, endTime);
      const updated = taskRepo.getById(task.id);

      expect(updated?.completed_at).toBe(endTime);
    });
  });

  describe('updateResult', () => {
    it('should update task result', () => {
      const task = createTestTask();
      taskRepo.create(task);

      const result = {
        exit_code: 0,
        error: null,
        output_path: '/tmp/output.log',
        cost_usd: 0.5,
      };
      taskRepo.updateResult(task.id, result);

      const updated = taskRepo.getById(task.id);
      expect(updated?.exit_code).toBe(0);
      expect(updated?.output_path).toBe('/tmp/output.log');
      expect(updated?.cost_usd).toBe(0.5);
    });
  });

  describe('updateJudgeState', () => {
    it('should update judge iteration and history', () => {
      const task = createTestTask();
      taskRepo.create(task);

      const newHistory = [
        { iteration: 1, status: 'passed', overall_score: 100, criteria_scores: {}, feedback: 'Good', escalated_at: null },
      ];
      const newResult = { final_status: 'passed', total_iterations: 1, final_score: 100, escalated_at: null };

      taskRepo.updateJudgeState(task.id, 2, newHistory, newResult);
      const updated = taskRepo.getById(task.id);

      expect(updated?.current_iteration).toBe(2);
      expect(updated?.judge_history).toEqual(newHistory);
      expect(updated?.judge_result).toEqual(newResult);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      // Create multiple tasks
      for (let i = 0; i < 5; i++) {
        const task = createTestTask({ status: i < 3 ? 'pending' : 'completed' });
        taskRepo.create(task);
      }
    });

    it('should list all tasks without filter', () => {
      const tasks = taskRepo.list();
      expect(tasks.length).toBeGreaterThanOrEqual(5);
    });

    it('should filter by status', () => {
      const pendingTasks = taskRepo.list('pending');
      const completedTasks = taskRepo.list('completed');

      expect(pendingTasks.length).toBe(3);
      expect(completedTasks.length).toBe(2);
    });

    it('should apply limit and offset', () => {
      const tasks = taskRepo.list(undefined, 2, 0);
      expect(tasks.length).toBe(2);

      const moreTasks = taskRepo.list(undefined, 2, 2);
      expect(moreTasks.length).toBe(2);
    });
  });

  describe('delete', () => {
    it('should delete a task', () => {
      const task = createTestTask();
      taskRepo.create(task);

      taskRepo.delete(task.id);
      const retrieved = taskRepo.getById(task.id);

      expect(retrieved).toBeNull();
    });
  });

  describe('archiveOldTasks', () => {
    beforeEach(() => {
      // Create old task
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
      const oldTask = createTestTask({
        id: uuidv4(),
        created_at: oldDate,
        status: 'completed',
      });
      taskRepo.create(oldTask);

      // Create recent tasks
      for (let i = 0; i < 3; i++) {
        taskRepo.create(createTestTask({ status: 'completed' }));
      }
    });

    it('should archive tasks older than max_age_days', () => {
      const archived = taskRepo.archiveOldTasks(30, 1000);
      expect(archived).toBeGreaterThan(0);
    });

    it('should keep failed tasks when configured', () => {
      const failedTask = createTestTask({ status: 'failed', created_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() });
      taskRepo.create(failedTask);

      taskRepo.archiveOldTasks(30, 1000, true);
      const failedAfter = taskRepo.getById(failedTask.id);

      expect(failedAfter?.status).toBe('failed'); // Not archived
    });
  });

  describe('getNextPending', () => {
    it('should return oldest pending task', () => {
      const task1 = createTestTask({ id: uuidv4(), created_at: new Date(Date.now() - 5000).toISOString() });
      const task2 = createTestTask({ id: uuidv4(), created_at: new Date(Date.now() - 3000).toISOString() });
      const task3 = createTestTask({ id: uuidv4(), created_at: new Date(Date.now() - 1000).toISOString() });

      taskRepo.create(task1);
      taskRepo.create(task2);
      taskRepo.create(task3);

      const next = taskRepo.getNextPending();
      expect(next?.id).toBe(task1.id); // Oldest
    });

    it('should return null when no pending tasks', () => {
      const next = taskRepo.getNextPending();
      expect(next).toBeNull();
    });
  });

  describe('countByStatus', () => {
    it('should count tasks by status', () => {
      for (let i = 0; i < 3; i++) {
        taskRepo.create(createTestTask({ status: 'pending' }));
      }
      for (let i = 0; i < 2; i++) {
        taskRepo.create(createTestTask({ status: 'completed' }));
      }

      const pendingCount = taskRepo.countByStatus('pending');
      const completedCount = taskRepo.countByStatus('completed');

      expect(pendingCount).toBe(3);
      expect(completedCount).toBe(2);
    });
  });
});

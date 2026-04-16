#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, validateConfig } from './config/index.js';
import { initLogger } from './utils/logger.js';
import { DatabaseManager, TaskRepository } from './db/index.js';
import { registry } from './executor/index.js';
import { ShellExecutor } from './executor/shell.js';
import { TaskQueue } from './executor/queue.js';
import { createServer } from './api/index.js';
import { serve } from '@hono/node-server';

const program = new Command();

program
  .name('task-relay')
  .description('Local worker daemon for remote agent task execution')
  .version('0.1.0');

program
  .command('start')
  .description('Start the task-relay daemon')
  .action(async () => {
    try {
      // Load and validate config
      const config = await loadConfig();
      await validateConfig(config);

      // Initialize logger
      const logger = initLogger(config.logging);
      logger.info('Task-Relay daemon starting...');

      // Initialize database
      const dbManager = new DatabaseManager();
      const db = dbManager.getDatabase();
      const taskRepo = new TaskRepository(db);

      // Initialize backup manager
      let backupManager: any = undefined;
      if (config.backup.enabled) {
        const { BackupManager } = await import('./backup/manager.js');
        const { homedir } = await import('node:os');
        const { join } = await import('node:path');
        const stateDir = join(homedir(), '.task-relay');
        backupManager = new BackupManager(config.backup, stateDir);
        backupManager.setRepositories(taskRepo, dbManager);
        await backupManager.init();
        logger.info('Backup manager initialized');
      }

      // Run retention on startup if configured
      if (config.retention.run_on_startup) {
        logger.info('Running task retention on startup');
        const archived = taskRepo.archiveOldTasks(
          config.retention.max_age_days,
          config.retention.max_tasks
        );
        logger.info({ archived }, 'Task retention completed');
      }

      // Register executors
      if (config.executors.shell.enabled) {
        registry.register(new ShellExecutor());
        logger.info('Shell executor registered');
      }

      if (config.executors['claude-code'].enabled) {
        const { ClaudeCodeExecutor } = await import('./executor/claude-code.js');
        registry.register(new ClaudeCodeExecutor());
        logger.info('Claude Code executor registered');
      }

      // Initialize task queue
      const taskQueue = new TaskQueue({
        maxConcurrent: config.execution.max_concurrent,
        maxQueueSize: config.execution.max_queue_size,
      });

      // Initialize daemon (wires up queue to executors)
      const { TaskDaemon } = await import('./executor/daemon.js');
      const daemon = new TaskDaemon({
        taskQueue,
        taskRepo,
        backupManager,
      });

      // Start backup manager
      if (backupManager) {
        await backupManager.start();
      }

      // Create HTTP server
      const app = createServer(config, taskRepo, taskQueue, daemon);

      // Start server
      const port = config.server.port;
      const bind = config.server.bind;

      logger.info({ port, bind }, 'Starting HTTP server');

      const server = serve({
        fetch: app.fetch,
        port,
        hostname: bind,
      });

      // Graceful shutdown
      const shutdown = async (signal: string) => {
        logger.info({ signal }, 'Shutting down...');
        server.close(async (err) => {
          if (err) {
            logger.error({ error: err }, 'Error closing server');
          }

          // Shutdown daemon (wait for running tasks)
          await daemon.shutdown();

          // Close database
          dbManager.close();

          logger.info('Shutdown complete');
          process.exit(0);
        });
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));

    } catch (error) {
      console.error('Failed to start daemon:', error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check daemon status')
  .action(async () => {
    console.log('Status check not yet implemented');
    // TODO: Check if daemon is running via pid file or API call
  });

program
  .command('config')
  .description('Config operations')
  .argument('<action>', 'Action: validate | show')
  .action(async (action) => {
    if (action === 'validate') {
      try {
        const config = await loadConfig();
        await validateConfig(config);
        console.log('✓ Config is valid');
      } catch (error) {
        console.error('✗ Config validation failed:', error);
        process.exit(1);
      }
    } else if (action === 'show') {
      const config = await loadConfig();
      console.log(JSON.stringify(config, null, 2));
    } else {
      console.error('Unknown action:', action);
      process.exit(1);
    }
  });

program.parse();

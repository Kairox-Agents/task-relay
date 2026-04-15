#!/usr/bin/env node
/**
 * Task-Relay MCP Server
 *
 * Thin stdio adapter that forwards MCP tool calls to the task-relay HTTP daemon.
 * This keeps MCP concerns separate from the core daemon — no shared DB access.
 *
 * Usage: npx task-relay-mcp
 * Or configure in Claude Desktop:
 *   {
 *     "mcpServers": {
 *       "task-relay": {
 *         "command": "npx",
 *         "args": ["task-relay-mcp"],
 *         "env": {
 *           "TASK_RELAY_URL": "http://localhost:8080",
 *           "TASK_RELAY_API_KEY": "your-api-key"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DAEMON_URL = process.env.TASK_RELAY_URL || 'http://localhost:8080';
const API_KEY = process.env.TASK_RELAY_API_KEY || '';

async function daemonRequest(path: string, options: RequestInit = {}): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  try {
    const response = await fetch(`${DAEMON_URL}${path}`, { ...options, headers });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  } catch (err) {
    return { status: 0, data: { error: { code: 'DAEMON_UNREACHABLE', message: err instanceof Error ? err.message : 'Cannot reach daemon' } } };
  }
}

const server = new McpServer({
  name: 'task-relay',
  version: '0.1.0',
});

// Tool: submit_task
server.tool(
  'submit_task',
  'Submit a task for execution on the remote machine. Returns task ID and initial status.',
  {
    type: z.enum(['shell', 'claude-code']).describe('Executor type: shell for commands, claude-code for AI agent tasks'),
    prompt: z.string().min(1).describe('The task prompt/command to execute'),
    working_dir: z.string().min(1).describe('Working directory for task execution'),
    isolation: z.enum(['host', 'docker', 'worktree']).optional().describe('Isolation mode (default: host)'),
    timeout_ms: z.number().min(1000).max(3600000).optional().describe('Timeout in milliseconds'),
    env: z.record(z.string()).optional().describe('Environment variables (must match allowed_prefix or allowed_keys)'),
    model: z.string().optional().describe('Model for claude-code executor'),
    max_budget_usd: z.number().min(0.01).max(100).optional().describe('Max budget in USD for claude-code tasks'),
  },
  async (params) => {
    const { status, data } = await daemonRequest('/tasks', {
      method: 'POST',
      body: JSON.stringify(params),
    });

    if (status !== 201) {
      return {
        content: [{ type: 'text' as const, text: `Error (${status}): ${JSON.stringify(data)}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ id: data.id, status: data.status, created_at: data.created_at }, null, 2),
      }],
    };
  }
);

// Tool: get_task
server.tool(
  'get_task',
  'Get the status and result of a task by ID.',
  {
    id: z.string().uuid().describe('Task ID'),
  },
  async ({ id }) => {
    const { status, data } = await daemonRequest(`/tasks/${id}`);

    if (status === 404) {
      return {
        content: [{ type: 'text' as const, text: `Task not found: ${id}` }],
        isError: true,
      };
    }

    if (status !== 200) {
      return {
        content: [{ type: 'text' as const, text: `Error (${status}): ${JSON.stringify(data)}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          id: data.id,
          type: data.type,
          status: data.status,
          exit_code: data.exit_code,
          error: data.error,
          cost_usd: data.cost_usd,
          started_at: data.started_at,
          completed_at: data.completed_at,
        }, null, 2),
      }],
    };
  }
);

// Tool: list_tasks
server.tool(
  'list_tasks',
  'List tasks with optional status filter.',
  {
    status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional().describe('Filter by status'),
    limit: z.number().min(1).max(100).optional().describe('Max results (default 20)'),
    offset: z.number().min(0).optional().describe('Offset for pagination'),
  },
  async (params) => {
    const queryParams = new URLSearchParams();
    if (params.status) queryParams.set('status', params.status);
    if (params.limit) queryParams.set('limit', String(params.limit));
    if (params.offset) queryParams.set('offset', String(params.offset));

    const qs = queryParams.toString();
    const { status, data } = await daemonRequest(`/tasks${qs ? `?${qs}` : ''}`);

    if (status !== 200) {
      return {
        content: [{ type: 'text' as const, text: `Error (${status}): ${JSON.stringify(data)}` }],
        isError: true,
      };
    }

    const tasks = Array.isArray(data) ? data : data.tasks || [];
    const summary = tasks.map((t: any) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      exit_code: t.exit_code,
      created_at: t.created_at,
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// Tool: cancel_task
server.tool(
  'cancel_task',
  'Cancel a running or pending task.',
  {
    id: z.string().uuid().describe('Task ID to cancel'),
  },
  async ({ id }) => {
    const { status, data } = await daemonRequest(`/tasks/${id}`, { method: 'DELETE' });

    if (status === 404) {
      return {
        content: [{ type: 'text' as const, text: `Task not found: ${id}` }],
        isError: true,
      };
    }

    if (status !== 200) {
      return {
        content: [{ type: 'text' as const, text: `Error (${status}): ${JSON.stringify(data)}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: `Task ${id} cancelled.` }],
    };
  }
);

// Tool: get_capabilities
server.tool(
  'get_capabilities',
  'Get the capabilities of the task-relay daemon — available executors, config, etc.',
  {},
  async () => {
    const { status, data } = await daemonRequest('/capabilities');

    if (status !== 200) {
      return {
        content: [{ type: 'text' as const, text: `Error (${status}): ${JSON.stringify(data)}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

import { Hono } from 'hono';

export function createHealthRoute() {
  const router = new Hono();

  /**
   * GET /health - Health check
   */
  router.get('/', (c) => {
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    });
  });

  return router;
}

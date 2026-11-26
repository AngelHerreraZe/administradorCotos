import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv, Deps } from '../types.ts';

const Estado = z.object({ status: z.literal('ok') }).openapi('Estado');

const live = createRoute({
  method: 'get',
  path: '/live',
  tags: ['salud'],
  summary: 'El proceso responde (no toca dependencias)',
  responses: { 200: { description: 'Vivo', content: { 'application/json': { schema: Estado } } } },
});

const ready = createRoute({
  method: 'get',
  path: '/ready',
  tags: ['salud'],
  summary: 'Lista para recibir tráfico (la BD responde)',
  responses: {
    200: { description: 'Lista', content: { 'application/json': { schema: Estado } } },
    503: { description: 'Dependencia caída' },
  },
});

export function healthRoutes({ prisma }: Pick<Deps, 'prisma'>) {
  return new OpenAPIHono<AppEnv>()
    .openapi(live, (c) => c.json({ status: 'ok' as const }, 200))
    .openapi(ready, async (c) => {
      await prisma.$queryRaw`SELECT 1`; // sin contexto: no lee datos de nadie
      return c.json({ status: 'ok' as const }, 200);
    });
}

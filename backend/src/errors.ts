import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/** Business error rendered as `{ error: { code, message, requestId, ...extra } }`. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code);
  }
}
export const notFound = (code: string, msg?: string) => new ApiError(404, code, msg);
export const badRequest = (msg: string, extra?: Record<string, unknown>) => new ApiError(400, 'VALIDATION_ERROR', msg, extra);
export const conflict = (code: string, msg?: string, extra?: Record<string, unknown>) => new ApiError(409, code, msg, extra);

export function installErrorHandling(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => { (req as any).requestId = randomUUID(); });
  app.setErrorHandler((err: any, req, reply) => {
    const requestId = (req as any).requestId ?? randomUUID();
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, requestId, ...err.extra } });
    }
    if (err.validation || err.statusCode === 400) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message, requestId } });
    }
    req.log.error(err);
    reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error', requestId } });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.url}`, requestId: (req as any).requestId } }));
}

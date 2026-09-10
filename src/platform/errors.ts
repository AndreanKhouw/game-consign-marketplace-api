import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface FieldError {
  field: string;
  code: string;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: FieldError[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function titleFor(statusCode: number): string {
  const titles: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    413: 'Payload Too Large',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
  };
  return titles[statusCode] ?? 'Request Failed';
}

function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  detail: string,
  errors?: FieldError[],
): void {
  void reply
    .code(statusCode)
    .type('application/problem+json')
    .send({
      type: `https://game-consign.example/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: titleFor(statusCode),
      status: statusCode,
      code,
      detail,
      request_id: request.id,
      ...(errors ? { errors } : {}),
    });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      sendProblem(reply, request, error.statusCode, error.code, error.message, error.fieldErrors);
      return;
    }

    if (error.validation) {
      const fields = error.validation.slice(0, 50).map((issue) => ({
        field: issue.instancePath || issue.schemaPath,
        code: issue.keyword.toUpperCase(),
      }));
      sendProblem(reply, request, 400, 'VALIDATION_FAILED', 'Request validation failed', fields);
      return;
    }

    if (error.statusCode === 413) {
      sendProblem(reply, request, 413, 'PAYLOAD_TOO_LARGE', 'Request payload is too large');
      return;
    }

    if (error.statusCode === 429) {
      sendProblem(reply, request, 429, 'RATE_LIMITED', 'Too many requests');
      return;
    }

    request.log.error({ err: error }, 'unhandled request error');
    sendProblem(reply, request, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  });

  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, request, 404, 'NOT_FOUND', 'Resource not found');
  });
}

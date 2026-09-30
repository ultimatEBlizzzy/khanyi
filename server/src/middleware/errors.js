import { ApiError } from '../lib/http.js';

export function notFound(req, res, next) {
  if (req.path.startsWith('/api')) {
    return next(ApiError.notFound(`No API route for ${req.method} ${req.path}`));
  }
  return next();
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err instanceof ApiError ? err.status : err.status || 500;

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  const payload = {
    error: {
      message: status >= 500 ? 'Something went wrong on our side' : err.message,
      code: err.code || err.name || 'Error',
      ...(err.meta ? { details: err.meta } : {}),
    },
  };
  res.status(status).json(payload);
}

export default { notFound, errorHandler };

/** Transport-level helpers: typed errors, async wrappers, JSON responses. */

export class ApiError extends Error {
  constructor(status, message, meta = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.meta = meta;
  }

  static badRequest(msg, meta) { return new ApiError(400, msg, meta); }
  static unauthorized(msg = 'Please sign in to continue') { return new ApiError(401, msg); }
  static forbidden(msg = 'You do not have access to that') { return new ApiError(403, msg); }
  static notFound(msg = 'Not found') { return new ApiError(404, msg); }
  static conflict(msg, meta) { return new ApiError(409, msg, meta); }
  static unprocessable(msg, meta) { return new ApiError(422, msg, meta); }
  static tooMany(msg = 'Too many requests — slow down a moment') { return new ApiError(429, msg); }
}

/** Wrap an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export const send = (res, payload, status = 200) => res.status(status).json(payload);

export const created = (res, payload) => send(res, payload, 201);

export default { ApiError, asyncHandler, send, created };

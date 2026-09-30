/**
 * A tiny, dependency-free schema validator.
 *
 *   const schema = v.object({
 *     email: v.email(),
 *     qty:   v.int({ min: 1, max: 50 }),
 *     notes: v.string({ max: 240, optional: true }),
 *   });
 *   const data = schema.parse(req.body); // throws ApiError(422) on failure
 */

import { ApiError } from './http.js';

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class Validator {
  constructor(parseFn, { optional = false, label = 'value' } = {}) {
    this._parse = parseFn;
    this._optional = optional;
    this._label = label;
  }

  optional() {
    return new Validator(this._parse, { optional: true, label: this._label });
  }

  label(name) {
    return new Validator(this._parse, { optional: this._optional, label: name });
  }

  parse(value, path = this._label) {
    if (value === undefined || value === null || value === '') {
      if (this._optional) return undefined;
      throw new ApiError(422, `${path} is required`, { field: path });
    }
    return this._parse(value, path);
  }
}

const str = (value, path, { min = 0, max = 500, pattern, trim = true } = {}) => {
  if (typeof value !== 'string') {
    throw new ApiError(422, `${path} must be text`, { field: path });
  }
  const out = trim ? value.trim() : value;
  if (out.length < min) {
    throw new ApiError(422, `${path} must be at least ${min} characters`, { field: path });
  }
  if (out.length > max) {
    throw new ApiError(422, `${path} must be at most ${max} characters`, { field: path });
  }
  if (pattern && !pattern.test(out)) {
    throw new ApiError(422, `${path} is not in the right format`, { field: path });
  }
  return out;
};

export const v = {
  string: (opts = {}) => new Validator((value, path) => str(value, path, opts)),
  /** Multi-line free text — newlines allowed, still length capped. */
  text: (opts = {}) => new Validator((value, path) => str(value, path, { max: 1000, ...opts })),
  email: () =>
    new Validator((value, path) =>
      str(value, path, {
        max: 160,
        pattern: /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/,
      }).toLowerCase(),
    ),
  phone: () =>
    new Validator((value, path) =>
      str(value, path, { max: 24, pattern: /^[+()\d][\d\s\-()]{7,23}$/ }),
    ),
  password: () =>
    new Validator((value, path) => {
      if (typeof value !== 'string' || value.length < 6) {
        throw new ApiError(422, `${path} must be at least 6 characters`, { field: path });
      }
      if (value.length > 128) {
        throw new ApiError(422, `${path} is too long`, { field: path });
      }
      return value;
    }),
  int: ({ min = -Infinity, max = Infinity } = {}) =>
    new Validator((value, path) => {
      const n = typeof value === 'string' ? Number(value) : value;
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new ApiError(422, `${path} must be a whole number`, { field: path });
      }
      if (n < min || n > max) {
        throw new ApiError(422, `${path} must be between ${min} and ${max}`, { field: path });
      }
      return n;
    }),
  number: ({ min = -Infinity, max = Infinity } = {}) =>
    new Validator((value, path) => {
      const n = typeof value === 'string' ? Number(value) : value;
      if (!Number.isFinite(n)) throw new ApiError(422, `${path} must be a number`, { field: path });
      if (n < min || n > max) {
        throw new ApiError(422, `${path} must be between ${min} and ${max}`, { field: path });
      }
      return n;
    }),
  bool: () =>
    new Validator((value, path) => {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0') return false;
      throw new ApiError(422, `${path} must be true or false`, { field: path });
    }),
  enum: (values) =>
    new Validator((value, path) => {
      if (!values.includes(value)) {
        throw new ApiError(422, `${path} must be one of: ${values.join(', ')}`, { field: path });
      }
      return value;
    }),
  array: (inner, { min = 0, max = 100 } = {}) =>
    new Validator((value, path) => {
      if (!Array.isArray(value)) throw new ApiError(422, `${path} must be a list`, { field: path });
      if (value.length < min) {
        throw new ApiError(422, `${path} needs at least ${min} item(s)`, { field: path });
      }
      if (value.length > max) {
        throw new ApiError(422, `${path} allows at most ${max} items`, { field: path });
      }
      return value.map((entry, i) => inner.parse(entry, `${path}[${i}]`));
    }),
  object: (shape, { stripUnknown = true } = {}) =>
    new Validator((value, path) => {
      if (!isPlainObject(value)) throw new ApiError(422, `${path} must be an object`, { field: path });
      const out = {};
      for (const [key, validator] of Object.entries(shape)) {
        const parsed = validator.parse(value[key], `${path}.${key}`);
        if (parsed !== undefined) out[key] = parsed;
      }
      if (!stripUnknown) {
        for (const key of Object.keys(value)) {
          if (!(key in shape)) out[key] = value[key];
        }
      }
      return out;
    }),
};

export default v;

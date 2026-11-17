import { createHash, randomUUID } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const nowIso = () => new Date().toISOString();

export function uid(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function fingerprint(parts) {
  return sha256(stableStringify(parts));
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function requireString(value, name, { max = 500, min = 1 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min) {
    throw new ApiError(400, `${name} 必须是非空字符串`);
  }
  const v = value.trim();
  if (v.length > max) throw new ApiError(400, `${name} 长度不能超过 ${max}`);
  return v;
}

export function requireNumber(value, name, { min = -1e12, max = 1e12 } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new ApiError(400, `${name} 必须是有效数字`);
  }
  return n;
}

export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

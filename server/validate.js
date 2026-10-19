import { HttpError } from './util.js';






export function validate(schema, input, { partial = false, path = '' } = {}) {
  const errors = {};
  const out = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (input !== undefined && input !== null && src !== input) throw new HttpError(422, 'Expected an object', { [path || '_']: 'must be an object' });

  for (const [key, rule] of Object.entries(schema)) {
    const full = path ? `${path}.${key}` : key;
    let v = src[key];
    if (v === undefined || v === null || v === '') {
      if (v === null && rule.nullable) { out[key] = null; continue; }
      if (partial && v === undefined) continue;
      if (rule.default !== undefined) { out[key] = typeof rule.default === 'function' ? rule.default() : rule.default; continue; }
      if (rule.required) errors[full] = 'is required';
      else if (rule.nullable) out[key] = null;
      continue;
    }
    try {
      out[key] = check(rule, v, full);
    } catch (e) {
      if (e instanceof HttpError && e.details) Object.assign(errors, e.details);
      else errors[full] = e.message;
    }
  }
  if (Object.keys(errors).length) throw new HttpError(422, 'Validation failed', errors);
  return out;
}

function check(rule, v, full) {
  switch (rule.type) {
    case 'string': case 'url': case 'email': {
      if (typeof v !== 'string') throw new Error('must be a string');
      if (rule.trim !== false) v = v.trim();
      if (rule.min !== undefined && v.length < rule.min) throw new Error(`must be at least ${rule.min} characters`);
      if (rule.max !== undefined && v.length > rule.max) throw new Error(`must be at most ${rule.max} characters`);
      if (rule.enum && !rule.enum.includes(v)) throw new Error(`must be one of: ${rule.enum.join(', ')}`);
      if (rule.pattern && !rule.pattern.test(v)) throw new Error(rule.message || 'has an invalid format');
      if (rule.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error('must be a valid email');
      if (rule.type === 'url') {
        let u;
        try { u = new URL(v); } catch { throw new Error('must be a valid URL'); }
        const protos = rule.protocols || ['http:', 'https:'];
        if (!protos.includes(u.protocol)) throw new Error(`must use ${protos.join(' or ')}`);
      }
      return v;
    }
    case 'int': case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('must be a number');
      if (rule.type === 'int' && !Number.isInteger(n)) throw new Error('must be an integer');
      if (rule.min !== undefined && n < rule.min) throw new Error(`must be ≥ ${rule.min}`);
      if (rule.max !== undefined && n > rule.max) throw new Error(`must be ≤ ${rule.max}`);
      return n;
    }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1) return true;
      if (v === 'false' || v === 0) return false;
      throw new Error('must be true or false');
    }
    case 'array': {
      if (!Array.isArray(v)) throw new Error('must be an array');
      if (rule.max !== undefined && v.length > rule.max) throw new Error(`must have at most ${rule.max} items`);
      if (rule.min !== undefined && v.length < rule.min) throw new Error(`must have at least ${rule.min} items`);
      if (!rule.items) return v;
      const errs = {};
      const items = v.map((item, i) => {
        try { return check(rule.items, item, `${full}[${i}]`); } catch (e) {
          if (e instanceof HttpError && e.details) Object.assign(errs, e.details); else errs[`${full}[${i}]`] = e.message;
        }
      });
      if (Object.keys(errs).length) throw new HttpError(422, 'Validation failed', errs);
      return items;
    }
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) throw new Error('must be an object');
      return rule.props ? validate(rule.props, v, { path: full }) : v;
    }
    case 'record': {
       
      if (typeof v !== 'object' || Array.isArray(v)) throw new Error('must be an object');
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (typeof val !== 'string' && typeof val !== 'number') throw new Error(`"${k}" must be a string`);
        out[k] = String(val);
      }
      if (Object.keys(out).length > (rule.max ?? 50)) throw new Error('too many entries');
      return out;
    }
    default:
      return v;
  }
}

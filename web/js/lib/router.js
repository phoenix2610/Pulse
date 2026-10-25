 
export function createRouter(routes, { onChange } = {}) {
  const compiled = routes.map(([pattern, handler]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    return { re, keys, handler, pattern };
  });
  let cleanup = null;
  let current = null;

  function parse() {
    const raw = location.hash.slice(1) || '/';
    const [path, qs = ''] = raw.split('?');
    return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
  }

  async function resolve() {
    const { path, query } = parse();
    if (typeof cleanup === 'function') { try { cleanup(); } catch {   } }
    cleanup = null;
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      current = { path, pattern: r.pattern, params };
      onChange?.(current);
      cleanup = await r.handler(params, query);
      return;
    }
    location.hash = '#/';
  }

  window.addEventListener('hashchange', resolve);
  return { start: resolve, get current() { return current; }, refresh: resolve };
}

export const go = (path) => { location.hash = '#' + path; };
export const link = (path) => '#' + path;

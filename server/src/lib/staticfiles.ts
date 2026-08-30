import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, posix } from 'node:path';

/**
 * Static file serving with no dependency and no path traversal surface.
 *
 * The entire built console is read into memory ONCE at boot and served from a
 * Map keyed by exact URL path. Requests are looked up, never resolved against
 * the filesystem, so there is no `../`, no encoded separator, no symlink and no
 * case-folding trick that can reach a file outside the bundle -- because after
 * boot the server never touches the disk at all.
 *
 * This replaced @fastify/static, which shipped four path-traversal advisories.
 * The point is not that the library was careless; it is that "resolve a
 * user-supplied string to a filesystem path" is a hazardous operation we do not
 * actually need. A payments server should not carry an attack surface to save
 * thirty lines.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticAsset {
  body: Buffer;
  contentType: string;
  immutable: boolean;
}

export interface StaticBundle {
  assets: Map<string, StaticAsset>;
  index: StaticAsset | null;
  count: number;
  bytes: number;
}

const MAX_BYTES = 64 * 1024 * 1024;

export function loadBundle(root: string): StaticBundle {
  const assets = new Map<string, StaticAsset>();
  let bytes = 0;

  if (!existsSync(join(root, 'index.html'))) {
    return { assets, index: null, count: 0, bytes: 0 };
  }

  const walk = (dir: string, urlPrefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Symlinks are skipped outright rather than followed: a link inside the
      // build output is the one way a bundle could still point elsewhere.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      const url = posix.join(urlPrefix, entry.name);
      if (entry.isDirectory()) {
        walk(full, url);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = statSync(full).size;
      if (bytes + size > MAX_BYTES) continue;
      const ext = extname(entry.name).toLowerCase();
      assets.set(url, {
        body: readFileSync(full),
        contentType: MIME[ext] ?? 'application/octet-stream',
        // Vite fingerprints hashed assets, so those are safe to cache hard.
        immutable: url.startsWith('/assets/'),
      });
      bytes += size;
    }
  };

  walk(root, '/');

  return {
    assets,
    index: assets.get('/index.html') ?? null,
    count: assets.size,
    bytes,
  };
}

/**
 * Exact-match lookup. Anything not in the bundle returns the SPA shell so
 * client-side routes work -- which also means a traversal attempt gets the
 * homepage, not an error page that confirms what exists.
 */
export function lookup(bundle: StaticBundle, urlPath: string): StaticAsset | null {
  const path = urlPath.split('?')[0]!.split('#')[0]!;
  if (path === '/' || path === '') return bundle.index;
  return bundle.assets.get(path) ?? null;
}

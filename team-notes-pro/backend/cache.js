// Thin Redis wrapper for Stage 6 (ElastiCache).
//
// Cache key design:
//   notes:{userId}   — JSON array of the user's notes list, TTL 60 s
//
// Cache invalidation strategy (cache-aside):
//   READ  — check Redis first; on miss, query DB, populate cache, return result
//   WRITE — update DB first, then delete the cache key
//
// We delete rather than update the cached array because rebuilding from a fresh
// DB read is simpler and less error-prone than patching a stale in-memory list.
// The 60 s TTL is a safety net; explicit delete on every write is what keeps
// data accurate.
//
// If REDIS_URL is not set the module returns a no-op cache so the app works
// identically to Stage 5 — no Redis, no errors, every request hits the DB.
// This also means the app degrades gracefully if Redis becomes unavailable.

const Redis = require('ioredis');

function createCache() {
  if (!process.env.REDIS_URL) {
    return {
      get: async ()         => null,
      set: async ()         => {},
      del: async ()         => {},
    };
  }

  const client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,   // fail fast rather than queue commands when Redis is down
    enableReadyCheck:     false,
    lazyConnect:          false,
  });

  client.on('error', (err) => console.error('[cache]', err.message));

  return {
    async get(key) {
      try {
        const raw = await client.get(key);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        console.error('[cache] get:', err.message);
        return null; // treat as miss — fall through to DB
      }
    },

    async set(key, value, ttlSeconds = 60) {
      try {
        await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      } catch (err) {
        console.error('[cache] set:', err.message);
        // non-fatal: the DB result was already returned to the client
      }
    },

    async del(key) {
      try {
        await client.del(key);
      } catch (err) {
        console.error('[cache] del:', err.message);
        // non-fatal: TTL will expire the stale entry within 60 s
      }
    },
  };
}

module.exports = { createCache };

import { redis } from '../config/redis';

/**
 * Read-through cache with Redis backend and in-memory fallback.
 * TTLs are short (seconds) — this is a hot-path smoother, not a
 * source of truth. Values must be JSON-serialisable.
 */
const memory = new Map<string, { value: string; expiresAt: number }>();
const MEMORY_MAX_KEYS = 500;

export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>
): Promise<T> {
  const namespaced = `cache:${key}`;

  if (redis) {
    try {
      const hit = await redis.get(namespaced);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch {
      // Redis hiccup — fall through to loader
    }
    const value = await loader();
    redis.set(namespaced, JSON.stringify(value), 'EX', ttlSeconds).catch(() => {});
    return value;
  }

  const now = Date.now();
  const entry = memory.get(namespaced);
  if (entry && entry.expiresAt > now) return JSON.parse(entry.value) as T;

  const value = await loader();
  if (memory.size >= MEMORY_MAX_KEYS) {
    // Cheap eviction: drop the oldest half rather than tracking LRU.
    const keys = [...memory.keys()].slice(0, MEMORY_MAX_KEYS / 2);
    for (const k of keys) memory.delete(k);
  }
  memory.set(namespaced, { value: JSON.stringify(value), expiresAt: now + ttlSeconds * 1000 });
  return value;
}

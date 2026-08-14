jest.mock('../../config/redis', () => ({ redis: null }));

import { __testing, topics } from '../../realtime/hub';

const { maySubscribe, normaliseTopics, nextSeq, buffer, ringBuffers, localSeq } = __testing;

const client = (userId: number | null) => ({ userId }) as any;

beforeEach(() => __testing.reset());

describe('topic names', () => {
  it('builds stable, lowercase topic strings', () => {
    expect(topics.venue(12)).toBe('venue:12');
    expect(topics.slot(98765)).toBe('slot:98765');
    expect(topics.user(42)).toBe('user:42');
    expect(topics.event(7)).toBe('event:7');
  });

  it('slugifies city names so "Bad Homburg" and "bad homburg" agree', () => {
    expect(topics.city('München')).toBe('city:münchen');
    expect(topics.city('Bad Homburg')).toBe('city:bad-homburg');
    expect(topics.city('  Berlin  ')).toBe('city:berlin');
  });
});

describe('topic authorization', () => {
  it('lets anonymous sockets watch public court state', () => {
    for (const topic of ['venue:12', 'slot:5', 'city:berlin', 'event:7']) {
      expect(maySubscribe(client(null), topic)).toBe(true);
    }
  });

  it('restricts user topics to that user', () => {
    expect(maySubscribe(client(42), 'user:42')).toBe(true);
    expect(maySubscribe(client(42), 'user:43')).toBe(false);
    expect(maySubscribe(client(null), 'user:42')).toBe(false);
  });

  it('rejects unknown namespaces and malformed topics', () => {
    for (const topic of ['admin:1', 'venue:', 'venue', '*', 'venue:12; DROP TABLE', 'USER:42']) {
      expect(maySubscribe(client(42), topic)).toBe(false);
    }
  });

  it('does not let a numeric prefix impersonate another user', () => {
    expect(maySubscribe(client(4), 'user:42')).toBe(false);
    expect(maySubscribe(client(42), 'user:042')).toBe(false);
  });
});

describe('topic normalisation', () => {
  it('deduplicates, trims and drops non-strings', () => {
    expect(normaliseTopics(['venue:1', ' venue:1 ', 'venue:2', 42, null, ''])).toEqual([
      'venue:1',
      'venue:2',
    ]);
  });

  it('accepts a bare string as a single topic', () => {
    expect(normaliseTopics('venue:1')).toEqual(['venue:1']);
  });

  it('caps the number of topics in one message', () => {
    const many = Array.from({ length: 200 }, (_, i) => `venue:${i}`);
    expect(normaliseTopics(many)).toHaveLength(40);
  });

  it('drops absurdly long topic strings', () => {
    expect(normaliseTopics(['venue:' + 'x'.repeat(200)])).toEqual([]);
  });

  it('returns empty for junk input', () => {
    expect(normaliseTopics(undefined)).toEqual([]);
    expect(normaliseTopics({})).toEqual([]);
  });
});

describe('sequencing', () => {
  it('increments per topic independently', () => {
    expect(nextSeq('venue:1')).toBe(1);
    expect(nextSeq('venue:1')).toBe(2);
    expect(nextSeq('venue:2')).toBe(1);
    expect(localSeq.get('venue:1')).toBe(2);
  });
});

describe('ring buffer', () => {
  const frame = (topic: string, seq: number, ts = new Date().toISOString()) =>
    ({ type: 'event', topic, seq, ts, event: 'slot_freed', payload: {} }) as any;

  it('retains recent frames for reconnect backfill', () => {
    buffer(frame('venue:1', 1));
    buffer(frame('venue:1', 2));
    expect(ringBuffers.get('venue:1')?.map((f: any) => f.seq)).toEqual([1, 2]);
  });

  it('caps retention so a busy venue cannot grow without bound', () => {
    for (let i = 1; i <= 250; i++) buffer(frame('venue:1', i));
    const kept = ringBuffers.get('venue:1')!;
    expect(kept).toHaveLength(200);
    expect(kept[0].seq).toBe(51);
    expect(kept[kept.length - 1].seq).toBe(250);
  });

  it('evicts frames older than the retention window', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    buffer(frame('venue:1', 1, old));
    buffer(frame('venue:1', 2));
    expect(ringBuffers.get('venue:1')?.map((f: any) => f.seq)).toEqual([2]);
  });

  it('drops the topic entirely once everything has aged out', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    buffer(frame('venue:9', 1, old));
    expect(ringBuffers.has('venue:9')).toBe(false);
  });

  it('keeps topics separate', () => {
    buffer(frame('venue:1', 1));
    buffer(frame('slot:5', 1));
    expect(ringBuffers.get('venue:1')).toHaveLength(1);
    expect(ringBuffers.get('slot:5')).toHaveLength(1);
  });
});

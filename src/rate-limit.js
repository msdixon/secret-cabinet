'use strict';

// #594 — a minimal in-memory failure counter for sign-in endpoints. The
// passphrase login had no limit at all before this; once the passphrase
// signs in as the admin rather than as "whoever knows the shared secret",
// guessing it is worth more, so it gets one. Chunk A's emailed-code sends
// and code checks reuse the same limiter.
//
// Fixed window per key, counting failures only: a key is blocked once it
// has `max` failures inside `windowMs`, and unblocks when that window ends.
// In-memory is deliberate — a single Railway process, and a restart
// resetting the counters is an acceptable loss at this scale.

function createFailureLimiter({ windowMs, max, now = () => Date.now() }) {
  const buckets = new Map();

  function current(key) {
    const bucket = buckets.get(key);
    if (bucket && now() - bucket.start < windowMs) return bucket;
    buckets.delete(key);
    return null;
  }

  return {
    isBlocked: key => {
      const bucket = current(key);
      return !!bucket && bucket.count >= max;
    },
    recordFailure: key => {
      const bucket = current(key);
      if (bucket) bucket.count++;
      else buckets.set(key, { start: now(), count: 1 });
    },
    reset: key => buckets.delete(key),
  };
}

module.exports = { createFailureLimiter };

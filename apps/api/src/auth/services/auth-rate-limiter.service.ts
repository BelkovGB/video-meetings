import { Injectable } from '@nestjs/common';

type RateLimitBucket = {
  requests: number;
  windowStartedAt: number;
};

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const maximumBuckets = 10_000;

@Injectable()
export class AuthRateLimiterService {
  private readonly buckets = new Map<string, RateLimitBucket>();

  consume(key: string, maximumRequests: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStartedAt >= windowMs) {
      this.setBucket(key, { requests: 1, windowStartedAt: now });
      return { allowed: true };
    }

    if (bucket.requests >= maximumRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStartedAt + windowMs - now) / 1000)),
      };
    }

    bucket.requests += 1;
    return { allowed: true };
  }

  private setBucket(key: string, bucket: RateLimitBucket) {
    if (!this.buckets.has(key) && this.buckets.size >= maximumBuckets) {
      const oldestKey = this.buckets.keys().next().value;

      if (oldestKey) {
        this.buckets.delete(oldestKey);
      }
    }

    this.buckets.set(key, bucket);
  }
}

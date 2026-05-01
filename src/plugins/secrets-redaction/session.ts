// FILE: src/plugins/secrets-redaction/session.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Manages placeholder lifecycle for secret redaction — generates stable HMAC-based placeholders,
//            maintains forward/reverse mappings, handles TTL eviction and max-mappings limits.
//   SCOPE: placeholder creation, lookup, cleanup
//   DEPENDS: node:crypto
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PlaceholderSession - manages secret → placeholder mappings with HMAC hashing
//   getPlaceholderRegex - returns RegExp to find all placeholders in text
//   PlaceholderSessionOptions - Session configuration options.
//   PlaceholderEntry - Individual placeholder mapping entry.
//   generateFallbackSecret - Generate fallback secret string.
// END_MODULE_MAP
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

import { createHmac, randomBytes } from "node:crypto";

export interface PlaceholderSessionOptions {
  prefix: string;
  ttlMs: number;
  maxMappings: number;
  secret: string;
}

export interface PlaceholderEntry {
  original: string;
  placeholder: string;
  category: string;
  createdAt: number;
}

export class PlaceholderSession {
  private readonly prefix: string;
  private readonly ttlMs: number;
  private readonly maxMappings: number;
  private readonly secret: Buffer;
  private readonly forward: Map<string, PlaceholderEntry> = new Map();
  private readonly reverse: Map<string, string> = new Map();
  private readonly created: Map<string, number> = new Map();

  constructor(options: PlaceholderSessionOptions) {
    this.prefix = options.prefix;
    this.ttlMs = options.ttlMs;
    this.maxMappings = options.maxMappings;
    this.secret = Buffer.from(options.secret, "utf-8");
  }

  private computeHash(original: string): string {
    return createHmac("sha256", this.secret).update(original, "utf-8").digest("hex");
  }

  getOrCreatePlaceholder(original: string, category: string): string {
    if (this.reverse.has(original)) {
      return this.reverse.get(original)!;
    }

    this.evictIfNeeded();

    const hash = this.computeHash(original);
    const hash12 = hash.substring(0, 12);
    let placeholder = `${this.prefix}${category}_${hash12}__`;

    if (this.forward.has(placeholder)) {
      let counter = 1;
      while (this.forward.has(placeholder)) {
        placeholder = `${this.prefix}${category}_${hash12}_${counter}__`;
        counter++;
      }
    }

    const entry: PlaceholderEntry = {
      original,
      placeholder,
      category,
      createdAt: Date.now(),
    };

    this.forward.set(placeholder, entry);
    this.reverse.set(original, placeholder);
    this.created.set(placeholder, Date.now());

    return placeholder;
  }

  lookup(placeholder: string): string | undefined {
    return this.forward.get(placeholder)?.original;
  }

  cleanup(now: number): number {
    let evicted = 0;
    const expired: string[] = [];

    for (const [placeholder, createdAt] of this.created) {
      if (now - createdAt > this.ttlMs) {
        expired.push(placeholder);
      }
    }

    for (const placeholder of expired) {
      const entry = this.forward.get(placeholder);
      if (entry) {
        this.reverse.delete(entry.original);
        this.forward.delete(placeholder);
        this.created.delete(placeholder);
        evicted++;
      }
    }

    return evicted;
  }

  private evictIfNeeded(): void {
    if (this.forward.size < this.maxMappings) return;

    let oldestPlaceholder: string | null = null;
    let oldestCreated = Infinity;

    for (const [placeholder, createdAt] of this.created) {
      if (createdAt < oldestCreated) {
        oldestCreated = createdAt;
        oldestPlaceholder = placeholder;
      }
    }

    if (oldestPlaceholder) {
      const entry = this.forward.get(oldestPlaceholder);
      if (entry) {
        this.reverse.delete(entry.original);
        this.forward.delete(oldestPlaceholder);
        this.created.delete(oldestPlaceholder);
      }
    }
  }

  get size(): number {
    return this.forward.size;
  }
}

export function getPlaceholderRegex(prefix: string): RegExp {
  return new RegExp(`${prefix}[A-Z_]+_[0-9a-f]{12}(?:_\\d+)?__`, "g");
}

export function generateFallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

// FILE: src/plugins/hashline-edit/session-state.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Track per-session model identity and per-session file snapshots for edit-mode routing and stale-write protection.
//   SCOPE: Session model cache keyed by sessionID and session file cache comparing recorded mtime/size snapshots against current file state.
//   DEPENDS: [none]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SessionModelInfo - Provider and model identifiers resolved for a session.
//   SessionModelCache - Per-session model identity store populated from chat.message.
//   FileSnapshot - Recorded mtime and size for a file at read or view time.
//   FileCacheVerdict - Outcome of comparing a current file state against a recorded snapshot.
//   SessionFileCache - Per-session file snapshot store used for prior-read and view-freshness checks.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Established session model cache and session file cache with drift detection.]
// END_CHANGE_SUMMARY

// START_BLOCK_MODEL_CACHE
export interface SessionModelInfo {
  providerID: string;
  modelID: string;
}

export class SessionModelCache {
  readonly #models = new Map<string, SessionModelInfo>();

  set(sessionID: string, model: SessionModelInfo): void {
    this.#models.set(sessionID, { providerID: model.providerID, modelID: model.modelID });
  }

  get(sessionID: string): SessionModelInfo | undefined {
    return this.#models.get(sessionID);
  }

  delete(sessionID: string): void {
    this.#models.delete(sessionID);
  }

  clear(): void {
    this.#models.clear();
  }
}
// END_BLOCK_MODEL_CACHE

// START_BLOCK_FILE_CACHE
export interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

export type FileCacheVerdict = "unread" | "fresh" | "drifted";

export class SessionFileCache {
  readonly #files = new Map<string, FileSnapshot>();

  #key(sessionID: string, filePath: string): string {
    return `${sessionID}\u0000${filePath}`;
  }

  record(sessionID: string, filePath: string, snapshot: FileSnapshot): void {
    this.#files.set(this.#key(sessionID, filePath), {
      mtimeMs: snapshot.mtimeMs,
      size: snapshot.size,
    });
  }

  check(sessionID: string, filePath: string, current: FileSnapshot | undefined): FileCacheVerdict {
    const recorded = this.#files.get(this.#key(sessionID, filePath));
    if (recorded === undefined) {
      return "unread";
    }
    if (current === undefined) {
      return "drifted";
    }
    if (current.mtimeMs !== recorded.mtimeMs || current.size !== recorded.size) {
      return "drifted";
    }
    return "fresh";
  }

  forget(sessionID: string, filePath: string): void {
    this.#files.delete(this.#key(sessionID, filePath));
  }

  clear(): void {
    this.#files.clear();
  }
}
// END_BLOCK_FILE_CACHE

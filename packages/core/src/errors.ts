/**
 * Errors.
 *
 * Absence is *not* an error here: `file()` and `directory()` return `null`, so
 * testing whether something exists needs no try/catch. These are for the cases
 * where a caller asked for something impossible, or the store misbehaved —
 * distinguishable types, because the two need opposite handling. "Not a data
 * tree" means look somewhere else; "not found" is often expected.
 */

/** A backend cannot do what was asked — writing to HTTP, for instance. */
export class UnsupportedOperationError extends Error {
  constructor(operation: string, backend: string) {
    super(`${backend} cannot ${operation}`);
    this.name = "UnsupportedOperationError";
  }
}

/** The store answered, but not with what was asked for. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = "BackendError";
  }
}

/**
 * A remote host returned a web page where data was expected.
 *
 * Its own type because it needs the opposite handling from a 404: a 404 means
 * *this file* is absent, which is normal, while HTML means the whole tree is
 * somewhere else — a single-page app answers any unknown path with its own
 * HTML and a 200, so a mistyped base URL otherwise looks like a working tree
 * whose every file happens to be a document.
 */
export class NotDataError extends BackendError {
  constructor(
    readonly url: string,
    readonly contentType: string,
  ) {
    super(`server returned ${contentType}, not data — is this really a data tree?`, url);
    this.name = "NotDataError";
  }
}

/** A host that ignores `Range` would silently return the wrong bytes. */
export class RangeUnsupportedError extends BackendError {
  constructor(url: string, status: number) {
    super(`expected 206 for a Range request, got ${status} — the host ignores Range`, url);
    this.name = "RangeUnsupportedError";
  }
}

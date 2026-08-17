/**
 * The one reader of an API error body.
 *
 * Every screen used to carry its own copy, and the copies drifted: one rendered
 * an empty paragraph when the validation array held an empty first element,
 * another fell back, and three more only ever looked at the message when it was
 * a plain string. Callers supply the wording; the shape of the body — including
 * what a body that is not JSON means — is decided here.
 *
 * A screen that words its text from `code` still routes it itself, because the
 * mapping is per screen, but it parses through `readApiErrorBody` so there is
 * no second answer to a malformed body.
 */

import type { ApiError, CodedApiError } from './contracts';

/**
 * What to show when the body says nothing usable. `validation` covers the
 * array-shaped body the API returns for field validation: a screen that words
 * its own field guidance shows that sentence instead of the server's English
 * prose. Without it the first non-empty element of the array is shown.
 */
export type ApiErrorFallback = string | { default: string; validation?: string };

function defaultMessage(fallback: ApiErrorFallback): string {
  return typeof fallback === 'string' ? fallback : fallback.default;
}

/** Picks the message out of an already parsed error body. */
export function apiErrorMessage(body: ApiError | null | undefined, fallback: ApiErrorFallback) {
  const message = body?.message;

  if (Array.isArray(message)) {
    if (typeof fallback !== 'string' && fallback.validation) {
      return fallback.validation;
    }

    // An empty element renders as no message at all, so it falls back instead.
    // The type says the elements are strings, but the body is whatever the wire
    // carried: an object here would reach React as a child and take the screen
    // down, where the fallback leaves it recoverable.
    const [first] = message;
    return typeof first === 'string' && first ? first : defaultMessage(fallback);
  }

  if (typeof message === 'string' && message) {
    return message;
  }

  return defaultMessage(fallback);
}

/**
 * Parses the body of a failed response, or `null` when there is nothing to
 * read. A body that is not JSON is not exceptional — the API answers plain text
 * for some failures — so it is reported as "nothing to go on" rather than
 * thrown, and one place decides what a malformed body means for every caller.
 *
 * Screens that word their text from `code` read this directly; the ones that
 * show the server's `message` go through `readApiErrorMessage`.
 */
export async function readApiErrorBody(response: Response): Promise<CodedApiError | null> {
  try {
    return (await response.json()) as CodedApiError;
  } catch {
    return null;
  }
}

/**
 * Reads the message out of a failed response. A body with nothing to say and a
 * body that is not JSON at all land on the same fallback.
 */
export async function readApiErrorMessage(
  response: Response,
  fallback: ApiErrorFallback,
): Promise<string> {
  return apiErrorMessage(await readApiErrorBody(response), fallback);
}

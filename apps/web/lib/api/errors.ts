/**
 * The one reader of an API error body.
 *
 * Every screen used to carry its own copy, and the copies drifted: one rendered
 * an empty paragraph when the validation array held an empty first element,
 * another fell back, and two more only ever looked at the message when it was a
 * plain string. Callers supply the wording; the shape of the body is decided
 * here.
 */

import type { ApiError } from './contracts';

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
    const [first] = message;
    return first || defaultMessage(fallback);
  }

  if (typeof message === 'string' && message) {
    return message;
  }

  return defaultMessage(fallback);
}

/**
 * Reads the message out of a failed response. A body that is not JSON is not
 * exceptional — the API answers plain text for some failures — and it lands on
 * the same fallback as a body with nothing to say.
 */
export async function readApiErrorMessage(
  response: Response,
  fallback: ApiErrorFallback,
): Promise<string> {
  try {
    return apiErrorMessage((await response.json()) as ApiError, fallback);
  } catch {
    return defaultMessage(fallback);
  }
}

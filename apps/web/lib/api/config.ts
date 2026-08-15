/**
 * Base URL of the API.
 *
 * `NEXT_PUBLIC_*` is inlined at build time, so this is a constant in the bundle
 * exactly as the per-file copies were.
 */
export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

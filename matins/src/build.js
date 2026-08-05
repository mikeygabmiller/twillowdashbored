// Build fingerprint. Bump on every deploy; /api/version returns it, so you can
// tell what is actually live instead of what you think you pushed.
// (Kept in its own module because the Workers runtime only accepts handler
// exports from the entry point.)
export const BUILD = '2026-08-05·matins-2';

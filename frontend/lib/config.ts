// ---------------------------------------------------------------------------
// Central app config — all environment-specific values live here.
//
// Expo exposes env vars to the JS bundle only when they are prefixed with
// EXPO_PUBLIC_. Set these in a .env file at the frontend root.
// ---------------------------------------------------------------------------

// Backend API base URL — no trailing slash
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

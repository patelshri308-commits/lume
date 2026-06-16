// ---------------------------------------------------------------------------
// Central app config — all environment-specific values live here.
//
// Expo exposes env vars to the JS bundle only when they are prefixed with
// EXPO_PUBLIC_. Set these in a .env file at the frontend root.
// ---------------------------------------------------------------------------

// Backend API base URL — no trailing slash.
// EXPO_PUBLIC_API_URL must be set for real-device and production builds.
// The 127.0.0.1 fallback is only valid for local web/simulator dev runs.
const _apiUrl = process.env.EXPO_PUBLIC_API_URL;
if (!_apiUrl && !__DEV__) {
  throw new Error("EXPO_PUBLIC_API_URL is required in non-dev builds. Set it in your .env file.");
}
export const API_URL: string = _apiUrl ?? "http://127.0.0.1:8000";

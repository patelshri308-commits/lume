// ---------------------------------------------------------------------------
// Central app config — all environment-specific values live here.
//
// Expo exposes env vars to the JS bundle only when they are prefixed with
// EXPO_PUBLIC_. Set these in a .env file at the frontend root.
// ---------------------------------------------------------------------------

// Backend API base URL — no trailing slash.
// EXPO_PUBLIC_API_URL must be set in frontend/.env for all runs except
// local simulator/web dev. Real-device dev requires the machine's LAN IP
// (e.g. http://192.168.x.x:8000) or the deployed Render URL.
const _apiUrl = process.env.EXPO_PUBLIC_API_URL;
if (!_apiUrl) {
  if (!__DEV__) {
    throw new Error("EXPO_PUBLIC_API_URL is required in non-dev builds. Set it in frontend/.env.");
  } else {
    console.warn(
      "[Lume] EXPO_PUBLIC_API_URL is not set. Falling back to http://127.0.0.1:8000, " +
      "which only works in simulators. Real-device runs need the machine LAN IP or deployed URL " +
      "set in frontend/.env as EXPO_PUBLIC_API_URL=http://<your-ip>:8000"
    );
  }
}
export const API_URL: string = _apiUrl ?? "http://127.0.0.1:8000";

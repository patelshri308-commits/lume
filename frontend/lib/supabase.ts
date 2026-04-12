import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Supabase project credentials — set these in a .env file at the frontend root.
// Dashboard → Project Settings → API
//   EXPO_PUBLIC_SUPABASE_URL      → "Project URL"
//   EXPO_PUBLIC_SUPABASE_ANON_KEY → "anon / public" key (safe to expose in a client app)
// ---------------------------------------------------------------------------
const SUPABASE_URL      = process.env.EXPO_PUBLIC_SUPABASE_URL      ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,    // persist the session on device between app launches
    autoRefreshToken: true,   // keep the session alive automatically
    persistSession: true,
    detectSessionInUrl: false, // must be false in React Native (no browser URL bar)
  },
});

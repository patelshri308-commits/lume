import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Replace these two values with your own project credentials.
// Supabase Dashboard → Project Settings → API
//   SUPABASE_URL     → "Project URL"
//   SUPABASE_ANON_KEY → "anon / public" key  (safe to expose in a client app)
// ---------------------------------------------------------------------------
const SUPABASE_URL      = "https://qyqgaluliillpagyagpc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5cWdhbHVsaWlsbHBhZ3lhZ3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4NTcyODEsImV4cCI6MjA5MTQzMzI4MX0.fd9Ieau_HGWpi-xQBQE9Tzwv_5WjN0x9crCl_7-D_Oo";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,    // persist the session on device between app launches
    autoRefreshToken: true,   // keep the session alive automatically
    persistSession: true,
    detectSessionInUrl: false, // must be false in React Native (no browser URL bar)
  },
});

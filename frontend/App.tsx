import React, { useState, useEffect, useRef } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, Modal, Linking, InputAccessoryView } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
const barcodIcon = require("./assets/barcode.png");
import { useFonts } from "expo-font";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import {
  Alert,
  Animated,
  Image,
  PanResponder,
  RefreshControl,
  View,
  Text,
  TextInput,
  Button,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Pressable,
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Circle, G, Defs, LinearGradient as SvgLinearGradient, Stop, Line as SvgLine, Path as SvgPath } from "react-native-svg";
import axios from "axios";
import { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { API_URL } from "./lib/config";
// AsyncStorage import removed — hydration data now persisted via Supabase

type NutritionResult = {
  name:         string;
  calories:     number;
  protein:      number;
  carbs:        number;
  fat:          number;
  is_estimated?: boolean;          // optional: old log rows have null; treat absent as false
  source_type?:         string;    // e.g. "generic", "barcode", "packaged_product", "restaurant"
  confidence?:          number;    // 0.0–1.0 from backend query router
  brand_name?:          string | null;
  serving_description?: string | null;
};

// Nutrition-source fields used by the badge renderer.
// Satisfied by both NutritionResult (search results) and FoodLogEntry (DB rows).
type FoodSourceMeta = Pick<NutritionResult, "source_type" | "confidence" | "is_estimated" | "serving_description">;

type FoodLogEntry = NutritionResult & { id: number; created_at: string };

type DailySummary = {
  total_calories: number;
  total_protein:  number;
  total_carbs:    number;
  total_fat:      number;
  entries_count:  number;
};

type WeeklyDay = {
  date:           string;
  total_calories: number;
};

type UserProfile = {
  user_id:              string;
  display_name:         string | null;
  sex:                  string | null;
  age:                  number | null;
  height_cm:            number | null;
  weight_kg:            number | null;
  goal_type:            string;
  activity_level:       string;
  onboarding_completed: boolean;
};

// Mirrors the setup form fields as strings so TextInputs work naturally.
type SetupFields = {
  display_name:   string;
  sex:            string;
  age:            string;
  height_cm:      string;
  weight_kg:      string;
  goal_type:      string;
  activity_level: string;
};

// ── Date helpers ─────────────────────────────────────────────────────────────

// Converts a JS Date to a YYYY-MM-DD string using local (device) time.
function formatDateToLocalYYYYMMDD(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

// Parses a YYYY-MM-DD string as a local-time Date.
// Avoids the UTC-shift bug from new Date("YYYY-MM-DD") (which parses as UTC).
function parseDateStringToLocalDate(s: string): Date {
  const [year, month, day] = s.split("-").map(Number);
  return new Date(year, month - 1, day);
}

// Returns today's date as YYYY-MM-DD in local time.
function localToday(): string {
  return formatDateToLocalYYYYMMDD(new Date());
}

// Returns true only for structurally valid YYYY-MM-DD date strings.
// Rejects impossible dates (e.g. 2026-02-30) by confirming the
// constructed date's components round-trip back to the original values.
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [year, month, day] = s.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

// Returns a readable label for a YYYY-MM-DD string, e.g. "April 7th, 2026".
function formatDateLabel(dateStr: string): string {
  const date   = parseDateStringToLocalDate(dateStr);
  const month  = date.toLocaleDateString([], { month: "long" });
  const day    = date.getDate();
  const suffix =
    day % 100 >= 11 && day % 100 <= 13 ? "th"
    : day % 10 === 1 ? "st"
    : day % 10 === 2 ? "nd"
    : day % 10 === 3 ? "rd"
    : "th";
  return `${month} ${day}${suffix}, ${date.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Pure helper — no state dependency, lives outside the component.
// Parses a leading quantity word or digit from the raw query string.
// ---------------------------------------------------------------------------
function _parseQuery(raw: string): { foodQuery: string; parsedServings: number } {
  const NUMBER_WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4,  five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const wordList = Object.keys(NUMBER_WORDS).join("|");
  const pattern  = new RegExp(`^(\\d+|${wordList})\\s+(.+)$`, "i");
  const match    = raw.trim().match(pattern);
  if (match) {
    const token = match[1].toLowerCase();
    return {
      parsedServings: NUMBER_WORDS[token] ?? parseInt(token, 10),
      foodQuery:      match[2].trim(),
    };
  }
  return { parsedServings: 1, foodQuery: raw.trim() };
}

// ---------------------------------------------------------------------------
// computeCalorieTarget — pure function, no side effects.
// Derives a personalized daily calorie target from the user's saved profile
// using Mifflin–St Jeor BMR → TDEE → goal adjustment → safety floor.
// ---------------------------------------------------------------------------
function computeCalorieTarget(profile: UserProfile): number {
  const { weight_kg, height_cm, age, sex, activity_level, goal_type } = profile;

  // Guard: if any required biometric is missing, fall back to safe default.
  if (!weight_kg || !height_cm || !age) return 2000;

  // ── Mifflin–St Jeor BMR ──────────────────────────────────────────────────
  let bmr: number;
  if (sex === "male") {
    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + 5;
  } else if (sex === "female") {
    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age - 161;
  } else {
    // "other" — V1 midpoint between male (+5) and female (−161) constants
    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age - 78;
  }

  // ── TDEE via activity multiplier ─────────────────────────────────────────
  const multipliers: Record<string, number> = {
    sedentary:  1.2,
    light:      1.35,
    moderate:   1.5,
    active:     1.65,
    very_active: 1.8,
  };
  const tdee = bmr * (multipliers[activity_level] ?? 1.5);

  // ── Goal adjustment ───────────────────────────────────────────────────────
  let targetCalories: number;
  if (goal_type === "lose") {
    const weight_lbs   = weight_kg * 2.20462;
    const weeklyDeficit = weight_lbs * 0.006 * 3500;
    const dailyDeficit  = Math.min(700, Math.max(300, weeklyDeficit / 7));
    targetCalories = tdee - dailyDeficit;
  } else if (goal_type === "gain") {
    targetCalories = tdee + 250;
  } else {
    // maintain
    targetCalories = tdee;
  }

  // ── Safety floor: never below 1 200 kcal ─────────────────────────────────
  return Math.round(Math.max(1200, targetCalories));
}

// ---------------------------------------------------------------------------
// getSourceBadgeInfo — pure helper, no state.
// Maps source_type + confidence + is_estimated to a display label and colors.
// Returns null when there is nothing meaningful to show.
// ---------------------------------------------------------------------------
type BadgeInfo = { label: string; bg: string; fg: string };

function getSourceBadgeInfo(meta: FoodSourceMeta): BadgeInfo | null {
  const { source_type, confidence, is_estimated } = meta;

  // Explicit estimates always shown, regardless of source.
  if (is_estimated) {
    return { label: "Estimated", bg: "rgba(160,160,160,0.14)", fg: "#888888" };
  }

  switch (source_type) {
    case "barcode":
      return { label: "Barcode scan", bg: "rgba(46,125,50,0.12)", fg: "#2e7d32" };
    case "packaged_product":
      return { label: "Packaged food", bg: "rgba(25,118,210,0.11)", fg: "#1565c0" };
    case "restaurant":
      return { label: "Restaurant data", bg: "rgba(25,118,210,0.11)", fg: "#1565c0" };
    case "composite_meal":
      return { label: "Composite meal", bg: "rgba(123,31,162,0.10)", fg: "#6a1b9a" };
    case "generic":
    case "usda": {
      const conf = confidence ?? 0;
      if (conf >= 0.70) return { label: "USDA", bg: "rgba(227,213,23,0.18)", fg: "#7A7200" };
      return { label: "USDA · Est.", bg: "rgba(160,160,160,0.14)", fg: "#888888" };
    }
    case "packaged_guess":
    case "restaurant_guess":
    case "ambiguous_estimate":
      return { label: "Estimated", bg: "rgba(160,160,160,0.14)", fg: "#888888" };
    default:
      return null;
  }
}

// Short inline label used in the logMessage feedback text (e.g. "Food logged · USDA").
function getSourceShortLabel(meta: FoodSourceMeta): string | null {
  const info = getSourceBadgeInfo(meta);
  if (!info) return null;
  return info.label;
}

// Maps source_type to the human-readable data provider name shown in result details.
function getProviderName(meta: FoodSourceMeta): string | null {
  const { source_type, is_estimated } = meta;
  if (is_estimated) return "Lume estimate";
  switch (source_type) {
    case "barcode":
    case "packaged_product":
    case "restaurant":
      return "Open Food Facts";
    case "generic":
    case "usda":
    case "verified_generic":
      return "USDA";
    case "composite_meal":
      return "Combined estimate";
    case "packaged_guess":
    case "restaurant_guess":
    case "ambiguous_estimate":
      return "Lume estimate";
    default:
      return null;
  }
}

// Thin shell — SafeAreaProvider must be an ancestor of any component that
// calls useSafeAreaInsets(), so it lives here, above AppInner.
export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
  const insets = useSafeAreaInsets();

  const [fontsLoaded] = useFonts({
    "Chillax-Regular":  require("./assets/fonts/Chillax-Regular.otf"),
    "Chillax-Medium":   require("./assets/fonts/Chillax-Medium.otf"),
    "Chillax-SemiBold": require("./assets/fonts/Chillax-Semibold.otf"),
    "Chillax-Bold":     require("./assets/fonts/Chillax-Bold.otf"),
    "Inter-Variable":   require("./assets/fonts/Inter-VariableFont_opsz,wght.ttf"),
  });

  const [query,      setQuery]      = useState("");
  const [logMessage, setLogMessage] = useState("");
  const [logs,       setLogs]       = useState<FoodLogEntry[]>([]);
  const [showAllLogs,    setShowAllLogs]    = useState(false);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<number>>(new Set());
  const [isSidebarOpen,  setIsSidebarOpen]  = useState(false);
  const [summary,    setSummary]    = useState<DailySummary | null>(null);
  const [todayCalories, setTodayCalories] = useState<number | null>(null);
  const [searching,       setSearching]       = useState(false);
  const [scanningLabel,   setScanningLabel]   = useState("Searching...");
  const [isSearchFocused,  setIsSearchFocused]  = useState(false);
  const [keyboardHeight,   setKeyboardHeight]   = useState(0);
  const [logsLoading,   setLogsLoading]   = useState(false);
  const [summaryLoading,setSummaryLoading]= useState(false);
  const [deletingLogId, setDeletingLogId] = useState<number | null>(null);
  const [editingLogId,  setEditingLogId]  = useState<number | null>(null);
  const [editFields,    setEditFields]    = useState({ name: "", calories: "", protein: "", carbs: "", fat: "" });
  const [savingEdit,    setSavingEdit]    = useState(false);
  const [isScannerOpen,  setIsScannerOpen]  = useState(false);
  const [scannedBarcode, setScannedBarcode] = useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanLockRef  = useRef(false);                          // prevents duplicate scan callbacks
  const sidebarAnim  = useRef(new Animated.Value(0)).current;  // 0 = closed, 1 = open
  // Solar Bloom animated glow values — each loops 0→1→0 at a different duration
  const glowOuter   = useRef(new Animated.Value(0)).current;  // 7 s
  const glowMid     = useRef(new Animated.Value(0)).current;  // 5.5 s
  const glowCore    = useRef(new Animated.Value(0)).current;  // 4 s
  const glowShimmer = useRef(new Animated.Value(0)).current;  // 6.5 s
  const [weeklyData,    setWeeklyData]    = useState<WeeklyDay[]>([]);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [refreshing,    setRefreshing]    = useState(false);
  const [selectedDate,    setSelectedDate]    = useState(localToday());
  const [showDatePicker,  setShowDatePicker]  = useState(false);

  // Auth state
  const [session,       setSession]       = useState<Session | null>(null);
  const [authEmail,     setAuthEmail]     = useState("");
  const [authPassword,  setAuthPassword]  = useState("");
  const [authMessage,   setAuthMessage]   = useState("");
  // "login" | "forgot" | "reset"
  const [authMode,             setAuthMode]             = useState<"login" | "forgot" | "reset">("login");
  const [resetEmail,           setResetEmail]           = useState("");
  const [resetPassword,        setResetPassword]        = useState("");
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState("");

  // Profile state
  // profileFetched gates the render: false = still fetching (show loading),
  // true = settled (show setup screen or tracker based on onboarding_completed).
  const [profile,        setProfile]        = useState<UserProfile | null>(null);
  const [profileFetched, setProfileFetched] = useState(false);
  const [profileSaving,  setProfileSaving]  = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [isAccountOpen,  setIsAccountOpen]  = useState(false);
  const [isWaterOpen,    setIsWaterOpen]    = useState(false);
  const [homeWaterOz,    setHomeWaterOz]    = useState<number>(0);
  const [homeWaterGoalOz,setHomeWaterGoalOz]= useState<number>(64);
  const [isWeightOpen,   setIsWeightOpen]   = useState(false);
  const [homeWeightKg,   setHomeWeightKg]   = useState<number | null>(null);
  const [setupFields,    setSetupFields]    = useState<SetupFields>({
    display_name:   "",
    sex:            "",
    age:            "",
    height_cm:      "",
    weight_kg:      "",
    goal_type:      "maintain",
    activity_level: "moderate",
  });

  // Fetch the water summary shown on the homepage widget (goal + today's total).
  // Intentionally separate from WaterIntakeScreen's own fetch so the homepage
  // stays current without mounting the full water screen.
  const fetchHomeWaterSummary = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const [{ data: prefs }, { data: log }] = await Promise.all([
        supabase
          .from("hydration_preferences")
          .select("daily_goal_oz")
          .eq("user_id", user.id)
          .single(),
        supabase
          .from("hydration_daily_logs")
          .select("total_oz")
          .eq("user_id", user.id)
          .eq("log_date", localToday())
          .single(),
      ]);

      if (prefs?.daily_goal_oz != null) setHomeWaterGoalOz(prefs.daily_goal_oz);
      setHomeWaterOz(log?.total_oz ?? 0);
    } catch {
      // silently ignore — widget keeps last known values
    }
  };

  const fetchHomeWeightSummary = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("weight_logs")
        .select("weight_kg")
        .eq("user_id", user.id)
        .order("log_date", { ascending: false })
        .limit(1)
        .single();
      setHomeWeightKg(data?.weight_kg ?? null);
    } catch {
      // silently ignore — widget keeps last known value
    }
  };

  // Solar Bloom breathing glow — loops indefinitely from mount.
  useEffect(() => {
    const breathe = (val: Animated.Value, duration: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(val, { toValue: 1, duration: duration / 2, useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: duration / 2, useNativeDriver: true }),
        ])
      );
    const anims = [
      breathe(glowOuter,   7000),
      breathe(glowMid,     5500),
      breathe(glowCore,    4000),
      breathe(glowShimmer, 6500),
    ];
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sidebar open/close animation.
  useEffect(() => {
    Animated.timing(sidebarAnim, {
      toValue: isSidebarOpen ? 1 : 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [isSidebarOpen]);

  // iOS keyboard listeners — lift the floating search bar above the keyboard.
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const show = Keyboard.addListener("keyboardWillShow", (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardHeight(0);
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Initialise session on mount and listen for auth changes.
  // onAuthStateChange fires INITIAL_SESSION immediately on subscription (Supabase v2),
  // so a separate getSession() call is not needed and would cause a duplicate setSession.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        // Recovery link was opened — show the new-password form.
        setAuthMode("reset");
        setAuthMessage("");
      } else {
        setSession(session);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Handle deep-link recovery URLs (lume://...).
  // Parses access_token + refresh_token from the URL fragment and hands
  // them to Supabase so onAuthStateChange fires PASSWORD_RECOVERY.
  useEffect(() => {
    const handleUrl = async ({ url }: { url: string }) => {
      if (!url) return;
      const fragment = url.split("#")[1] ?? url.split("?")[1] ?? "";
      const params = new URLSearchParams(fragment);
      const type = params.get("type");
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      if (type === "recovery" && accessToken && refreshToken) {
        await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      }
    };
    // App was cold-started from the link
    Linking.getInitialURL().then(url => { if (url) handleUrl({ url }); });
    // App was already open when the link was tapped
    const sub = Linking.addEventListener("url", handleUrl);
    return () => sub.remove();
  }, []);

  // Always fetches a fresh (auto-refreshed) token from Supabase rather than
  // reading the potentially-expired token stored in React state.
  const getAuthHeaders = async () => {
    const { data: { session: freshSession } } = await supabase.auth.getSession();
    if (!freshSession?.access_token) {
      throw new Error("No active session");
    }
    return {
      Authorization: `Bearer ${freshSession.access_token}`,
    };
  };
  const signUp = async () => {
    setAuthMessage("");
    const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword });
    setAuthMessage(error ? error.message : "Check your email to confirm your account.");
  };

  const logIn = async () => {
    setAuthMessage("");
    const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
    if (error) setAuthMessage(error.message);
  };

  const logOut = async () => {
    await supabase.auth.signOut();
  };

  const saveProfile = async () => {
    if (!setupFields.sex) {
      setProfileMessage("Please select your sex.");
      return;
    }
    if (!setupFields.age || isNaN(Number(setupFields.age))) {
      setProfileMessage("Please enter a valid age.");
      return;
    }
    if (!setupFields.height_cm || isNaN(Number(setupFields.height_cm))) {
      setProfileMessage("Please enter a valid height.");
      return;
    }
    if (!setupFields.weight_kg || isNaN(Number(setupFields.weight_kg))) {
      setProfileMessage("Please enter a valid weight.");
      return;
    }
    setProfileSaving(true);
    setProfileMessage("");
    try {
      const res = await axios.put(
        `${API_URL}/profile`,
        {
          display_name:         setupFields.display_name.trim() || null,
          sex:                  setupFields.sex,
          age:                  parseInt(setupFields.age, 10),
          height_cm:            parseFloat(setupFields.height_cm),
          weight_kg:            parseFloat(setupFields.weight_kg),
          goal_type:            setupFields.goal_type,
          activity_level:       setupFields.activity_level,
          onboarding_completed: true,
        },
        { headers: await getAuthHeaders() },
      );
      // Updating profile state causes the render to skip the setup gate
      // and enter the tracker — no navigation needed.
      setProfile(res.data.profile as UserProfile);
      setProfileMessage("Profile saved.");
    } catch (err: unknown) {
      // Log the real server response so any remaining issues are immediately visible.
      const axErr = err as { response?: { status?: number; data?: unknown } };
      console.error(
        "[saveProfile] failed — status:", axErr?.response?.status,
        "| body:", axErr?.response?.data ?? err,
      );
      setProfileMessage("Failed to save profile. Please try again.");
    } finally {
      setProfileSaving(false);
    }
  };

  const sendResetEmail = async () => {
    if (!resetEmail.trim()) {
      setAuthMessage("Please enter your email address.");
      return;
    }
    setAuthMessage("");
    const { error } = await supabase.auth.resetPasswordForEmail(resetEmail.trim(), {
      redirectTo: "https://lume-reset.vercel.app/reset-password",
    });
    setAuthMessage(
      error
        ? error.message
        : "Check your email — a reset link is on its way."
    );
  };

  const updatePassword = async () => {
    if (resetPassword.length < 6) {
      setAuthMessage("Password must be at least 6 characters.");
      return;
    }
    if (resetPasswordConfirm && resetPassword !== resetPasswordConfirm) {
      setAuthMessage("Passwords don't match.");
      return;
    }
    setAuthMessage("");
    const { error } = await supabase.auth.updateUser({ password: resetPassword });
    if (error) {
      setAuthMessage(error.message);
    } else {
      setResetPassword("");
      setResetPasswordConfirm("");
      setAuthMode("login");
      setAuthMessage("Password updated — you can now log in.");
    }
  };

  // Triggered by the keyboard Return/Search key.
  // Searches and, on a valid result, immediately logs it and clears the input
  // so the user can quickly move on to the next item.
  const searchAndLog = async () => {
    if (!query.trim()) return;
    setLogMessage("");
    const { foodQuery, parsedServings } = _parseQuery(query);
    setSearching(true);

    let food: NutritionResult | null = null;
    try {
      const res = await axios.post(`${API_URL}/food/search`, { query: foodQuery });
      food = res.data as NutritionResult;
    } catch {
      setLogMessage("Failed to search");
      setSearching(false);
      return;
    }
    setSearching(false);

    if (!food) return;
    try {
      await axios.post(
        `${API_URL}/logs`,
        {
          name:     food.name,
          calories: food.calories * parsedServings,
          protein:  food.protein  * parsedServings,
          carbs:    food.carbs    * parsedServings,
          fat:      food.fat      * parsedServings,
          log_date: selectedDate,
          // Persist nutrition-source metadata so badges survive app reloads.
          source_type:         food.source_type         ?? null,
          confidence:          food.confidence          ?? null,
          is_estimated:        food.is_estimated        ?? null,
          serving_description: food.serving_description ?? null,
        },
        { headers: await getAuthHeaders() },
      );
      setQuery("");      // clear input for next item
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const _meta = {
        source_type:         food.source_type,
        confidence:          food.confidence,
        is_estimated:        food.is_estimated,
        serving_description: food.serving_description,
      };
      const shortLabel   = getSourceShortLabel(_meta);
      const providerName = getProviderName(_meta);
      const servingHint  = food.serving_description?.trim() || null;
      // e.g. "Food logged · USDA · 118 g serving"  or  "Food logged · Open Food Facts · 43 g"
      const msgParts = ["Food logged", providerName ?? shortLabel, servingHint].filter(Boolean);
      setLogMessage(msgParts.join(" · "));
      await loadSummary();
      await loadLogs();
      await loadWeekly();
      await loadTodayCalories();
    } catch {
      setLogMessage("Failed to log food");
    }
  };

  const loadSummary = async (date = selectedDate) => {
    if (!session?.access_token) return;
    setSummaryLoading(true);
    try {
      const res = await axios.get(`${API_URL}/dashboard/daily?date=${date}`, {
        headers: await getAuthHeaders(),
      });
      setSummary(res.data);
    } catch (err) {
      setLogMessage("Failed to load summary");
    } finally {
      setSummaryLoading(false);
    }
  };

  // Always fetches today's total regardless of the selected viewing date,
  // so the badge reflects live progress even when browsing other days.
  const loadTodayCalories = async () => {
    if (!session?.access_token) return;
    try {
      const res = await axios.get(`${API_URL}/dashboard/daily?date=${localToday()}`, {
        headers: await getAuthHeaders(),
      });
      setTodayCalories(res.data.total_calories ?? 0);
    } catch {
      // silently fail — badge shows stale value until next successful fetch
    }
  };

  const deleteLog = async (id: number) => {
    setDeletingLogId(id);
    try {
      await axios.delete(`${API_URL}/logs/${id}`, {
        headers: await getAuthHeaders(),
      });
      await loadSummary();
      await loadLogs();
      await loadWeekly();
      await loadTodayCalories();
    } catch (err) {
      setLogMessage("Failed to delete entry");
    } finally {
      setDeletingLogId(null);
    }
  };

  const saveEdit = async (id: number) => {
    setSavingEdit(true);
    try {
      await axios.patch(
        `${API_URL}/logs/${id}`,
        {
          name:     editFields.name     || undefined,
          calories: editFields.calories ? parseFloat(editFields.calories) : undefined,
          protein:  editFields.protein  ? parseFloat(editFields.protein)  : undefined,
          carbs:    editFields.carbs    ? parseFloat(editFields.carbs)    : undefined,
          fat:      editFields.fat      ? parseFloat(editFields.fat)      : undefined,
        },
        { headers: await getAuthHeaders() },
      );
      setEditingLogId(null);
      await loadSummary();
      await loadLogs();
      await loadWeekly();
      await loadTodayCalories();
    } catch (err) {
      setLogMessage("Failed to update entry");
    } finally {
      setSavingEdit(false);
    }
  };

  const loadLogs = async (date = selectedDate) => {
    if (!session?.access_token) return;
    setLogsLoading(true);
    try {
      const res = await axios.get(`${API_URL}/logs?date=${date}`, {
        headers: await getAuthHeaders(),
      });
      setLogs(res.data.logs);
    } catch (err) {
      setLogMessage("Failed to load entries");
    } finally {
      setLogsLoading(false);
    }
  };

  const loadWeekly = async () => {
    if (!session?.access_token) return;
    setWeeklyLoading(true);
    try {
      const res = await axios.get(`${API_URL}/dashboard/weekly`, {
        headers: await getAuthHeaders(),
      });
      setWeeklyData(res.data);
    } catch (err) {
      console.log("Error loading weekly data");
    } finally {
      setWeeklyLoading(false);
    }
  };

  const handleDateChange = (_event: unknown, date?: Date) => {
    setShowDatePicker(false); // close picker on iOS after selection
    if (!date) return;
    setSelectedDate(formatDateToLocalYYYYMMDD(date));
  };

  const openDatePicker = () => {
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: parseDateStringToLocalDate(selectedDate),
        onChange: handleDateChange,
        mode: "date",
      });
    } else {
      setShowDatePicker(prev => !prev);
    }
  };

  const onRefresh = async () => {
    if (!session?.access_token) return;
    setRefreshing(true);
    try {
      await Promise.all([
        loadLogs(selectedDate),
        loadSummary(selectedDate),
        loadWeekly(),
        loadTodayCalories(),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  // Reload logs + summary whenever selectedDate OR session changes.
  // session is included so the effect re-runs (with a current, non-stale closure)
  // as soon as a valid token arrives — no request is made until then.
  useEffect(() => {
    if (!session?.access_token || !isValidDate(selectedDate)) return;
    setShowAllLogs(false);   // collapse when switching dates or on first load
    loadLogs(selectedDate);
    loadSummary(selectedDate);
  }, [selectedDate, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear stale state on logout; load weekly data on login / user switch.
  // Logs + summary are handled by the selectedDate effect above.
  useEffect(() => {
    if (!session?.access_token) {
      // Wipe every piece of user-specific state so the next user starts clean
      setLogs([]);
      setSummary(null);
      setWeeklyData([]);
      setTodayCalories(null);
      setLogMessage("");
      setQuery("");
      // Clear profile so a subsequent login fetches fresh data.
      setProfile(null);
      setProfileFetched(false);
      setProfileMessage("");
      setHomeWaterOz(0);
      setHomeWaterGoalOz(64);
      setHomeWeightKg(null);
    } else {
      loadWeekly();
      loadTodayCalories();
      fetchHomeWaterSummary();
      fetchHomeWeightSummary();
    }
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the user's profile whenever a valid session arrives.
  // profileFetched is set to false before the request and true once it settles,
  // which drives the loading → setup/tracker decision in the render below.
  useEffect(() => {
    if (!session?.access_token) return;
    setProfileFetched(false);
    (async () => {
      try {
        const res = await axios.get(`${API_URL}/profile`, {
          headers: await getAuthHeaders(),
        });
        const p = res.data.profile as UserProfile | null;
        setProfile(p);
        // Pre-fill the setup form with any values already stored.
        if (p) {
          setSetupFields({
            display_name:   p.display_name   ?? "",
            sex:            p.sex            ?? "",
            age:            p.age            != null ? String(p.age)       : "",
            height_cm:      p.height_cm      != null ? String(p.height_cm) : "",
            weight_kg:      p.weight_kg      != null ? String(p.weight_kg) : "",
            goal_type:      p.goal_type      ?? "maintain",
            activity_level: p.activity_level ?? "moderate",
          });
        }
      } catch {
        // Treat a failed fetch the same as no profile — show setup.
        setProfile(null);
      } finally {
        setProfileFetched(true);
      }
    })();
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh the homepage water widget whenever the water screen is dismissed.
  useEffect(() => {
    if (!isWaterOpen && session?.access_token) fetchHomeWaterSummary();
  }, [isWaterOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh the homepage weight widget whenever the weight screen is dismissed.
  useEffect(() => {
    if (!isWeightOpen && session?.access_token) fetchHomeWeightSummary();
  }, [isWeightOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a barcode is scanned, look it up and immediately auto-log it —
  // same pattern as searchAndLog so there is one consistent logging path.
  useEffect(() => {
    if (!scannedBarcode) return;
    const barcode = scannedBarcode;
    setLogMessage("");
    setScanningLabel("Looking up barcode...");
    setSearching(true);

    (async () => {
      try {
        const res  = await axios.post(`${API_URL}/food/barcode`, { barcode });
        const food = res.data as NutritionResult;
        try {
          await axios.post(
            `${API_URL}/logs`,
            {
              name:     food.name,
              calories: food.calories,
              protein:  food.protein,
              carbs:    food.carbs,
              fat:      food.fat,
              log_date: selectedDate,
              source_type:         food.source_type         ?? null,
              confidence:          food.confidence          ?? null,
              is_estimated:        food.is_estimated        ?? null,
              serving_description: food.serving_description ?? null,
            },
            { headers: await getAuthHeaders() },
          );
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setLogMessage(`Logged: ${food.name}`);
          await loadSummary();
          await loadLogs();
          await loadWeekly();
          await loadTodayCalories();
        } catch {
          setLogMessage("Failed to save — please try again.");
        }
      } catch (err: unknown) {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          if (status === 404) {
            setLogMessage("Product not found — try searching by name.");
          } else if (status === 400) {
            setLogMessage("Could not read barcode — try again.");
          } else if (status === 502) {
            setLogMessage("Barcode service unavailable — try again later.");
          } else if (!err.response) {
            setLogMessage("No connection — check your network.");
          } else {
            setLogMessage("Barcode lookup failed — try searching by name.");
          }
        } else {
          setLogMessage("Barcode lookup failed — try searching by name.");
        }
      } finally {
        setScannedBarcode(null);
        setScanningLabel("Searching...");
        setSearching(false);
      }
    })();
  }, [scannedBarcode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wait for custom fonts before rendering anything
  if (!fontsLoaded) return null;

  // ── Auth screen — Solar Bloom design ──────────────────────────────────────
  if (!session || authMode === "reset") {

    // ── Mode: set new password (arrived via reset link) ──
    if (authMode === "reset") {
      return (
        <AuthShell glowOuter={glowOuter} glowMid={glowMid} glowCore={glowCore} glowShimmer={glowShimmer}>
          <View style={styles.authContainer}>
            <View style={styles.authLogoArea}>
              <Text style={styles.authWordmark}>Lume</Text>
              <Text style={styles.authTagline}>Set a new password.</Text>
            </View>
            <View style={styles.authForm}>
              <TextInput
                style={styles.authInput}
                placeholder="New password"
                placeholderTextColor="rgba(26,26,20,0.4)"
                value={resetPassword}
                onChangeText={setResetPassword}
                secureTextEntry
                autoFocus
              />
              <TextInput
                style={styles.authInput}
                placeholder="Confirm new password"
                placeholderTextColor="rgba(26,26,20,0.4)"
                value={resetPasswordConfirm}
                onChangeText={setResetPasswordConfirm}
                secureTextEntry
              />
              <TouchableOpacity style={styles.authSignInButton} onPress={updatePassword} activeOpacity={0.85}>
                <Text style={styles.authSignInText}>Update password</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.authBackLink} onPress={() => { setResetPassword(""); setResetPasswordConfirm(""); setAuthMode("login"); setAuthMessage(""); }}>
                <Text style={styles.authBackLinkText}>← Back to login</Text>
              </TouchableOpacity>
              {authMessage ? <Text style={styles.authMessage}>{authMessage}</Text> : null}
            </View>
          </View>
        </AuthShell>
      );
    }

    // ── Mode: forgot password (enter email to receive reset link) ──
    if (authMode === "forgot") {
      return (
        <AuthShell glowOuter={glowOuter} glowMid={glowMid} glowCore={glowCore} glowShimmer={glowShimmer}>
          <View style={styles.authContainer}>
            <View style={styles.authLogoArea}>
              <Text style={styles.authWordmark}>Lume</Text>
              <Text style={styles.authTagline}>We'll send a reset link to your email.</Text>
            </View>
            <View style={styles.authForm}>
              <TextInput
                style={styles.authInput}
                placeholder="Email"
                placeholderTextColor="rgba(26,26,20,0.4)"
                value={resetEmail}
                onChangeText={setResetEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                autoFocus
              />
              <TouchableOpacity style={styles.authSignInButton} onPress={sendResetEmail} activeOpacity={0.85}>
                <Text style={styles.authSignInText}>Send reset link</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.authBackLink} onPress={() => { setAuthMode("login"); setAuthMessage(""); }}>
                <Text style={styles.authBackLinkText}>← Back to login</Text>
              </TouchableOpacity>
              {authMessage ? <Text style={styles.authMessage}>{authMessage}</Text> : null}
            </View>
          </View>
        </AuthShell>
      );
    }

    // ── Mode: login (default) ──
    return (
      <AuthShell glowOuter={glowOuter} glowMid={glowMid} glowCore={glowCore} glowShimmer={glowShimmer}>
        <View style={styles.authContainer}>
          <View style={styles.authLogoArea}>
            <Text style={styles.authWordmark}>Lume</Text>
            <Text style={styles.authTagline}>Illuminate what you eat.</Text>
          </View>
          <View style={styles.authForm}>
            <TextInput
              style={styles.authInput}
              placeholder="Email"
              placeholderTextColor="rgba(26,26,20,0.4)"
              value={authEmail}
              onChangeText={setAuthEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TextInput
              style={styles.authInput}
              placeholder="Password"
              placeholderTextColor="rgba(26,26,20,0.4)"
              value={authPassword}
              onChangeText={setAuthPassword}
              secureTextEntry
            />

            <TouchableOpacity style={styles.authSignInButton} onPress={logIn} activeOpacity={0.85}>
              <Text style={styles.authSignInText}>Log In</Text>
            </TouchableOpacity>

            {/* Forgot password link */}
            <TouchableOpacity
              style={styles.authBackLink}
              onPress={() => { setAuthMode("forgot"); setResetEmail(authEmail); setAuthMessage(""); }}
            >
              <Text style={styles.authForgotText}>Forgot password?</Text>
            </TouchableOpacity>

            <View style={styles.authDivider}>
              <View style={styles.authDividerLine} />
              <Text style={styles.authDividerText}>or</Text>
              <View style={styles.authDividerLine} />
            </View>

            <TouchableOpacity style={styles.authSignUpButton} onPress={signUp} activeOpacity={0.85}>
              <Text style={styles.authSignUpText}>Create account</Text>
            </TouchableOpacity>

            {authMessage ? <Text style={styles.authMessage}>{authMessage}</Text> : null}
          </View>
        </View>
      </AuthShell>
    );
  }

  // ── Profile loading — wait for GET /profile to settle ───────────────────────
  // Shown briefly after login while the profile fetch is in-flight.
  if (!profileFetched) {
    return (
      <SafeAreaView style={styles.profileLoadingSafe}>
        <Text style={styles.profileLoadingText}>Loading…</Text>
      </SafeAreaView>
    );
  }

  // ── Profile setup — new user or incomplete onboarding ────────────────────────
  if (!profile || !profile.onboarding_completed) {
    return (
      <ProfileSetupScreen
        fields={setupFields}
        onChange={(field, value) =>
          setSetupFields(prev => ({ ...prev, [field]: value }))
        }
        onSave={saveProfile}
        saving={profileSaving}
        message={profileMessage}
      />
    );
  }

  // ── Account screen ───────────────────────────────────────────────────────────
  if (isAccountOpen) {
    return (
      <AccountScreen
        profile={profile}
        fields={setupFields}
        onChange={(field, value) =>
          setSetupFields(prev => ({ ...prev, [field]: value }))
        }
        onSave={saveProfile}
        onBack={() => { setIsAccountOpen(false); setProfileMessage(""); }}
        onLogOut={() => { setIsAccountOpen(false); logOut(); }}
        saving={profileSaving}
        message={profileMessage}
      />
    );
  }

  // ── Water Intake screen ──────────────────────────────────────────────────────
  if (isWaterOpen) {
    return <WaterIntakeScreen onBack={() => setIsWaterOpen(false)} />;
  }

  // ── Weight screen ────────────────────────────────────────────────────────────
  if (isWeightOpen) {
    return <WeightScreen onBack={() => setIsWeightOpen(false)} />;
  }

  // ── Tracker screen (logged in) ──────────────────────────────────────────────
  // profile is guaranteed non-null here (the setup gate above would have caught it).
  const calorieGoal = profile ? computeCalorieTarget(profile) : CALORIE_GOAL;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.primary}
            colors={[COLORS.primary]}
          />
        }
      >

        {/* Header */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => setIsSidebarOpen(true)} activeOpacity={0.8}>
            <Image
              source={require("./assets/Lume.png")}
              style={styles.logo}
              resizeMode="contain"
            />
          </TouchableOpacity>
        </View>

        {/* Date selector */}
        <View style={styles.dateSection}>
          <Text style={styles.sectionLabel}>VIEWING DATE</Text>
          <TouchableOpacity style={styles.dateTrigger} onPress={openDatePicker}>
            <View style={styles.dateTriggerUnderline}>
              <Text style={styles.dateTriggerText}>{formatDateLabel(selectedDate)}</Text>
            </View>
            <Text style={styles.dateTriggerIcon}>▾</Text>
          </TouchableOpacity>
          {showDatePicker && Platform.OS === "ios" && (
            <DateTimePicker
              value={parseDateStringToLocalDate(selectedDate)}
              mode="date"
              display="inline"
              onChange={handleDateChange}
              accentColor={COLORS.primary}
              style={styles.datePicker}
            />
          )}
        </View>

        {/* Barcode Scanner Modal */}
        <Modal
          visible={isScannerOpen}
          animationType="slide"
          onRequestClose={() => setIsScannerOpen(false)}
        >
          <View style={styles.scannerContainer}>
            {!cameraPermission?.granted ? (
              <View style={styles.scannerPermissionBox}>
                <Text style={styles.scannerPermissionText}>
                  Camera access is required to scan barcodes.
                </Text>
                {cameraPermission?.canAskAgain !== false ? (
                  <Button title="Grant Permission" onPress={requestCameraPermission} />
                ) : (
                  <TouchableOpacity
                    onPress={() => Linking.openSettings()}
                    style={styles.scannerSettingsLink}
                  >
                    <Text style={styles.scannerSettingsLinkText}>
                      Open Settings to enable camera
                    </Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() => setIsScannerOpen(false)}
                  style={[styles.scannerCancelButton, { marginTop: 12 }]}
                >
                  <Text style={styles.scannerCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <CameraView
                  style={styles.scannerCamera}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e"] }}
                  onBarcodeScanned={({ data }) => {
                    if (scanLockRef.current) return;
                    scanLockRef.current = true;
                    setScannedBarcode(data);
                    setIsScannerOpen(false);
                    // reset lock after modal closes so scanner can be reused
                    setTimeout(() => { scanLockRef.current = false; }, 1000);
                  }}
                />
                <View style={styles.scannerOverlay}>
                  <View style={styles.scannerReticle} />
                  <Text style={styles.scannerHint}>Point at a barcode</Text>
                </View>
                <View style={styles.scannerActions}>
                  <TouchableOpacity
                    onPress={() => setIsScannerOpen(false)}
                    style={styles.scannerCancelButton}
                  >
                    <Text style={styles.scannerCancelText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </Modal>


        {/* Daily Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>DAILY SUMMARY</Text>
          {summaryLoading && <Text style={styles.searchingText}>Loading summary...</Text>}
          {!summaryLoading && summary && (
            <TotalsRadialRings summary={summary} selectedDate={selectedDate} goal={calorieGoal} />
          )}

          {/* Water + Weight compact strip */}
          <View style={styles.dailyStatStrip}>
            <TouchableOpacity style={styles.dailyStatHalf} onPress={() => setIsWaterOpen(true)} activeOpacity={0.8}>
              <Ionicons name="water-outline" size={16} color="#1A1A14" />
              <View style={styles.dailyStatContent}>
                <View style={styles.dailyStatTopRow}>
                  <Text style={styles.dailyStatLabel}>Water</Text>
                  <Text style={styles.dailyStatPct}>
                    {Math.min(100, Math.round((homeWaterOz / Math.max(homeWaterGoalOz, 1)) * 100))}%
                  </Text>
                </View>
                <Text style={styles.dailyStatValue}>
                  {homeWaterOz}{" "}
                  <Text style={styles.dailyStatUnit}>/ {homeWaterGoalOz} oz</Text>
                </Text>
                <View style={styles.dailyStatBar}>
                  <View style={[
                    styles.dailyStatBarFill,
                    homeWaterOz >= homeWaterGoalOz && styles.dailyStatBarFillMet,
                    { width: `${Math.min(100, Math.round((homeWaterOz / Math.max(homeWaterGoalOz, 1)) * 100))}%` as any },
                  ]} />
                </View>
              </View>
            </TouchableOpacity>
            <View style={styles.dailyStatSep} />
            <TouchableOpacity style={styles.dailyStatHalf} onPress={() => setIsWeightOpen(true)} activeOpacity={0.8}>
              <Ionicons name="trending-up-outline" size={16} color="#1A1A14" />
              <View style={styles.dailyStatContent}>
                <Text style={styles.dailyStatLabel}>Weight</Text>
                {homeWeightKg != null ? (
                  <Text style={styles.dailyStatValue}>
                    {homeWeightKg}{" "}
                    <Text style={styles.dailyStatUnit}>kg</Text>
                  </Text>
                ) : (
                  <Text style={styles.dailyStatEmpty}>Tap to log</Text>
                )}
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Logged Foods */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>LOGGED FOODS</Text>
          {logsLoading && <Text style={styles.searchingText}>Loading logs...</Text>}
          {!logsLoading && logs.length === 0 && (
            <Text style={styles.emptyState}>No food logged yet — let's get your first one in</Text>
          )}
          {!logsLoading && (showAllLogs ? logs : logs.slice(0, 1)).map((entry) => (
            <SwipeableRow
              key={entry.id}
              onDelete={() => deleteLog(entry.id)}
              disabled={editingLogId === entry.id}
            >
            <View style={styles.logEntry}>
              {editingLogId === entry.id ? (
                /* ── Inline edit form ── */
                <View>
                  <TextInput
                    style={styles.editInput}
                    value={editFields.name}
                    onChangeText={(v) => setEditFields(f => ({ ...f, name: v }))}
                    placeholder="Name"
                    placeholderTextColor="#aaa"
                    autoCapitalize="none"
                  />
                  <View style={styles.editMacroRow}>
                    <View style={styles.editMacroField}>
                      <Text style={styles.editMacroLabel}>Calories</Text>
                      <TextInput
                        style={[styles.editInput, styles.editMacroInput]}
                        value={editFields.calories}
                        onChangeText={(v) => setEditFields(f => ({ ...f, calories: v }))}
                        placeholder="kcal"
                        placeholderTextColor="#aaa"
                        keyboardType="numeric"
                      />
                    </View>
                    <View style={styles.editMacroField}>
                      <Text style={styles.editMacroLabel}>Protein</Text>
                      <TextInput
                        style={[styles.editInput, styles.editMacroInput]}
                        value={editFields.protein}
                        onChangeText={(v) => setEditFields(f => ({ ...f, protein: v }))}
                        placeholder="g"
                        placeholderTextColor="#aaa"
                        keyboardType="numeric"
                      />
                    </View>
                    <View style={styles.editMacroField}>
                      <Text style={styles.editMacroLabel}>Carbs</Text>
                      <TextInput
                        style={[styles.editInput, styles.editMacroInput]}
                        value={editFields.carbs}
                        onChangeText={(v) => setEditFields(f => ({ ...f, carbs: v }))}
                        placeholder="g"
                        placeholderTextColor="#aaa"
                        keyboardType="numeric"
                      />
                    </View>
                    <View style={styles.editMacroField}>
                      <Text style={styles.editMacroLabel}>Fat</Text>
                      <TextInput
                        style={[styles.editInput, styles.editMacroInput]}
                        value={editFields.fat}
                        onChangeText={(v) => setEditFields(f => ({ ...f, fat: v }))}
                        placeholder="g"
                        placeholderTextColor="#aaa"
                        keyboardType="numeric"
                      />
                    </View>
                  </View>
                  <View style={styles.editActions}>
                    <TouchableOpacity
                      style={styles.editSaveButton}
                      onPress={() => saveEdit(entry.id)}
                      disabled={savingEdit}
                    >
                      <Text style={styles.editSaveText}>{savingEdit ? "Saving..." : "Save"}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.editCancelButton}
                      onPress={() => setEditingLogId(null)}
                      disabled={savingEdit}
                    >
                      <Text style={styles.editCancelText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                /* ── Normal view ── */
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => setExpandedLogIds(prev => {
                    const next = new Set(prev);
                    next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id);
                    return next;
                  })}
                >
                <View style={styles.logEntryRow}>
                  <View style={styles.logEntryText}>
                    <View style={[
                      styles.logEntryNameWrapper,
                      expandedLogIds.has(entry.id) && styles.logEntryNameWrapperActive,
                    ]}>
                      <Text style={styles.logEntryName}>{entry.name}</Text>
                    </View>
                    {expandedLogIds.has(entry.id) && (
                      <>
                        <Text style={styles.logEntryMacros}>
                          {entry.calories} kcal · {entry.protein}g protein · {entry.carbs}g carbs · {entry.fat}g fat
                        </Text>
                        <SourceBadgeRow meta={entry} />
                      </>
                    )}
                    <Text style={styles.logEntryTime}>
                      {new Date(entry.created_at + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </View>
                  <View style={styles.logEntryActions}>
                    <TouchableOpacity
                      onPress={() => {
                        setEditingLogId(entry.id);
                        setEditFields({
                          name:     entry.name,
                          calories: String(entry.calories),
                          protein:  String(entry.protein),
                          carbs:    String(entry.carbs),
                          fat:      String(entry.fat),
                        });
                      }}
                    >
                      <Ionicons name="create-outline" size={19} color={COLORS.primary} />
                    </TouchableOpacity>
                  </View>
                </View>
                </TouchableOpacity>
              )}
            </View>
            </SwipeableRow>
          ))}
          {!logsLoading && logs.length > 1 && (
            <TouchableOpacity
              onPress={() => setShowAllLogs(v => !v)}
              style={styles.logsToggle}
            >
              <Ionicons
                name={showAllLogs ? "chevron-up" : "chevron-down"}
                size={22}
                color={COLORS.primary}
              />
            </TouchableOpacity>
          )}
        </View>

        {/* Weekly Analytics */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>LAST 7 DAYS</Text>
          {weeklyLoading && weeklyData.length === 0 && (
            <Text style={styles.searchingText}>Loading...</Text>
          )}
          {weeklyData.length > 0 && <WeeklyGlowLine data={weeklyData} goal={calorieGoal} />}
        </View>


      </ScrollView>

      {/* Today's calorie badge — absolutely positioned so it stays fixed
          while the ScrollView content scrolls beneath it.
          top: 20 / right: 20 matches the container padding so it sits flush
          with the right margin, vertically level with the header row.
          pointerEvents="none" keeps it non-interactive. */}
      {todayCalories !== null && (
        <View style={styles.calorieBadge} pointerEvents="none">
          <Text style={styles.calorieBadgeText}>
            {`${Math.round(todayCalories)} Cals`}
          </Text>
        </View>
      )}

      {/* Floating bottom search bar — absolutely positioned so it overlays
          the scroll content with no background panel beneath it.
          paddingBottom uses the device's bottom safe-area inset so the input
          clears the home indicator on all devices. */}
      {/* bottom: when keyboard is open, subtract insets.bottom because keyboardHeight
          is measured from the screen edge while bottomBar is positioned inside the
          SafeAreaView whose layout origin is already above the home-indicator inset.
          Without this correction the bar overshoots upward by ~34pt on Face ID devices. */}
      <View style={[styles.bottomBar, { bottom: keyboardHeight > 0 ? keyboardHeight - insets.bottom : 0, paddingBottom: keyboardHeight > 0 ? 8 : (insets.bottom || 8) }]}>
        <View style={[styles.inputRow, isSearchFocused && styles.inputRowFocused]}>
          <TextInput
            placeholder="e.g. banana, grilled chicken..."
            placeholderTextColor="#aaa"
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={searchAndLog}
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => setIsSearchFocused(false)}
            returnKeyType="search"
            autoCapitalize="none"
            style={styles.input}
          />
          <TouchableOpacity
            style={styles.scanButton}
            onPress={async () => {
              if (!cameraPermission?.granted) {
                await requestCameraPermission();
              }
              setIsScannerOpen(true);
            }}
          >
            <Image source={barcodIcon} style={styles.scanButtonIcon} />
          </TouchableOpacity>
        </View>
        {searching && <Text style={styles.searchingText}>{scanningLabel}</Text>}
        {!searching && logMessage ? (
          <Text style={logMessage.startsWith("Logged") || logMessage.startsWith("Food logged") ? styles.success : styles.error}>
            {logMessage}
          </Text>
        ) : null}
      </View>

      {/* Sidebar backdrop — fades in/out; tapping closes the drawer */}
      <Animated.View
        pointerEvents={isSidebarOpen ? "auto" : "none"}
        style={[styles.sidebarBackdrop, { opacity: sidebarAnim }]}
      >
        <TouchableOpacity
          style={StyleSheet.absoluteFillObject}
          activeOpacity={1}
          onPress={() => setIsSidebarOpen(false)}
        />
      </Animated.View>

      {/* Left sidebar drawer — slides in/out from the left */}
      <Animated.View
        style={[
          styles.sidebar,
          { transform: [{ translateX: sidebarAnim.interpolate({ inputRange: [0, 1], outputRange: [-220, 0] }) }] },
        ]}
        pointerEvents={isSidebarOpen ? "auto" : "none"}
      >
        <Text style={styles.sidebarTitle}>Lume</Text>
        <View style={styles.sidebarDivider} />

        {/* Account — syncs edit buffer from current profile before opening */}
        <TouchableOpacity
          style={{ marginBottom: 16 }}
          activeOpacity={0.7}
          onPress={() => {
            if (profile) {
              setSetupFields({
                display_name:   profile.display_name   ?? "",
                sex:            profile.sex            ?? "",
                age:            profile.age            != null ? String(profile.age)       : "",
                height_cm:      profile.height_cm      != null ? String(profile.height_cm) : "",
                weight_kg:      profile.weight_kg      != null ? String(profile.weight_kg) : "",
                goal_type:      profile.goal_type      ?? "maintain",
                activity_level: profile.activity_level ?? "moderate",
              });
            }
            setProfileMessage("");
            setIsSidebarOpen(false);
            setIsAccountOpen(true);
          }}
        >
          <Text style={styles.sidebarItem}>Account</Text>
        </TouchableOpacity>

        <View style={styles.sidebarDivider} />

        <TouchableOpacity onPress={() => { setIsSidebarOpen(false); logOut(); }}>
          <View style={styles.sidebarLogOutWrapper}>
            <Text style={styles.sidebarLogOut}>Log out</Text>
          </View>
        </TouchableOpacity>
      </Animated.View>

    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// AuthShell — stable Solar Bloom background wrapper for all auth screens.
// Defined at module level so React sees the same component type on every render
// of AppInner. An inline definition would create a new function reference each
// render, causing React to unmount + remount the SafeAreaView subtree on every
// keystroke, which dismisses and re-opens the keyboard (the glitch).
// ---------------------------------------------------------------------------
type AuthShellProps = {
  glowOuter:   Animated.Value;
  glowMid:     Animated.Value;
  glowCore:    Animated.Value;
  glowShimmer: Animated.Value;
  children:    React.ReactNode;
};

function AuthShell({ glowOuter, glowMid, glowCore, glowShimmer, children }: AuthShellProps) {
  return (
    <SafeAreaView style={styles.authSafe}>
      <LinearGradient
        colors={["#FFFBEC", "#FDF2D8", "#F7E7BD", "#E9D69A"]}
        locations={[0, 0.35, 0.65, 1]}
        style={StyleSheet.absoluteFillObject}
      />
      <Animated.View pointerEvents="none" style={[styles.authGlowOuter, {
        opacity: glowOuter.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
        transform: [{ scale: glowOuter.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }],
      }]} />
      <Animated.View pointerEvents="none" style={[styles.authGlowMid, {
        opacity: glowMid.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }),
        transform: [{ scale: glowMid.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) }],
      }]} />
      <Animated.View pointerEvents="none" style={[styles.authGlowCore, {
        opacity: glowCore.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }),
        transform: [{ scale: glowCore.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1.03] }) }],
      }]} />
      <Animated.View pointerEvents="none" style={[styles.authGlowShimmer, {
        opacity: glowShimmer.interpolate({ inputRange: [0, 1], outputRange: [0, 0.28] }),
      }]} />
      <View style={styles.authGroundWash} pointerEvents="none" />
      <View style={styles.authHorizon} pointerEvents="none" />
      {/* KeyboardAvoidingView pushes the form up when the soft keyboard appears.
          "padding" adds bottom padding equal to the keyboard height, which
          shrinks the flex container so the form stays visible at the bottom. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {children}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// SourceBadgeRow — shows a small pill badge for a food's source/confidence,
// plus serving context if available.  Renders nothing when there is no info.
// ---------------------------------------------------------------------------
function SourceBadgeRow({ meta }: { meta: FoodSourceMeta }) {
  const info     = getSourceBadgeInfo(meta);
  const provider = getProviderName(meta);
  const serving  = meta.serving_description?.trim() || null;

  // Build the subtitle: "Open Food Facts · 43 g serving"
  // If provider and serving are the same string, show only once.
  const metaParts = [provider, serving].filter(Boolean);
  const metaText  = metaParts.join(" · ") || null;

  if (!info && !metaText) return null;
  return (
    <View style={styles.sourceBadgeRow}>
      {info && (
        <View style={[styles.sourceBadge, { backgroundColor: info.bg }]}>
          <Text style={[styles.sourceBadgeText, { color: info.fg }]}>{info.label}</Text>
        </View>
      )}
      {metaText && (
        <Text style={styles.sourceMetaText} numberOfLines={1}>{metaText}</Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// OptionPills — reusable segmented-button row for enum profile fields.
// Module-level so its identity is stable across AppInner re-renders.
// ---------------------------------------------------------------------------
type OptionPillsProps = {
  options:  string[];
  labels:   string[];
  value:    string;
  onSelect: (val: string) => void;
};

function OptionPills({ options, labels, value, onSelect }: OptionPillsProps) {
  return (
    <View style={setupStyles.pillRow}>
      {options.map((opt, i) => (
        <TouchableOpacity
          key={opt}
          style={[setupStyles.pill, value === opt && setupStyles.pillSelected]}
          onPress={() => onSelect(opt)}
          activeOpacity={0.75}
        >
          <Text style={[setupStyles.pillText, value === opt && setupStyles.pillTextSelected]}>
            {labels[i]}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// ProfileSetupScreen — post-login interstitial shown when GET /profile returns
// null or onboarding_completed === false.  Submits to PUT /profile and sets
// onboarding_completed: true, which causes AppInner to render the tracker.
// ---------------------------------------------------------------------------
type ProfileSetupProps = {
  fields:   SetupFields;
  onChange: (field: keyof SetupFields, value: string) => void;
  onSave:   () => void;
  saving:   boolean;
  message:  string;
};

function ProfileSetupScreen({ fields, onChange, onSave, saving, message }: ProfileSetupProps) {
  return (
    <SafeAreaView style={setupStyles.safe}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          style={setupStyles.scroll}
          contentContainerStyle={setupStyles.container}
          keyboardShouldPersistTaps="handled"
        >

          {/* Header */}
          <Text style={setupStyles.wordmark}>Lume</Text>
          <Text style={setupStyles.headline}>Set up your profile</Text>
          <Text style={setupStyles.subhead}>
            This helps Lume calculate accurate calorie targets for you.
          </Text>

          {/* Display name */}
          <Text style={setupStyles.label}>Name (optional)</Text>
          <TextInput
            style={setupStyles.input}
            placeholder="What should we call you?"
            placeholderTextColor="#bbb"
            value={fields.display_name}
            onChangeText={v => onChange("display_name", v)}
            autoCapitalize="words"
          />

          {/* Sex */}
          <Text style={setupStyles.label}>Sex</Text>
          <OptionPills
            options={["male", "female", "other"]}
            labels={["Male", "Female", "Other"]}
            value={fields.sex}
            onSelect={v => onChange("sex", v)}
          />

          {/* Age */}
          <Text style={setupStyles.label}>Age</Text>
          <TextInput
            style={[setupStyles.input, setupStyles.inputShort]}
            placeholder="e.g. 28"
            placeholderTextColor="#bbb"
            value={fields.age}
            onChangeText={v => onChange("age", v.replace(/[^0-9]/g, ""))}
            keyboardType="number-pad"
          />

          {/* Height */}
          <Text style={setupStyles.label}>Height (cm)</Text>
          <TextInput
            style={[setupStyles.input, setupStyles.inputShort]}
            placeholder="e.g. 175"
            placeholderTextColor="#bbb"
            value={fields.height_cm}
            onChangeText={v => onChange("height_cm", v.replace(/[^0-9.]/g, ""))}
            keyboardType="decimal-pad"
          />

          {/* Weight */}
          <Text style={setupStyles.label}>Current weight (kg)</Text>
          <TextInput
            style={[setupStyles.input, setupStyles.inputShort]}
            placeholder="e.g. 72"
            placeholderTextColor="#bbb"
            value={fields.weight_kg}
            onChangeText={v => onChange("weight_kg", v.replace(/[^0-9.]/g, ""))}
            keyboardType="decimal-pad"
          />

          {/* Goal type */}
          <Text style={setupStyles.label}>Goal</Text>
          <OptionPills
            options={["lose", "maintain", "gain"]}
            labels={["Lose weight", "Maintain", "Gain weight"]}
            value={fields.goal_type}
            onSelect={v => onChange("goal_type", v)}
          />

          {/* Activity level */}
          <Text style={setupStyles.label}>Activity level</Text>
          <OptionPills
            options={["sedentary", "light", "moderate", "active", "very_active"]}
            labels={["Sedentary", "Light", "Moderate", "Active", "Very active"]}
            value={fields.activity_level}
            onSelect={v => onChange("activity_level", v)}
          />

          {/* Validation / error message */}
          {message ? <Text style={setupStyles.message}>{message}</Text> : null}

          {/* Submit */}
          <TouchableOpacity
            style={[setupStyles.saveButton, saving && setupStyles.saveButtonDisabled]}
            onPress={onSave}
            disabled={saving}
            activeOpacity={0.85}
          >
            <Text style={setupStyles.saveButtonText}>
              {saving ? "Saving…" : "Continue to Lume →"}
            </Text>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// AccountScreen — lets the logged-in user view/edit their profile and log out.
// Module-level for stable identity (same rule as AuthShell / ProfileSetupScreen).
// Reuses OptionPills, setupStyles, and the same SetupFields buffer as setup.
// ---------------------------------------------------------------------------
type AccountScreenProps = {
  profile:  UserProfile | null;
  fields:   SetupFields;
  onChange: (field: keyof SetupFields, value: string) => void;
  onSave:   () => void;
  onBack:   () => void;
  onLogOut: () => void;
  saving:   boolean;
  message:  string;
};

function AccountScreen({ profile, fields, onChange, onSave, onBack, onLogOut, saving, message }: AccountScreenProps) {
  const isSuccess = message === "Profile saved.";
  return (
    <SafeAreaView style={setupStyles.safe}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          style={setupStyles.scroll}
          contentContainerStyle={setupStyles.container}
          keyboardShouldPersistTaps="handled"
        >

          {/* Back navigation */}
          <TouchableOpacity onPress={onBack} style={setupStyles.acctBackButton} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={18} color="#555" />
            <Text style={setupStyles.acctBackText}>Back</Text>
          </TouchableOpacity>

          {/* Header */}
          <Text style={setupStyles.headline}>Account</Text>
          {profile?.display_name ? (
            <Text style={setupStyles.acctGreeting}>
              {profile.display_name}
            </Text>
          ) : null}

          {/* Display name */}
          <Text style={setupStyles.label}>Name (optional)</Text>
          <TextInput
            style={setupStyles.input}
            placeholder="What should we call you?"
            placeholderTextColor="#bbb"
            value={fields.display_name}
            onChangeText={v => onChange("display_name", v)}
            autoCapitalize="words"
          />

          {/* Sex */}
          <Text style={setupStyles.label}>Sex</Text>
          <OptionPills
            options={["male", "female", "other"]}
            labels={["Male", "Female", "Other"]}
            value={fields.sex}
            onSelect={v => onChange("sex", v)}
          />

          {/* Age */}
          <Text style={setupStyles.label}>Age</Text>
          <TextInput
            style={[setupStyles.input, setupStyles.inputShort]}
            placeholder="e.g. 28"
            placeholderTextColor="#bbb"
            value={fields.age}
            onChangeText={v => onChange("age", v.replace(/[^0-9]/g, ""))}
            keyboardType="number-pad"
          />

          {/* Height */}
          <Text style={setupStyles.label}>Height (cm)</Text>
          <TextInput
            style={[setupStyles.input, setupStyles.inputShort]}
            placeholder="e.g. 175"
            placeholderTextColor="#bbb"
            value={fields.height_cm}
            onChangeText={v => onChange("height_cm", v.replace(/[^0-9.]/g, ""))}
            keyboardType="decimal-pad"
          />

          {/* Weight */}
          <Text style={setupStyles.label}>Current weight (kg)</Text>
          <TextInput
            style={[setupStyles.input, setupStyles.inputShort]}
            placeholder="e.g. 72"
            placeholderTextColor="#bbb"
            value={fields.weight_kg}
            onChangeText={v => onChange("weight_kg", v.replace(/[^0-9.]/g, ""))}
            keyboardType="decimal-pad"
          />

          {/* Goal type */}
          <Text style={setupStyles.label}>Goal</Text>
          <OptionPills
            options={["lose", "maintain", "gain"]}
            labels={["Lose weight", "Maintain", "Gain weight"]}
            value={fields.goal_type}
            onSelect={v => onChange("goal_type", v)}
          />

          {/* Activity level */}
          <Text style={setupStyles.label}>Activity level</Text>
          <OptionPills
            options={["sedentary", "light", "moderate", "active", "very_active"]}
            labels={["Sedentary", "Light", "Moderate", "Active", "Very active"]}
            value={fields.activity_level}
            onSelect={v => onChange("activity_level", v)}
          />

          {/* Save */}
          <TouchableOpacity
            style={[setupStyles.saveButton, saving && setupStyles.saveButtonDisabled]}
            onPress={onSave}
            disabled={saving}
            activeOpacity={0.85}
          >
            <Text style={setupStyles.saveButtonText}>
              {saving ? "Saving…" : "Save changes"}
            </Text>
          </TouchableOpacity>

          {/* Feedback message */}
          {message ? (
            <Text style={[setupStyles.message, isSuccess && setupStyles.acctMessageSuccess]}>
              {message}
            </Text>
          ) : null}

          {/* Log out */}
          <TouchableOpacity
            style={setupStyles.acctLogOutButton}
            onPress={onLogOut}
            activeOpacity={0.75}
          >
            <Text style={setupStyles.acctLogOutText}>Log out</Text>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// SwipeableRow — wraps a list item and reveals a Delete action on swipe-left.
// Uses only built-in Animated + PanResponder (no extra dependency).
// ---------------------------------------------------------------------------
const SWIPE_THRESHOLD = 60;   // px to drag before the Delete button locks open
const DELETE_WIDTH    = 64;   // width of the revealed Delete button

function SwipeableRow({
  children,
  onDelete,
  disabled = false,
}: {
  children: React.ReactNode;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const translateX = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, gs) =>
        !disabled && Math.abs(gs.dx) > 6 && Math.abs(gs.dx) > Math.abs(gs.dy),
      onPanResponderMove: (_e, gs) => {
        const clamped = Math.max(-DELETE_WIDTH, Math.min(0, gs.dx));
        translateX.setValue(clamped);
      },
      onPanResponderRelease: (_e, gs) => {
        if (gs.dx < -SWIPE_THRESHOLD) {
          Animated.spring(translateX, { toValue: -DELETE_WIDTH, useNativeDriver: true }).start();
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  const close = () =>
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();

  return (
    // Outer row: delete button lives here at natural right-edge position.
    // overflow:"hidden" is NOT set here so the button is invisible until the
    // content slides; the content View below clips itself instead.
    <View style={swipeStyles.outerRow}>
      {/* Delete button — fixed at the right, always behind the content */}
      <View style={swipeStyles.deleteAction}>
        <TouchableOpacity
          style={swipeStyles.deleteButton}
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); close(); onDelete(); }}
        >
          <Ionicons name="trash-outline" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Sliding content — starts flush, covers the delete button completely.
          Its own overflow:"hidden" prevents it from drawing outside the row. */}
      <Animated.View
        style={[swipeStyles.contentSlider, { transform: [{ translateX }] }]}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const swipeStyles = StyleSheet.create({
  // Outer container — clips rounded corners and the delete zone behind the card.
  // marginTop lives here (not on logEntry) so the gap never exposes red background.
  outerRow: {
    marginTop: 10,
    borderRadius: 8,
    overflow: "hidden",
  },
  // Red delete zone — no borderRadius needed; outerRow clips it cleanly.
  deleteAction: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: DELETE_WIDTH,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#c62828",
  },
  deleteButton: {
    flex: 1,
    width: "100%",
    justifyContent: "center",
    alignItems: "center",
  },
  // Content fills full width so it perfectly covers the delete zone at rest.
  contentSlider: {
    width: "100%",
  },
});

// Small reusable component for displaying a single macro value
function MacroItem({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <View style={styles.macroItem}>
      <Text style={styles.macroValue}>{value}</Text>
      <Text style={styles.macroUnit}>{unit}</Text>
      <Text style={styles.macroLabel}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// TotalsRadialRings — "Radial Rings" design from Claude Design.
// Three concentric SVG rings (Protein / Carbs / Fat) around a central
// calorie count. Warm cream-to-gold gradient background (Sunrise Arc style).
// Hardcoded macro targets — backend is unchanged.
// ---------------------------------------------------------------------------
const CALORIE_GOAL   = 2000;
const MACRO_TARGETS  = { protein: 140, carbs: 220, fat: 70 };

// ---------------------------------------------------------------------------
// WaterIntakeScreen
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Water Intake — hydration setup persistence
// ---------------------------------------------------------------------------
type WaterSetup = {
  usesBottle: "yes" | "no";
  bottleSize: number | null;
  dailyGoalOz: number;
};

/** Returns true only when the saved object has all required fields for its path. */
function isValidWaterSetup(s: unknown): s is WaterSetup {
  if (!s || typeof s !== "object") return false;
  const { usesBottle, bottleSize, dailyGoalOz } = s as Record<string, unknown>;
  if (typeof dailyGoalOz !== "number" || dailyGoalOz <= 0) return false;
  if (usesBottle === "yes") return typeof bottleSize === "number";
  if (usesBottle === "no")  return true;
  return false;
}

const BOTTLE_SIZES_OZ         = [12, 16, 20, 24, 32, 40, 64];
const DAILY_GOAL_OPTIONS_OZ   = [32, 48, 64, 80, 96, 128];
const QUICK_ADD_OZ            = [8, 12, 16, 24];
const HIGH_WATER_THRESHOLD_OZ = 160; // conservative universal ceiling; no body-size data yet

/**
 * Compute the hydration streak from a list of daily log rows.
 *
 * A streak is the number of consecutive calendar days, counting backward
 * from today, where total_oz >= goal_oz_snapshot.  A missing calendar date
 * in the rows set counts as a break — rows are NOT assumed to be consecutive
 * just because they are adjacent in the array.
 *
 * Uses local-time date helpers (formatDateToLocalYYYYMMDD /
 * parseDateStringToLocalDate) so the boundary matches the device clock,
 * consistent with how localToday() works everywhere else.
 */
function computeHydrationStreak(
  rows: { log_date: string; total_oz: number; goal_oz_snapshot: number }[]
): number {
  // Build a Set of dates where the goal was met — O(n) lookup below.
  const metDates = new Set(
    rows
      .filter(r => (r.total_oz ?? 0) >= (r.goal_oz_snapshot ?? 1))
      .map(r => r.log_date)
  );

  let count = 0;
  // Walk backward through calendar dates starting from today.
  const cursor = parseDateStringToLocalDate(localToday());
  while (true) {
    const dateStr = formatDateToLocalYYYYMMDD(cursor);
    if (!metDates.has(dateStr)) break;   // missing OR goal not met → streak ends
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

/** One slot in the 7-day chart model. */
type WeekBarDatum = {
  dateStr:  string;   // YYYY-MM-DD
  dayLabel: string;   // single letter: M T W T F S S
  totalOz:  number;
  goalOz:   number;   // that day's goal — used for per-day bar scaling
  goalMet:  boolean;
  hasData:  boolean;  // false → missing row (render muted bar)
};

/**
 * Build the 7-day chart dataset, always covering exactly the last 7 calendar
 * days (today through 6 days ago).  Database rows are merged by date; any day
 * without a row gets totalOz = 0 / goalMet = false / hasData = false.
 */
function buildWeekChartData(
  rows: { log_date: string; total_oz: number; goal_oz_snapshot: number }[]
): { data: WeekBarDatum[]; maxOz: number } {
  // Map existing rows by date for O(1) lookup.
  const byDate = new Map(rows.map(r => [r.log_date, r]));

  const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"]; // getDay() → 0=Sun

  const data: WeekBarDatum[] = [];
  const cursor = parseDateStringToLocalDate(localToday());

  for (let i = 0; i < 7; i++) {
    const dateStr = formatDateToLocalYYYYMMDD(cursor);
    const row     = byDate.get(dateStr);
    data.push({
      dateStr,
      dayLabel: DAY_LETTERS[cursor.getDay()],
      totalOz:  row ? (row.total_oz ?? 0) : 0,
      goalOz:   row ? (row.goal_oz_snapshot ?? 64) : 64,
      goalMet:  row ? (row.total_oz ?? 0) >= (row.goal_oz_snapshot ?? 1) : false,
      hasData:  !!row,
    });
    cursor.setDate(cursor.getDate() - 1);
  }

  // Oldest-first so the chart reads left → right chronologically.
  data.reverse();

  const maxOz = Math.max(...data.map(d => d.totalOz), 1); // floor at 1 to avoid /0
  return { data, maxOz };
}

function WaterIntakeScreen({ onBack }: { onBack: () => void }) {
  const [usesBottle, setUsesBottle]     = useState<"yes" | "no" | null>(null);
  const [bottleSize, setBottleSize]     = useState<number | null>(null);
  const [dailyGoalOz, setDailyGoalOz]   = useState<number>(64);
  const [bottleCount, setBottleCount]   = useState<number>(0);
  const [directOz, setDirectOz]         = useState<number>(0);
  const [showTracking, setShowTracking] = useState(false);
  const [isEditing,   setIsEditing]    = useState(false);    // true when editing from tracking mode
  const [setupLoaded, setSetupLoaded]   = useState(false);   // gates render until storage is read
  const [userId, setUserId]             = useState<string | null>(null);
  const [streak, setStreak]             = useState<number>(0);
  const [weekData, setWeekData]         = useState<WeekBarDatum[]>([]);
  const cardOpacity = useRef(new Animated.Value(1)).current;

  // Bottle-path derived (unchanged)
  const totalOz = bottleCount * (bottleSize ?? 0);
  const goalPct = dailyGoalOz > 0 ? Math.min(1, totalOz / dailyGoalOz) : 0;
  const goalMet = bottleCount > 0 && totalOz >= dailyGoalOz;

  // Direct-oz-path derived
  const directGoalPct = dailyGoalOz > 0 ? Math.min(1, directOz / dailyGoalOz) : 0;
  const directGoalMet = directOz > 0 && directOz >= dailyGoalOz;

  // ── Hydration persistence (Supabase) ───────────────────────────────────────

  /**
   * Fetch the last 30 hydration_daily_logs rows for `uid`, compute the streak,
   * and update the `streak` state.  Fire-and-forget; failures leave streak at 0.
   * Accepts the user-id explicitly so callers don't need to wait for the
   * `userId` state to flush before calling (avoids stale-closure timing issues).
   */
  const fetchStreak = async (uid: string) => {
    try {
      const { data: rows } = await supabase
        .from("hydration_daily_logs")
        .select("log_date, total_oz, goal_oz_snapshot")
        .eq("user_id", uid)
        .order("log_date", { ascending: false })
        .limit(30);
      if (rows) setStreak(computeHydrationStreak(rows));
    } catch {
      // Silently ignore — streak stays at whatever it was.
    }
  };

  /**
   * Fetch the last 7 days of hydration_daily_logs for `uid`, shape the data
   * into a complete 7-slot chart model (missing days filled with zeros), and
   * update `weekData` state.  Fire-and-forget; failures leave the chart empty.
   */
  const fetchWeekChart = async (uid: string) => {
    try {
      // Calculate the date 6 days ago so we can filter server-side.
      const cutoff = parseDateStringToLocalDate(localToday());
      cutoff.setDate(cutoff.getDate() - 6);
      const cutoffStr = formatDateToLocalYYYYMMDD(cutoff);

      const { data: rows } = await supabase
        .from("hydration_daily_logs")
        .select("log_date, total_oz, goal_oz_snapshot")
        .eq("user_id", uid)
        .gte("log_date", cutoffStr)
        .order("log_date", { ascending: false });

      const { data } = buildWeekChartData(rows ?? []);
      setWeekData(data);
    } catch {
      // Silently ignore — chart stays empty / unchanged.
    }
  };

  /**
   * Upsert the user's hydration preferences row.
   * Fire-and-forget — UI never waits; failures are silent.
   */
  const saveSetup = async (setup: WaterSetup) => {
    if (!userId) return;
    try {
      await supabase.from("hydration_preferences").upsert({
        user_id:        userId,
        uses_bottle:    setup.usesBottle === "yes",
        bottle_size_oz: setup.bottleSize,
        daily_goal_oz:  setup.dailyGoalOz,
        updated_at:     new Date().toISOString(),
      }, { onConflict: "user_id" });

      // ── Sync today's log row if one already exists ────────────────────────
      // Only today's date is touched — historical rows are never modified.
      const today = localToday();
      const { data: existing } = await supabase
        .from("hydration_daily_logs")
        .select("bottle_count, direct_oz")
        .eq("user_id", userId)
        .eq("log_date", today)
        .single();

      if (existing) {
        // Recompute total_oz with the new preferences.
        // Bottle mode: use the new bottle size if bottles have been logged.
        // Non-bottle mode: total is just direct_oz (bottle_count stays 0).
        const recomputedTotal =
          setup.usesBottle === "yes"
            ? (existing.bottle_count ?? 0) * (setup.bottleSize ?? 0) + (existing.direct_oz ?? 0)
            : (existing.direct_oz ?? 0);

        await supabase
          .from("hydration_daily_logs")
          .update({
            goal_oz_snapshot: setup.dailyGoalOz,
            total_oz:         recomputedTotal,
            updated_at:       new Date().toISOString(),
          })
          .eq("user_id", userId)
          .eq("log_date", today);
      }

      // Refresh streak and chart — goal change may flip whether today counts.
      fetchStreak(userId);
      fetchWeekChart(userId);
    } catch {
      // Silently ignore — the UI keeps working.
    }
  };

  /**
   * Upsert today's hydration log row.
   * Called immediately after any count/oz change with the explicit new values
   * to avoid stale-closure issues with React state.
   * Fire-and-forget.
   */
  const saveDailyLog = async (
    nextBottleCount: number,
    nextDirectOz: number,
    currentBottleSize: number | null,
    currentDailyGoal: number,
  ) => {
    if (!userId) return;
    const total = nextBottleCount * (currentBottleSize ?? 0) + nextDirectOz;
    try {
      await supabase.from("hydration_daily_logs").upsert({
        user_id:           userId,
        log_date:          localToday(),
        bottle_count:      nextBottleCount,
        direct_oz:         nextDirectOz,
        total_oz:          total,
        goal_oz_snapshot:  currentDailyGoal,
        updated_at:        new Date().toISOString(),
      }, { onConflict: "user_id,log_date" });

      // Refresh streak and chart after every intake change.
      fetchStreak(userId);
      fetchWeekChart(userId);
    } catch {
      // Silently ignore.
    }
  };

  /**
   * On mount: fetch the signed-in user, load their preferences and today's log
   * from Supabase, then initialize state. The card is gated behind `setupLoaded`
   * so there is no flash of the wrong mode.
   */
  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setSetupLoaded(true); return; }
        setUserId(user.id);

        // Load preferences
        const { data: prefs } = await supabase
          .from("hydration_preferences")
          .select("uses_bottle, bottle_size_oz, daily_goal_oz")
          .eq("user_id", user.id)
          .single();

        if (prefs) {
          const mapped: WaterSetup = {
            usesBottle:   prefs.uses_bottle ? "yes" : "no",
            bottleSize:   prefs.bottle_size_oz ?? null,
            dailyGoalOz:  prefs.daily_goal_oz  ?? 64,
          };
          if (isValidWaterSetup(mapped)) {
            setUsesBottle(mapped.usesBottle);
            setBottleSize(mapped.bottleSize);
            setDailyGoalOz(mapped.dailyGoalOz);

            // Load today's log counts
            const { data: log } = await supabase
              .from("hydration_daily_logs")
              .select("bottle_count, direct_oz")
              .eq("user_id", user.id)
              .eq("log_date", localToday())
              .single();

            if (log) {
              setBottleCount(log.bottle_count ?? 0);
              setDirectOz(log.direct_oz ?? 0);
            }

            setShowTracking(true); // skip setup, open directly in tracking

            // Load streak and week chart in parallel alongside the rest of the data.
            fetchStreak(user.id);
            fetchWeekChart(user.id);
          }
        }
      } catch {
        // Network/auth failure — fall through to fresh setup mode.
      } finally {
        setSetupLoaded(true); // reveal the card in whichever mode is correct
      }
    })();
  }, []);

  // ── Transition helpers ──────────────────────────────────────────────────────
  // Called directly from selection handlers so there is no useEffect re-trigger
  // problem when the user comes back to edit and re-selects the same values.
  const transitionToTracking = () => {
    if (showTracking) return;
    setIsEditing(false);
    Animated.timing(cardOpacity, {
      toValue: 0, duration: 220, useNativeDriver: true,
    }).start(() => {
      setShowTracking(true);
      Animated.timing(cardOpacity, {
        toValue: 1, duration: 260, useNativeDriver: true,
      }).start();
    });
  };

  const resetToSetup = () => {
    setIsEditing(true);
    Animated.timing(cardOpacity, {
      toValue: 0, duration: 180, useNativeDriver: true,
    }).start(() => {
      setShowTracking(false);
      Animated.timing(cardOpacity, {
        toValue: 1, duration: 220, useNativeDriver: true,
      }).start();
    });
  };

  return (
    <LinearGradient
      colors={["#FFFEF8", "#FFF8D4", "#FDF3B0"]}
      locations={[0, 0.5, 1]}
      start={{ x: 0.15, y: 0 }}
      end={{ x: 0.85, y: 1 }}
      style={waterStyles.gradientRoot}
    >
      <SafeAreaView style={waterStyles.safeTransparent}>
      <ScrollView
        style={setupStyles.scroll}
        contentContainerStyle={setupStyles.container}
      >
        {/* Back navigation — goes to tracking when editing, otherwise exits to home */}
        <TouchableOpacity
          onPress={isEditing ? transitionToTracking : onBack}
          style={setupStyles.acctBackButton}
          activeOpacity={0.7}
        >
          <Ionicons name="arrow-back" size={18} color="#555" />
          <Text style={setupStyles.acctBackText}>Back</Text>
        </TouchableOpacity>

        <Text style={setupStyles.headline}>Water Intake</Text>
        <Text style={waterStyles.subhead}>Track your daily water intake in oz.</Text>

        {/* ── Top card — only renders after saved setup is loaded from storage ─ */}
        {setupLoaded && <Animated.View style={[waterStyles.setupCard, { opacity: cardOpacity }]}>

          {showTracking ? (

            /* ── TRACKING MODE ────────────────────────────────────────────── */
            <>
              {/* Header row — title + Edit affordance */}
              <View style={waterStyles.trackCardHeader}>
                <View style={waterStyles.trackCardTitleRow}>
                  <Ionicons name="checkmark-circle-outline" size={20} color="#C48A1A" />
                  <Text style={waterStyles.trackHeading}>
                    {usesBottle === "yes" ? "Today's bottles" : "Today's intake"}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={resetToSetup}
                  activeOpacity={0.6}
                  hitSlop={{ top: 8, bottom: 8, left: 12, right: 4 }}
                >
                  <Ionicons name="create-outline" size={19} color={COLORS.primary} />
                </TouchableOpacity>
              </View>

              {usesBottle === "yes" && bottleSize !== null ? (
                /* bottle-based tracking */
                <>
                  <Text style={waterStyles.trackSubhead}>
                    Based on your {bottleSize} oz bottle
                  </Text>

                  {/* Stepper */}
                  <View style={waterStyles.stepperRow}>
                    <Pressable
                      onPress={() => {
                        const next = Math.max(0, bottleCount - 1);
                        setBottleCount(next);
                        saveDailyLog(next, directOz, bottleSize, dailyGoalOz);
                      }}
                      disabled={bottleCount === 0}
                      style={({ pressed }) => [
                        waterStyles.stepperButton,
                        bottleCount === 0
                          ? waterStyles.stepperButtonDisabled
                          : pressed && waterStyles.btnPressed,
                      ]}
                    >
                      <Ionicons name="remove" size={22} color={bottleCount === 0 ? "#ccc" : "#1A1A14"} />
                    </Pressable>

                    <View style={waterStyles.stepperCenter}>
                      <Text style={waterStyles.stepperCount}>{bottleCount}</Text>
                      <Text style={waterStyles.stepperLabel}>
                        {bottleCount === 1 ? "bottle" : "bottles"}
                      </Text>
                    </View>

                    <Pressable
                      onPress={() => {
                        const next = bottleCount + 1;
                        setBottleCount(next);
                        saveDailyLog(next, directOz, bottleSize, dailyGoalOz);
                      }}
                      style={({ pressed }) => [
                        waterStyles.stepperButton,
                        pressed && waterStyles.btnPressed,
                      ]}
                    >
                      <Ionicons name="add" size={22} color="#1A1A14" />
                    </Pressable>
                  </View>

                  {/* Oz hero display */}
                  <View style={waterStyles.divider} />
                  <View style={waterStyles.ozDisplay}>
                    <Text style={[waterStyles.ozHero, goalMet && waterStyles.totalOzMet]}>
                      {totalOz} oz
                    </Text>
                    <Text style={waterStyles.ozGoalText}>of {dailyGoalOz} oz</Text>
                  </View>

                  {/* Progress bar */}
                  <View style={waterStyles.progressTrack}>
                    <View
                      style={[
                        waterStyles.progressFill,
                        { width: `${Math.round(goalPct * 100)}%` as any },
                        goalMet && waterStyles.progressFillMet,
                      ]}
                    />
                  </View>
                  <View style={waterStyles.progressFooterRow}>
                    <Text style={[waterStyles.progressLabel, goalMet && waterStyles.progressLabelMet]}>
                      {goalMet
                        ? "Daily goal reached! 🎉"
                        : `${Math.round(goalPct * 100)}% of your goal`}
                    </Text>
                  </View>
                </>
              ) : (
                /* no-bottle tracking — quick-add oz UI */
                <>
                  <Text style={waterStyles.trackSubhead}>
                    Quick add your water in oz
                  </Text>

                  {/* Quick-add buttons */}
                  <View style={waterStyles.quickAddRow}>
                    {QUICK_ADD_OZ.map((amt) => (
                      <Pressable
                        key={amt}
                        onPress={() => {
                          const next = directOz + amt;
                          setDirectOz(next);
                          saveDailyLog(bottleCount, next, bottleSize, dailyGoalOz);
                        }}
                        style={({ pressed }) => [
                          waterStyles.quickAddButton,
                          pressed && waterStyles.btnPressed,
                        ]}
                      >
                        <Text style={waterStyles.quickAddText}>+{amt} oz</Text>
                      </Pressable>
                    ))}
                  </View>

                  {/* Oz hero display */}
                  <View style={waterStyles.divider} />
                  <View style={waterStyles.ozDisplay}>
                    <Text style={[waterStyles.ozHero, directGoalMet && waterStyles.totalOzMet]}>
                      {directOz} oz
                    </Text>
                    <Text style={waterStyles.ozGoalText}>of {dailyGoalOz} oz</Text>
                  </View>

                  {/* Progress bar */}
                  <View style={waterStyles.progressTrack}>
                    <View
                      style={[
                        waterStyles.progressFill,
                        { width: `${Math.round(directGoalPct * 100)}%` as any },
                        directGoalMet && waterStyles.progressFillMet,
                      ]}
                    />
                  </View>

                  {/* Progress label + Reset affordance */}
                  <View style={waterStyles.progressFooterRow}>
                    <Text style={[waterStyles.progressLabel, directGoalMet && waterStyles.progressLabelMet]}>
                      {directGoalMet
                        ? "Daily goal reached! 🎉"
                        : `${Math.round(directGoalPct * 100)}% of your goal`}
                    </Text>
                    {directOz > 0 && (
                      <TouchableOpacity
                        onPress={() => {
                          setDirectOz(0);
                          saveDailyLog(bottleCount, 0, bottleSize, dailyGoalOz);
                        }}
                        activeOpacity={0.6}
                        hitSlop={{ top: 6, bottom: 6, left: 8, right: 4 }}
                      >
                        <Text style={waterStyles.resetLink}>Reset</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </>
              )}

              {/* High-intake caution — shown when today's total is unusually large */}
              {(usesBottle === "yes" ? totalOz : directOz) >= HIGH_WATER_THRESHOLD_OZ && (
                <View style={waterStyles.highWaterWarning}>
                  <Ionicons name="warning-outline" size={15} color="#7a4a00" />
                  <Text style={waterStyles.highWaterWarningText}>
                    Very high water intake today. Consider slowing down and drinking according to thirst.
                  </Text>
                </View>
              )}
            </>

          ) : (

            /* ── SETUP MODE ───────────────────────────────────────────────── */
            <>
              {/* Card heading */}
              <View style={waterStyles.setupCardHeader}>
                <Ionicons name="water-outline" size={20} color="#C48A1A" />
                <Text style={waterStyles.setupHeading}>Set up your hydration</Text>
              </View>
              <Text style={waterStyles.setupBody}>
                Answer a few quick questions so we can make tracking as effortless as possible.
              </Text>

              <View style={waterStyles.divider} />

              {/* Q1 */}
              <Text style={waterStyles.questionLabel}>
                Do you usually drink from a personal water bottle?
              </Text>
              <View style={waterStyles.pillRow}>
                {(["yes", "no"] as const).map((opt) => (
                  <TouchableOpacity
                    key={opt}
                    style={[waterStyles.pill, usesBottle === opt && waterStyles.pillSelected]}
                    onPress={() => {
                      setUsesBottle(opt);
                      if (opt === "no") {
                        setBottleSize(null);
                        // Save with explicit values — state setters above are async,
                        // so pass current knowns directly to avoid stale closures.
                        saveSetup({ usesBottle: "no", bottleSize: null, dailyGoalOz });
                        transitionToTracking();
                      }
                    }}
                    activeOpacity={0.75}
                  >
                    <Text style={[waterStyles.pillText, usesBottle === opt && waterStyles.pillTextSelected]}>
                      {opt === "yes" ? "Yes" : "No"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Q2 — revealed only when user says Yes */}
              {usesBottle === "yes" && (
                <>
                  <Text style={waterStyles.questionLabel}>
                    What size is your water bottle?
                  </Text>
                  <View style={waterStyles.pillRow}>
                    {BOTTLE_SIZES_OZ.map((sz) => (
                      <TouchableOpacity
                        key={sz}
                        style={[waterStyles.pill, bottleSize === sz && waterStyles.pillSelected]}
                        onPress={() => {
                          setBottleSize(sz);
                          // Save with explicit sz — bottleSize state hasn't flushed yet.
                          saveSetup({ usesBottle: "yes", bottleSize: sz, dailyGoalOz });
                          transitionToTracking();
                        }}
                        activeOpacity={0.75}
                      >
                        <Text style={[waterStyles.pillText, bottleSize === sz && waterStyles.pillTextSelected]}>
                          {sz} oz
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <View style={waterStyles.helperRow}>
                    <Ionicons name="information-circle-outline" size={13} color="rgba(26,26,20,0.35)" />
                    <Text style={waterStyles.helperText}>
                      Once set up, you can log full bottles instead of counting individual ounces — we'll do the math for you.
                    </Text>
                  </View>
                </>
              )}

              <View style={waterStyles.divider} />

              {/* Q3 — daily goal */}
              <Text style={waterStyles.questionLabel}>
                How many oz of water do you want to drink in a day?
              </Text>
              <View style={waterStyles.pillRow}>
                {DAILY_GOAL_OPTIONS_OZ.map((oz) => (
                  <TouchableOpacity
                    key={oz}
                    style={[waterStyles.pill, dailyGoalOz === oz && waterStyles.pillSelected]}
                    onPress={() => setDailyGoalOz(oz)}
                    activeOpacity={0.75}
                  >
                    <Text style={[waterStyles.pillText, dailyGoalOz === oz && waterStyles.pillTextSelected]}>
                      {oz} oz
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Save button — always visible in setup mode so the user can
                  confirm changes (especially daily-goal-only edits) and
                  return to the tracking view without going back to home. */}
              {usesBottle !== null && (usesBottle === "no" || bottleSize !== null) && (
                <TouchableOpacity
                  onPress={() => {
                    saveSetup({ usesBottle: usesBottle!, bottleSize, dailyGoalOz });
                    transitionToTracking();
                  }}
                  style={waterStyles.saveButton}
                  activeOpacity={0.8}
                >
                  <Text style={waterStyles.saveButtonText}>Save</Text>
                </TouchableOpacity>
              )}
            </>

          )}

        </Animated.View>}

        {/* ── Hydration streak card — only visible in tracking mode ─────────── */}
        {setupLoaded && showTracking && (
          <View style={waterStyles.streakCard}>
            <View style={waterStyles.streakHeaderRow}>
              <Ionicons name="flame-outline" size={17} color="#C48A1A" />
              <Text style={waterStyles.streakHeading}>Hydration streak</Text>
            </View>
            {streak > 0 ? (
              <>
                <Text style={waterStyles.streakCount}>🔥 {streak} {streak === 1 ? "day" : "days"}</Text>
                <Text style={waterStyles.streakBody}>
                  You've hit your goal {streak} {streak === 1 ? "day" : "days"} in a row
                </Text>
              </>
            ) : (
              <>
                <Text style={waterStyles.streakCount}>No streak yet</Text>
                <Text style={waterStyles.streakBody}>Hit your goal today to start one</Text>
              </>
            )}
          </View>
        )}

        {/* ── Last 7 days chart card ────────────────────────────────────────── */}
        {setupLoaded && showTracking && (() => {
          const CHART_HEIGHT = 88; // px — height of the bar track
          const hasAnyData   = weekData.some(d => d.hasData);

          return (
            <View style={waterStyles.weekCard}>
              {/* Header */}
              <View style={waterStyles.weekHeaderRow}>
                <Ionicons name="bar-chart-outline" size={17} color="#C48A1A" />
                <Text style={waterStyles.weekHeading}>Last 7 days</Text>
              </View>
              <Text style={waterStyles.weekSubhead}>Your hydration over the past week</Text>

              {/* Bar chart */}
              <View style={[waterStyles.weekChartTrack, { height: CHART_HEIGHT }]}>
                {(weekData.length === 7 ? weekData : Array(7).fill(null)).map((d: WeekBarDatum | null, i) => {
                  const isToday  = d?.dateStr === localToday();
                  const fillH    = d && d.totalOz > 0
                    ? Math.min(CHART_HEIGHT, Math.max(4, Math.round((d.totalOz / Math.max(d.goalOz, 1)) * CHART_HEIGHT)))
                    : 4; // minimum nub so the bar slot is never invisible

                  const barColor = !d || !d.hasData
                    ? "rgba(26,26,20,0.08)"           // missing — very muted
                    : d.goalMet
                      ? "#2e7d32"                     // goal met — green
                      : "#C48A1A";                    // partial — gold

                  return (
                    <View key={i} style={waterStyles.weekBarSlot}>
                      {/* bar track (full height, always visible as background) */}
                      <View style={[waterStyles.weekBarTrack, { height: CHART_HEIGHT }]}>
                        {/* filled portion — bottom-aligned via absolute bottom:0 */}
                        <View
                          style={[
                            waterStyles.weekBarFill,
                            { height: fillH, backgroundColor: barColor },
                          ]}
                        />
                      </View>
                      {/* day label */}
                      <Text style={[
                        waterStyles.weekDayLabel,
                        isToday && waterStyles.weekDayLabelToday,
                      ]}>
                        {d?.dayLabel ?? "·"}
                      </Text>
                    </View>
                  );
                })}
              </View>

              {/* Empty state helper */}
              {!hasAnyData && (
                <Text style={waterStyles.weekEmptyText}>
                  Start tracking today to build your weekly hydration view
                </Text>
              )}
            </View>
          );
        })()}

      </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------
// TotalsRadialRings
// ---------------------------------------------------------------------------
function TotalsRadialRings({ summary, selectedDate, goal = CALORIE_GOAL }: { summary: DailySummary; selectedDate: string; goal?: number }) {
  const { total_calories, total_protein, total_carbs, total_fat, entries_count } = summary;
  const calPct = Math.min(1, total_calories / goal);
  const pctLabel = `${Math.round(calPct * 100)}%`;
  const isToday = selectedDate === localToday();

  const rings = [
    { label: "Protein", value: total_protein, target: MACRO_TARGETS.protein, r: 78, color: "#8B5A0F" },
    { label: "Carbs",   value: total_carbs,   target: MACRO_TARGETS.carbs,   r: 64, color: "#1A1A14" },
    { label: "Fat",     value: total_fat,     target: MACRO_TARGETS.fat,     r: 50, color: "#C48A1A" },
  ];

  return (
    <LinearGradient
      colors={["#FFF8D4", "#FDEFA5", "#F7DF6A"]}
      locations={[0, 0.55, 1]}
      start={{ x: 0.1, y: 0 }} end={{ x: 1, y: 1 }}
      style={styles.ringsCard}
    >
      {/* Soft glow highlight at top */}
      <View style={styles.ringsGlow} pointerEvents="none" />

      {/* Header row */}
      <View style={styles.ringsHeader}>
        <View>
          <Text style={styles.ringsTitle}>
            {isToday ? "Today's Totals" : `Totals — ${formatDateLabel(selectedDate)}`}
          </Text>
          <Text style={styles.ringsEntryCount}>
            {entries_count} {entries_count === 1 ? "entry" : "entries"} logged
          </Text>
        </View>
        <View style={styles.ringsPctBadge}>
          <Text style={styles.ringsPctText}>{pctLabel}</Text>
        </View>
      </View>

      {/* Rings + legend row */}
      <View style={styles.ringsBody}>
        {/* SVG ring stack */}
        <View style={styles.ringsSvgWrap}>
          <Svg width={180} height={180} viewBox="0 0 180 180">
            {rings.map((ring) => {
              const circumference = 2 * Math.PI * ring.r;
              const dash = circumference * Math.min(1, ring.value / ring.target);
              return (
                <G key={ring.label} rotation="-90" origin="90, 90">
                  {/* track */}
                  <Circle
                    cx={90} cy={90} r={ring.r}
                    fill="none"
                    stroke="rgba(26,26,20,0.10)"
                    strokeWidth={8}
                  />
                  {/* filled arc */}
                  <Circle
                    cx={90} cy={90} r={ring.r}
                    fill="none"
                    stroke={ring.color}
                    strokeWidth={8}
                    strokeDasharray={`${dash} ${circumference}`}
                    strokeLinecap="round"
                  />
                </G>
              );
            })}
          </Svg>
          {/* Center label */}
          <View style={styles.ringsCenterLabel}>
            <Text style={styles.ringsCenterCals}>{Math.round(total_calories).toLocaleString()}</Text>
            <Text style={styles.ringsCenterUnit}>kcal</Text>
            <Text style={styles.ringsCenterGoal}>/{(goal / 1000).toFixed(1)}k goal</Text>
          </View>
        </View>

        {/* Legend */}
        <View style={styles.ringsLegend}>
          {rings.map((ring) => {
            const p = Math.round(Math.min(1, ring.value / ring.target) * 100);
            return (
              <View key={ring.label} style={styles.ringsLegendItem}>
                <View style={styles.ringsLegendRow}>
                  <View style={[styles.ringsLegendDot, { backgroundColor: ring.color }]} />
                  <Text style={styles.ringsLegendLabel}>{ring.label.toUpperCase()}</Text>
                </View>
                <Text style={styles.ringsLegendValue}>
                  {ring.value}
                  <Text style={styles.ringsLegendUnit}>g</Text>
                  <Text style={styles.ringsLegendPct}>  · {p}%</Text>
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------
// WeeklyGlowLine — "Glow Line" design replacing the horizontal bar chart.
// Consumes WeeklyDay[] (same shape as before). Warm gradient card, smooth
// SVG line, area fill, dashed goal line, day labels. No backend changes.
// ---------------------------------------------------------------------------
function WeeklyGlowLine({ data, goal = CALORIE_GOAL }: { data: WeeklyDay[]; goal?: number }) {
  if (!data.length) return null;

  // Scale is always goal × 1.5 so every day is measured against the same
  // target-relative axis rather than the tallest bar in the current week.
  const maxScale = goal * 1.5;
  const avg = Math.round(data.reduce((s, d) => s + d.total_calories, 0) / data.length);

  // Fixed SVG coordinate space — scales to container width via viewBox.
  const W = 300, H = 110, P = 8;
  const step = data.length > 1 ? (W - P * 2) / (data.length - 1) : 0;

  const pts = data.map((d, i) => {
    // Normalise to [0, 1] against the fixed scale; clamp so overflow is capped.
    const norm = maxScale === 0 ? 0 : Math.min(d.total_calories / maxScale, 1);
    // Color each dot by how the day compares to the goal.
    let dotColor: string;
    if (d.total_calories <= goal)        dotColor = COLORS.primary; // yellow — on target
    else if (d.total_calories <= goal * 1.2) dotColor = "#FFA500"; // orange — slight over
    else                                 dotColor = "#FF4D4D";     // red   — well over
    return {
      x: P + i * step,
      y: H - P - norm * (H - P * 2),
      date: d.date,
      dotColor,
    };
  });

  const linePath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath =
    `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(H - P).toFixed(1)}` +
    ` L${pts[0].x.toFixed(1)},${(H - P).toFixed(1)} Z`;
  const goalY = maxScale === 0 ? H - P : H - P - (goal / maxScale) * (H - P * 2);

  return (
    <LinearGradient
      colors={["#FFF8D4", "#FDEFA5", "#F7DF6A"]}
      locations={[0, 0.55, 1]}
      start={{ x: 0.1, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.weekGlowCard}
    >
      {/* Header */}
      <View style={styles.weekGlowHeader}>
        <View>
          <Text style={styles.weekGlowTitle}>Last 7 days</Text>
          <Text style={styles.weekGlowAvg}>
            {"Avg "}
            <Text style={styles.weekGlowAvgBold}>{avg}</Text>
            {" kcal/day"}
          </Text>
        </View>
        <View style={styles.weekGlowGoalBadge}>
          <Text style={styles.weekGlowGoalText}>Goal {goal}</Text>
        </View>
      </View>

      {/* SVG chart */}
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
        <Defs>
          <SvgLinearGradient id="wgl-area" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor="#F5D834" stopOpacity={0.55} />
            <Stop offset="100%" stopColor="#F5D834" stopOpacity={0} />
          </SvgLinearGradient>
        </Defs>

        {/* Baseline */}
        <SvgLine
          x1={P} y1={H - P} x2={W - P} y2={H - P}
          stroke="rgba(26,26,20,0.15)" strokeWidth={1}
        />

        {/* Dashed goal line — only drawn when it falls within the chart area */}
        {goalY > P && goalY < H - P && (
          <SvgLine
            x1={P} y1={goalY} x2={W - P} y2={goalY}
            stroke="rgba(26,26,20,0.35)" strokeWidth={1}
            strokeDasharray="3,3"
          />
        )}

        {/* Area fill under the line */}
        <SvgPath d={areaPath} fill="url(#wgl-area)" />

        {/* Line */}
        <SvgPath
          d={linePath}
          fill="none"
          stroke="#1A1A14"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Dots — color reflects calories vs goal; today gets a larger dot + outer ring */}
        {pts.map((p, i) => {
          const isToday = i === pts.length - 1;
          return (
            <G key={p.date}>
              {isToday && (
                <Circle
                  cx={p.x} cy={p.y} r={7}
                  fill="none"
                  stroke={p.dotColor}
                  strokeOpacity={0.35}
                  strokeWidth={1.5}
                />
              )}
              <Circle cx={p.x} cy={p.y} r={isToday ? 4.5 : 3} fill={p.dotColor} />
            </G>
          );
        })}
      </Svg>

      {/* Day labels */}
      <View style={styles.weekGlowLabels}>
        {data.map((d, i) => (
          <Text
            key={d.date}
            style={[
              styles.weekGlowDayLabel,
              i === data.length - 1 && styles.weekGlowDayLabelToday,
            ]}
          >
            {new Date(d.date + "T00:00:00")
              .toLocaleDateString([], { weekday: "short" })
              .slice(0, 3)}
          </Text>
        ))}
      </View>
    </LinearGradient>
  );
}

const COLORS = {
  primary:      "#E3D517",  // brand yellow
  primaryLight: "#FAF3B0",  // soft yellow for card accents
  textPrimary:  "#111111",
  textSecondary:"#666666",
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "transparent",
  },
  // flex:1 ensures the ScrollView fills available space so the bottom bar
  // is always pushed to the bottom rather than floating mid-screen.
  scrollView: {
    flex: 1,
    backgroundColor: "#FAFAF7",
  },
  container: {
    padding: 20,
    paddingBottom: 96,   // extra room so last item scrolls above the floating bar
  },
  // True floating overlay — absolutely positioned so the scroll content
  // extends fully behind it with no panel or footer effect underneath.
  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    // paddingBottom is set inline via insets.bottom so it respects the
    // device's home-indicator safe-area on every device.
  },

  // Auth screen — Solar Bloom design
  authSafe: {
    flex: 1,
    backgroundColor: "#FFFBEC",   // fallback before gradient renders
  },
  // Outer radial glow — large soft halo
  authGlowOuter: {
    position: "absolute",
    width: 340,
    height: 280,
    borderRadius: 170,
    top: "14%",
    left: "50%",
    marginLeft: -170,
    backgroundColor: "rgba(250,230,90,0.28)",
  },
  // Mid glow — tighter fill
  authGlowMid: {
    position: "absolute",
    width: 220,
    height: 160,
    borderRadius: 110,
    top: "18%",
    left: "50%",
    marginLeft: -110,
    backgroundColor: "rgba(255,245,150,0.40)",
  },
  // Hot core highlight
  authGlowCore: {
    position: "absolute",
    width: 100,
    height: 70,
    borderRadius: 50,
    top: "22%",
    left: "50%",
    marginLeft: -50,
    backgroundColor: "rgba(255,252,200,0.55)",
  },
  // Shimmer flare — extra soft pulse layer
  authGlowShimmer: {
    position: "absolute",
    width: 300,
    height: 220,
    borderRadius: 150,
    top: "17%",
    left: "50%",
    marginLeft: -150,
    backgroundColor: "rgba(255,250,200,0.55)",
  },
  // Warm ground wash below horizon
  authGroundWash: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "46%",
    bottom: 0,
    backgroundColor: "rgba(230,180,100,0.12)",
  },
  // Thin horizon hairline just below the logo
  authHorizon: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "46%",
    height: 1,
    backgroundColor: "rgba(180,150,60,0.18)",
  },
  authContainer: {
    flex: 1,
    paddingHorizontal: 28,
    width: "100%",
    justifyContent: "space-between",
  },
  // Upper hero area — wordmark + tagline
  authLogoArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 40,
  },
  authWordmark: {
    fontFamily: "Chillax-Bold",
    fontSize: 72,
    color: "#F5D834",
    letterSpacing: -1.5,
    textShadowColor: "rgba(255,220,60,0.85)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 28,
  },
  authTagline: {
    fontFamily: "Chillax-Regular",
    fontSize: 16,
    color: "rgba(60,40,10,0.65)",
    marginTop: 8,
    letterSpacing: -0.2,
    textAlign: "center",
  },
  // Bottom form area
  authForm: {
    paddingBottom: 20,
    width: "100%",
  },
  authInput: {
    width: "100%",
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 15,
    fontFamily: "Inter-Variable",
    color: "#1A1A14",
    backgroundColor: "rgba(255,255,255,0.55)",
    borderWidth: 1,
    borderColor: "rgba(26,26,20,0.10)",
    borderRadius: 12,
    marginBottom: 12,
  },
  authSignInButton: {
    height: 56,
    borderRadius: 16,
    backgroundColor: "#1A1A14",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
    shadowColor: "#1A1A14",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  authSignInText: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 17,
    color: "#F8E94A",
    letterSpacing: -0.2,
  },
  authDivider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 12,
  },
  authDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "rgba(26,26,20,0.10)",
  },
  authDividerText: {
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.5)",
  },
  authSignUpButton: {
    height: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(26,26,20,0.15)",
    backgroundColor: "rgba(255,255,255,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  authSignUpText: {
    fontFamily: "Chillax-Medium",
    fontSize: 16,
    color: "#1A1A14",
  },
  authBackLink: {
    alignSelf: "center",
    marginTop: 12,
  },
  authBackLinkText: {
    fontFamily: "Chillax-Regular",
    fontSize: 14,
    color: "rgba(26,26,20,0.6)",
  },
  authForgotText: {
    fontFamily: "Chillax-Regular",
    fontSize: 14,
    color: "rgba(26,26,20,0.6)",
    textAlign: "center",
  },
  authMessage: {
    marginTop: 14,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.6)",
    textAlign: "center",
  },

  // Logo
  logoContainer: {
    alignItems: "center",
    marginBottom: 24,
  },
  logo: {
    width: 160,
    height: 60,
  },

  // Header
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginTop: 12,
    marginBottom: 16,
  },
  appSubtitle: {
    fontSize: 14,
    fontFamily: "Inter-Variable",
    color: "#555",
    marginBottom: 16,
  },
  logOutText: {
    fontSize: 13,
    color: "#555",
    paddingTop: 8,
  },
  sidebarBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.28)",
    zIndex: 20,
  },
  sidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    width: 220,
    backgroundColor: "#FAFAF7",
    paddingTop: 64,
    paddingHorizontal: 24,
    zIndex: 21,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 4, height: 0 },
    elevation: 8,
  },
  sidebarTitle: {
    fontSize: 22,
    fontFamily: "Chillax-SemiBold",
    color: "#111",
    marginBottom: 32,
  },
  sidebarDivider: {
    height: 1,
    backgroundColor: "#eee",
    marginBottom: 20,
  },
  sidebarItem: {
    fontSize: 15,
    fontFamily: "Chillax-Medium",
    color: "#111",
  },
  sidebarLogOutWrapper: {
    alignSelf: "flex-start",
    borderBottomWidth: 1.5,
    borderBottomColor: COLORS.primary,
    paddingBottom: 1,
  },
  sidebarLogOut: {
    fontSize: 15,
    fontFamily: "Chillax-Medium",
    color: "#111",
  },
  calorieBadge: {
    position: "absolute",
    top: 72,
    right: 20,
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    zIndex: 10,
  },
  calorieBadgeText: {
    fontSize: 12,
    fontFamily: "Chillax-Medium",
    color: "#111",
  },

  // Date selector
  dateSection: {
    marginBottom: 4,
  },
  dateTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
    alignSelf: "flex-start",
  },
  dateTriggerUnderline: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.primary,
  },
  dateTriggerText: {
    fontSize: 15,
    fontFamily: "Inter-Variable",
    color: "#111",
  },
  dateTriggerIcon: {
    fontSize: 14,
    color: "#555",
  },
  datePicker: {
    marginTop: 4,
  },

  // Sections
  section: {
    marginTop: 28,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Chillax-Medium",
    color: "#555",
    letterSpacing: 1.2,
    marginBottom: 10,
  },

  // Input
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    borderRadius: 999,
    paddingHorizontal: 12,
    marginBottom: 10,
    // Subtle elevation so the bar feels slightly lifted above the content
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  // Applied on top of inputRow when the TextInput is focused.
  inputRowFocused: {
    borderWidth: 3,
    borderColor: COLORS.primary,
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  input: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter-Variable",
    color: "#111",
  },

  searchingText: {
    marginTop: 8,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "#555",
  },

  scanButton: {
    marginLeft: 8,
    justifyContent: "center",
  },
  scanButtonIcon: {
    width: 32,
    height: 32,
    resizeMode: "contain",
  },

  // Barcode scanner modal
  scannerContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  scannerCamera: {
    flex: 1,
  },
  scannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  scannerReticle: {
    width: 240,
    height: 160,
    borderWidth: 2,
    borderColor: "#fff",
    borderRadius: 8,
    opacity: 0.7,
  },
  scannerHint: {
    marginTop: 16,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "rgba(255,255,255,0.75)",
    letterSpacing: 0.2,
  },
  scannerActions: {
    position: "absolute",
    bottom: 48,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  scannerCancelButton: {
    paddingVertical: 10,
    paddingHorizontal: 32,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  scannerCancelText: {
    fontSize: 15,
    fontFamily: "Inter-Variable",
    color: "#fff",
    fontWeight: "600",
  },
  scannerPermissionBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    backgroundColor: "#fff",
  },
  scannerPermissionText: {
    fontSize: 15,
    fontFamily: "Inter-Variable",
    color: "#333",
    textAlign: "center",
    marginBottom: 20,
  },
  scannerSettingsLink: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 20,
    backgroundColor: COLORS.primary,
    marginBottom: 4,
  },
  scannerSettingsLinkText: {
    fontSize: 14,
    fontFamily: "Inter-Variable",
    color: "#fff",
    fontWeight: "600",
  },

  // Cards
  card: {
    marginTop: 14,
    padding: 16,
    borderRadius: 10,
    backgroundColor: "#f9f9f9",
    borderWidth: 1,
    borderColor: "#eee",
  },
  summaryCard: {
    backgroundColor: COLORS.primaryLight,
    borderColor: "#E3D517",
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: "Chillax-Medium",
    marginBottom: 4,
    textTransform: "capitalize",
  },

  // Radial Rings card
  ringsCard: {
    marginTop: 14,
    borderRadius: 24,
    padding: 20,
    overflow: "hidden",
    shadowColor: "rgba(200,160,20,1)",
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  ringsGlow: {
    position: "absolute",
    left: "50%",
    top: -60,
    width: 260,
    height: 260,
    marginLeft: -130,
    borderRadius: 130,
    backgroundColor: "rgba(255,250,200,0.7)",
  },
  ringsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  ringsTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 17,
    letterSpacing: -0.3,
    color: "#1A1A14",
  },
  ringsEntryCount: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.55)",
    letterSpacing: 0.4,
    marginTop: 2,
  },
  ringsPctBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#fff",
    borderColor: "#F5D834",
    borderWidth: 1.5,
  },
  ringsPctText: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 11,
    color: "#1A1A14",
    letterSpacing: 0.4,
  },
  ringsBody: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  ringsSvgWrap: {
    width: 180,
    height: 180,
    flexShrink: 0,
  },
  ringsCenterLabel: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 180,
    height: 180,
    alignItems: "center",
    justifyContent: "center",
  },
  ringsCenterCals: {
    fontFamily: "Chillax-Bold",
    fontSize: 28,
    lineHeight: 28,
    letterSpacing: -0.8,
    color: "#1A1A14",
  },
  ringsCenterUnit: {
    fontFamily: "Inter-Variable",
    fontSize: 9,
    color: "rgba(26,26,20,0.55)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 3,
  },
  ringsCenterGoal: {
    fontFamily: "Inter-Variable",
    fontSize: 10,
    color: "rgba(26,26,20,0.45)",
    marginTop: 2,
    backgroundColor: "#fff",
    borderColor: "#F5D834",
    borderWidth: 1,
  },
  ringsLegend: {
    flex: 1,
    gap: 10,
  },
  ringsLegendItem: {
    gap: 1,
  },
  ringsLegendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  ringsLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  ringsLegendLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 10,
    color: "rgba(26,26,20,0.6)",
    letterSpacing: 0.6,
  },
  ringsLegendValue: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 20,
    letterSpacing: -0.5,
    color: "#1A1A14",
    marginTop: 1,
  },
  ringsLegendUnit: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.45)",
  },
  ringsLegendPct: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.4)",
    letterSpacing: 0,
  },
  // Macro grid
  macroRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  macroItem: {
    alignItems: "center",
    flex: 1,
  },
  macroValue: {
    fontSize: 18,
    fontFamily: "Chillax-Medium",
    color: "#111",
  },
  macroUnit: {
    fontSize: 10,
    fontFamily: "Inter-Variable",
    color: "#555",
  },
  macroLabel: {
    fontSize: 11,
    fontFamily: "Inter-Variable",
    color: "#555",
    marginTop: 2,
  },

  // Summary
  entryCount: {
    fontSize: 12,
    fontFamily: "Chillax-Medium",
    color: "#111",
    textAlign: "right",
  },

  // Log list
  logEntry: {
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#f9f9f9",
  },
  logEntryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  logEntryText: {
    flex: 1,
    marginRight: 12,
  },
  logEntryNameWrapper: {
    alignSelf: "flex-start",
    borderBottomWidth: 1.5,
    borderBottomColor: COLORS.primary,
    marginBottom: 3,
  },
  logEntryNameWrapperActive: {
    borderBottomWidth: 2.5,
    shadowColor: COLORS.primary,
    shadowOpacity: 0.45,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  logEntryName: {
    fontSize: 14,
    fontFamily: "Chillax-Medium",
    textTransform: "capitalize",
  },
  logEntryMacros: {
    fontSize: 12,
    fontFamily: "Inter-Variable",
    color: "#777",
  },
  logEntryTime: {
    fontSize: 11,
    fontFamily: "Inter-Variable",
    color: "#bbb",
    marginTop: 2,
  },
  // Source badge row — sits between macros and timestamp
  sourceBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 5,
    marginBottom: 1,
  },
  sourceBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  sourceBadgeText: {
    fontSize: 10,
    fontFamily: "Inter-Variable",
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  servingDescription: {
    fontSize: 10,
    fontFamily: "Inter-Variable",
    color: "#aaa",
    flexShrink: 1,
  },
  sourceMetaText: {
    fontSize: 10,
    fontFamily: "Inter-Variable",
    color: "#999",
    flexShrink: 1,
  },
  // Log entry action buttons (Edit + Delete stacked)
  logEntryActions: {
    alignItems: "flex-end",
    gap: 6,
  },
  editButton: {
    fontSize: 12,
    color: COLORS.primary,
    fontWeight: "600",
  },

  // Inline edit form
  editInput: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "#111",
    marginBottom: 6,
  },
  editMacroRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 6,
  },
  editMacroField: {
    flex: 1,
  },
  editMacroLabel: {
    fontSize: 10,
    fontFamily: "Inter-Variable",
    color: "#555",
    marginBottom: 3,
  },
  editMacroInput: {
    flex: 1,
    marginBottom: 0,
  },
  editActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  editSaveButton: {
    flex: 1,
    backgroundColor: COLORS.primary,
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: "center",
  },
  editSaveText: {
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "#000",
    fontWeight: "600",
  },
  editCancelButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: "center",
  },
  editCancelText: {
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "#555",
  },

  logsToggle: {
    marginTop: 10,
    alignSelf: "center",
  },
  logsToggleText: {
    fontSize: 12,
    fontFamily: "Inter-Variable",
    color: COLORS.primary,
    fontWeight: "600",
  },

  deleteButton: {
    fontSize: 12,
    color: "#c62828",
    fontWeight: "600",
  },
  deleteButtonDisabled: {
    fontSize: 12,
    color: "#ccc",
    fontWeight: "600",
  },

  // Empty states
  emptyState: {
    marginTop: 10,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "#bbb",
    fontStyle: "italic",
  },

  // Weekly analytics
  weekRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    gap: 8,
  },
  weekLabel: {
    fontSize: 12,
    fontFamily: "Chillax-Regular",
    color: "#555",
    width: 72,
  },
  weekBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: "#eee",
    borderRadius: 4,
    overflow: "hidden",
  },
  weekBarFill: {
    height: 8,
    backgroundColor: COLORS.primary,
    borderRadius: 4,
  },
  weekCalories: {
    fontSize: 12,
    fontFamily: "Chillax-SemiBold",
    color: "#555",
    width: 40,
    textAlign: "right",
  },

  // Feedback
  success: {
    color: "#2e7d32",
    marginTop: 10,
    fontSize: 13,
    fontFamily: "Inter-Variable",
  },
  error: {
    color: "#c62828",
    marginTop: 10,
    fontSize: 13,
    fontFamily: "Inter-Variable",
  },

  // Weekly Glow Line card
  weekGlowCard: {
    marginTop: 14,
    borderRadius: 24,
    padding: 18,
    overflow: "hidden",
    shadowColor: "rgba(200,160,20,1)",
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  weekGlowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 10,
  },
  weekGlowTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 16,
    letterSpacing: -0.3,
    color: "#1A1A14",
  },
  weekGlowAvg: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.55)",
    marginTop: 2,
  },
  weekGlowAvgBold: {
    fontFamily: "Chillax-SemiBold",
    color: "#1A1A14",
  },
  weekGlowGoalBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#fff",
    borderColor: "#F5D834",
    borderWidth: 1.5,
  },
  weekGlowGoalText: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 11,
    color: "#1A1A14",
    letterSpacing: 0.4,
  },
  weekGlowLabels: {
    flexDirection: "row",
    marginTop: 6,
  },
  weekGlowDayLabel: {
    flex: 1,
    textAlign: "center",
    fontFamily: "Chillax-Medium",
    fontSize: 11,
    color: "rgba(26,26,20,0.55)",
  },
  weekGlowDayLabelToday: {
    color: "#1A1A14",
  },

  // Water widget — compact half-width card, left-aligned in a flex row
  widgetRow: {
    flexDirection: "row",
    marginTop: 14,
    gap: 12,
  },
  waterWidgetTap: {
    flex: 1,
  },
  waterWidgetCard: {
    borderRadius: 24,
    padding: 20,
    backgroundColor: "transparent",
    borderColor: "#F5D834",
    borderWidth: 1.5,
    alignItems: "center",
    gap: 8,
  },
  waterWidgetLabel: {
    fontFamily: "Chillax-Medium",
    fontSize: 13,
    color: "#1A1A14",
    letterSpacing: 0.3,
  },
  waterWidgetProgress: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.55)",
  },

  // ── Daily stat strip (water + weight, below the rings card) ──────────────
  dailyStatStrip: {
    flexDirection: "row",
    marginTop: 12,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "#F5D834",
    overflow: "hidden",
  },
  dailyStatHalf: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 10,
  },
  dailyStatSep: {
    width: 1.5,
    backgroundColor: "#F5D834",
  },
  dailyStatContent: {
    flex: 1,
    gap: 2,
  },
  dailyStatTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  dailyStatLabel: {
    fontFamily: "Chillax-Medium",
    fontSize: 12,
    color: "#1A1A14",
    letterSpacing: 0.3,
  },
  dailyStatPct: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.45)",
  },
  dailyStatValue: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 16,
    color: "#1A1A14",
    letterSpacing: -0.3,
  },
  dailyStatUnit: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.5)",
    fontWeight: "400",
  },
  dailyStatEmpty: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.38)",
    fontStyle: "italic",
  },
  dailyStatBar: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(26,26,20,0.08)",
    overflow: "hidden",
    marginTop: 5,
  },
  dailyStatBarFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "#C48A1A",
  },
  dailyStatBarFillMet: {
    backgroundColor: "#2e7d32",
  },

  // Profile loading screen (shown while GET /profile is in-flight)
  profileLoadingSafe: {
    flex: 1,
    backgroundColor: "#FAFAF7",
    alignItems: "center",
    justifyContent: "center",
  },
  profileLoadingText: {
    fontSize: 14,
    fontFamily: "Inter-Variable",
    color: "#555",
  },
});

// ---------------------------------------------------------------------------
// setupStyles — scoped to ProfileSetupScreen and OptionPills.
// Defined after COLORS so it can reference them.
// ---------------------------------------------------------------------------
const setupStyles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#FAFAF7",
  },
  scroll: {
    flex: 1,
  },
  container: {
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 48,
  },
  wordmark: {
    fontFamily: "Chillax-Bold",
    fontSize: 32,
    color: COLORS.primary,
    letterSpacing: -0.8,
    marginBottom: 6,
  },
  headline: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 22,
    color: "#111",
    letterSpacing: -0.4,
    marginBottom: 6,
  },
  subhead: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "#666",
    marginBottom: 32,
    lineHeight: 20,
  },
  label: {
    fontFamily: "Chillax-Medium",
    fontSize: 12,
    color: "#555",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1.5,
    borderColor: "#e5e5e0",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter-Variable",
    color: "#111",
    marginBottom: 20,
  },
  // Narrower variant for numeric fields (age, height, weight)
  inputShort: {
    width: 140,
  },
  // Pill row wraps so long option sets (e.g. activity level) flow onto two lines.
  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 20,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "#ddd",
    backgroundColor: "#fff",
  },
  pillSelected: {
    backgroundColor: "#1A1A14",
    borderColor: "#1A1A14",
  },
  pillText: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "#555",
  },
  pillTextSelected: {
    color: "#F8E94A",
    fontFamily: "Chillax-Medium",
  },
  message: {
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "#c62828",
    marginBottom: 12,
    textAlign: "center",
  },
  saveButton: {
    marginTop: 8,
    height: 56,
    borderRadius: 16,
    backgroundColor: "#1A1A14",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5,
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 17,
    color: "#F8E94A",
    letterSpacing: -0.2,
  },

  // ── Account screen extras ──────────────────────────────────────────────────
  acctBackButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 24,
    alignSelf: "flex-start",
  },
  acctBackText: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "#555",
  },
  acctGreeting: {
    fontFamily: "Chillax-Medium",
    fontSize: 15,
    color: "#555",
    marginTop: -4,
    marginBottom: 24,
  },
  // Override setupStyles.message color for success state
  acctMessageSuccess: {
    color: "#2e7d32",
  },
  acctLogOutButton: {
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#e5e5e0",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  acctLogOutText: {
    fontFamily: "Chillax-Medium",
    fontSize: 15,
    color: "#c62828",
  },
});

// ---------------------------------------------------------------------------
// waterStyles — scoped to WaterIntakeScreen only.
// ---------------------------------------------------------------------------
const waterStyles = StyleSheet.create({
  // ── screen shell ───────────────────────────────────────────────────────────
  gradientRoot: {
    flex: 1,
  },
  safeTransparent: {
    flex: 1,
    backgroundColor: "transparent",
  },

  // ── page header ────────────────────────────────────────────────────────────
  subhead: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "rgba(26,26,20,0.5)",
    marginTop: 4,
    marginBottom: 16,   // was 24 — tighter gap between page subtitle and card
  },

  // ── personalisation / setup card ───────────────────────────────────────────
  setupCard: {
    borderRadius: 20,
    padding: 24,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  setupCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  setupHeading: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 17,
    color: "#1A1A14",
    letterSpacing: -0.3,
  },
  setupBody: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.5)",
    lineHeight: 19,
    marginBottom: 20,
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(26,26,20,0.07)",
    marginBottom: 20,
  },

  // ── question rows ──────────────────────────────────────────────────────────
  questionLabel: {
    fontFamily: "Chillax-Medium",
    fontSize: 14,
    color: "#1A1A14",
    letterSpacing: -0.1,
    marginBottom: 12,
  },

  // ── pill / chip selectors (scoped; mirrors setupStyles but isolated) ────────
  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 20,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#fff",
  },
  pillSelected: {
    backgroundColor: "#1A1A14",
    borderColor: "#1A1A14",
  },
  pillText: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "#555",
  },
  pillTextSelected: {
    color: "#F8E94A",
    fontFamily: "Chillax-Medium",
  },

  // ── helper / hint row ──────────────────────────────────────────────────────
  helperRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: -6,   // tuck up slightly under the chip row
  },
  helperText: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.4)",
    lineHeight: 17,
    flex: 1,
  },

  // ── bottle tracking card ───────────────────────────────────────────────────
  trackCard: {
    marginTop: 16,
    borderRadius: 20,
    padding: 24,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  trackCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,   // was 4 — a touch more air before the subhead
  },
  trackCardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  trackHeading: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 17,
    color: "#1A1A14",
    letterSpacing: -0.3,
  },
  trackSubhead: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.45)",
    marginBottom: 18,   // was 24 — tighter but still breathes before controls
  },

  // stepper
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
    marginBottom: 20,   // was 24 — aligns with quickAddRow.marginBottom
  },
  stepperButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1.5,
    borderColor: "#ddd",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperButtonDisabled: {
    borderColor: "#eee",
  },
  // Shared press-state style applied via Pressable's style callback
  btnPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.97 }],
  },
  stepperCenter: {
    alignItems: "center",
    minWidth: 68,
  },
  stepperCount: {
    fontFamily: "Chillax-Bold",
    fontSize: 52,
    color: "#1A1A14",
    letterSpacing: -1.5,
    lineHeight: 56,
  },
  stepperLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.4)",
    marginTop: 2,
  },

  // total + progress
  ozDisplay: {
    alignItems: "center",
    marginTop: 14,     // was 16 — fractionally tighter after divider
    marginBottom: 14,  // was 16 — fractionally tighter before bar
  },
  ozHero: {
    fontFamily: "Chillax-Bold",
    fontSize: 44,      // was 52 — avoids competing with 52px stepperCount in bottle path;
                       // still dominant in non-bottle path; works better at all sizes
    color: "#1A1A14",
    letterSpacing: -1.5,
    lineHeight: 50,
  },
  ozGoalText: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "rgba(26,26,20,0.38)",
    marginTop: 3,      // was 2 — slightly more separation from hero number
  },
  totalOzMet: {
    color: "#2e7d32",
  },
  progressTrack: {
    height: 7,         // was 6 — slightly more substantial; still slim
    borderRadius: 4,
    backgroundColor: "rgba(26,26,20,0.08)",
    overflow: "hidden",
  },
  progressFill: {
    height: 7,
    borderRadius: 4,
    backgroundColor: "#C48A1A",
  },
  progressFillMet: {
    backgroundColor: "#2e7d32",
  },
  progressLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.4)",
  },
  progressLabelMet: {
    color: "#2e7d32",
  },

  // ── non-bottle quick-add controls ──────────────────────────────────────────
  quickAddRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 20,   // matches stepperRow.marginBottom
  },
  quickAddButton: {
    flex: 1,
    paddingVertical: 13,   // was 12 — slightly taller tap target
    borderRadius: 14,
    backgroundColor: "rgba(26,26,20,0.04)",
    borderWidth: 1,
    borderColor: "rgba(26,26,20,0.08)",   // subtle border for definition on any bg
    alignItems: "center",
  },
  quickAddText: {
    fontFamily: "Chillax-Medium",
    fontSize: 14,
    color: "#1A1A14",
    letterSpacing: -0.1,
  },
  progressFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,      // was 6 — a bit more space after the progress bar
  },
  resetLink: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.35)",
  },

  highWaterWarning: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: 14,
    backgroundColor: "#fff8e1",
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 11,
  },
  highWaterWarningText: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#7a4a00",
    flex: 1,
    lineHeight: 17,
  },

  // Save button — shown at the bottom of setup/edit mode
  saveButton: {
    marginTop: 20,
    backgroundColor: "#1A1A14",
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  saveButtonText: {
    fontFamily: "Chillax-Medium",
    fontSize: 15,
    color: "#fff",
  },

  // ── last 7 days chart card ─────────────────────────────────────────────────
  weekCard: {
    marginTop: 12,
    borderRadius: 16,
    paddingHorizontal: 20,  // was 18 — slightly wider side margins
    paddingTop: 22,         // was 18 — more air above the title
    paddingBottom: 22,      // was 18 — more air below the labels
    backgroundColor: "rgba(255,255,255,0.75)",
    borderWidth: 1,
    borderColor: "rgba(196,138,26,0.18)",
  },
  weekHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 5,        // was 2 — more separation between title and subtitle
  },
  weekHeading: {
    fontFamily: "Chillax-Medium",
    fontSize: 14,
    color: "#1A1A14",
    letterSpacing: -0.1,
  },
  weekSubhead: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.4)",
    marginBottom: 24,       // was 20 — clearer break between subtitle and chart
  },
  weekChartTrack: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,                 // was 5 — clearer separation between bars
  },
  weekBarSlot: {
    flex: 1,
    alignItems: "center",
    gap: 7,                 // was 5 — more breathing room between bar bottom and label
  },
  weekBarTrack: {
    width: "100%",
    borderRadius: 5,
    backgroundColor: "rgba(26,26,20,0.05)",
    overflow: "hidden",
    justifyContent: "flex-end",  // bars grow from the bottom
  },
  weekBarFill: {
    width: "100%",
    borderRadius: 5,
  },
  weekDayLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.35)",
  },
  weekDayLabelToday: {
    color: "#C48A1A",
    fontFamily: "Chillax-Medium",
  },
  weekEmptyText: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.38)",
    textAlign: "center",
    marginTop: 14,          // was 10 — more separation below empty-state bars
    lineHeight: 17,
  },

  // ── hydration streak card ──────────────────────────────────────────────────
  streakCard: {
    marginTop: 12,
    borderRadius: 16,
    padding: 18,
    backgroundColor: "rgba(255,255,255,0.75)",
    borderWidth: 1,
    borderColor: "rgba(196,138,26,0.18)",
  },
  streakHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  streakHeading: {
    fontFamily: "Chillax-Medium",
    fontSize: 14,
    color: "#1A1A14",
    letterSpacing: -0.1,
  },
  streakCount: {
    fontFamily: "Chillax-Bold",
    fontSize: 26,
    color: "#1A1A14",
    letterSpacing: -0.8,
    lineHeight: 30,
    marginBottom: 4,
  },
  streakBody: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.45)",
    lineHeight: 18,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// WeightScreen
// ─────────────────────────────────────────────────────────────────────────────

type WeightLogEntry = {
  log_date: string;
  weight_kg: number;
};

function formatWeightDate(dateStr: string): string {
  const today     = localToday();
  const yesterday = (() => {
    const d = parseDateStringToLocalDate(today);
    d.setDate(d.getDate() - 1);
    return formatDateToLocalYYYYMMDD(d);
  })();
  if (dateStr === today)     return "Today";
  if (dateStr === yesterday) return "Yesterday";
  const d = parseDateStringToLocalDate(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type WeightPrediction = {
  latest_weight_kg:        number | null;
  weight_log_date:         string | null;
  bmr:                     number | null;
  tdee:                    number | null;
  avg_daily_calories:      number | null;
  days_logged:             number;
  days_in_window:          number;
  daily_balance:           number | null;
  weekly_change_kg:        number | null;
  projected_change_30d_kg: number | null;
  projected_weight_30d_kg: number | null;
  confidence:              "high" | "medium" | "low";
  confidence_note:         string;
};

// kg ↔ display-unit helpers — weight_logs always stores kg.
const kgToDisplay = (kg: number, u: "kg" | "lb"): number =>
  u === "lb" ? Math.round(kg * 2.20462 * 10) / 10 : Math.round(kg * 10) / 10;

const displayToKg = (val: number, u: "kg" | "lb"): number =>
  u === "lb" ? val / 2.20462 : val;

function WeightScreen({ onBack }: { onBack: () => void }) {
  const [userId,  setUserId]  = useState<string | null>(null);
  const [unit,    setUnit]    = useState<"kg" | "lb">("kg");
  const [input,   setInput]   = useState("");
  const [todayKg, setTodayKg] = useState<number | null>(null); // canonical kg
  const [history, setHistory] = useState<WeightLogEntry[]>([]);
  const [saving,     setSaving]     = useState(false);
  const [loaded,     setLoaded]     = useState(false);
  const [message,    setMessage]    = useState("");
  const [prediction, setPrediction] = useState<WeightPrediction | null>(null);
  const [predLoading,setPredLoading]= useState(false);

  const parsedDisplay = parseFloat(input);
  const parsedKg      = !isNaN(parsedDisplay) ? displayToKg(parsedDisplay, unit) : NaN;
  const inputValid    = !isNaN(parsedKg) && parsedKg >= 20 && parsedKg <= 500;

  // loadData accepts the active unit so input is set in the right unit after
  // load or save, without relying on stale closure state.
  const loadData = async (uid: string, activeUnit: "kg" | "lb") => {
    try {
      const { data: rows } = await supabase
        .from("weight_logs")
        .select("log_date, weight_kg")
        .eq("user_id", uid)
        .order("log_date", { ascending: false })
        .limit(7);

      const entries: WeightLogEntry[] = (rows ?? []).map(r => ({
        log_date:  r.log_date,
        weight_kg: Number(r.weight_kg),
      }));
      setHistory(entries);

      const todayEntry = entries.find(e => e.log_date === localToday());
      if (todayEntry) {
        setTodayKg(todayEntry.weight_kg);
        setInput(String(kgToDisplay(todayEntry.weight_kg, activeUnit)));
      }
    } catch {
      // silently ignore
    } finally {
      setLoaded(true);
    }
  };

  const fetchPrediction = async () => {
    setPredLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const res = await axios.get<WeightPrediction>(`${API_URL}/prediction/weight`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      setPrediction(res.data);
    } catch {
      // silently ignore — card stays hidden
    } finally {
      setPredLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoaded(true); return; }
      setUserId(user.id);
      // Run weight-log load and prediction fetch in parallel.
      await Promise.all([loadData(user.id, "kg"), fetchPrediction()]);
    })();
  }, []);

  // When the unit toggle is tapped, convert the current input value in-place.
  const switchUnit = (newUnit: "kg" | "lb") => {
    if (newUnit === unit) return;
    const parsed = parseFloat(input);
    if (!isNaN(parsed) && parsed > 0) {
      const asKg      = displayToKg(parsed, unit);
      const converted = kgToDisplay(asKg, newUnit);
      setInput(String(converted));
    }
    setUnit(newUnit);
  };

  const saveWeight = async () => {
    if (!userId || !inputValid) return;
    setSaving(true);
    setMessage("");
    try {
      const { error } = await supabase.from("weight_logs").upsert({
        user_id:    userId,
        log_date:   localToday(),
        weight_kg:  Math.round(parsedKg * 100) / 100, // 2 d.p., stored as kg
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,log_date" });

      if (error) throw error;
      setTodayKg(Math.round(parsedKg * 100) / 100);
      await Promise.all([loadData(userId, unit), fetchPrediction()]);
    } catch {
      setMessage("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <LinearGradient
      colors={["#FFFEF8", "#FFF8D4", "#FDF3B0"]}
      locations={[0, 0.5, 1]}
      start={{ x: 0.15, y: 0 }}
      end={{ x: 0.85, y: 1 }}
      style={waterStyles.gradientRoot}
    >
      <SafeAreaView style={waterStyles.safeTransparent}>
        <ScrollView
          style={setupStyles.scroll}
          contentContainerStyle={setupStyles.container}
          keyboardShouldPersistTaps="handled"
        >
          {/* Back */}
          <TouchableOpacity
            onPress={onBack}
            style={setupStyles.acctBackButton}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={18} color="#555" />
            <Text style={setupStyles.acctBackText}>Back</Text>
          </TouchableOpacity>

          <Text style={setupStyles.headline}>Weight</Text>
          <Text style={weightStyles.subhead}>Log your weight to track progress over time.</Text>

          {/* ── Log today's weight ─────────────────────────────────────── */}
          {loaded && (
            <View style={weightStyles.card}>
              <View style={weightStyles.cardHeaderRow}>
                <View style={weightStyles.cardHeader}>
                  <Ionicons name="trending-up-outline" size={19} color="#C48A1A" />
                  <Text style={weightStyles.cardHeading}>
                    {todayKg != null ? "Today's weight" : "Log today's weight"}
                  </Text>
                </View>
                {/* Unit segmented control */}
                <View style={weightStyles.unitToggle}>
                  {(["kg", "lb"] as const).map(u => (
                    <TouchableOpacity
                      key={u}
                      style={[weightStyles.unitSegment, unit === u && weightStyles.unitSegmentActive]}
                      onPress={() => switchUnit(u)}
                      activeOpacity={0.75}
                    >
                      <Text style={[weightStyles.unitSegmentText, unit === u && weightStyles.unitSegmentTextActive]}>
                        {u}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {todayKg != null && (
                <Text style={weightStyles.savedDisplay}>
                  {kgToDisplay(todayKg, unit)} {unit}
                </Text>
              )}

              <View style={weightStyles.inputRow}>
                <TextInput
                  style={weightStyles.weightInput}
                  value={input}
                  onChangeText={t => { setInput(t); setMessage(""); }}
                  placeholder={unit === "kg" ? "e.g. 72.5" : "e.g. 160"}
                  placeholderTextColor="rgba(26,26,20,0.3)"
                  keyboardType="decimal-pad"
                  returnKeyType="done"
                  maxLength={7}
                  inputAccessoryViewID="weight-input-accessory"
                />
                <Text style={weightStyles.unitLabel}>{unit}</Text>
              </View>
              {/* Empty accessory view suppresses the iOS keyboard toolbar Done button */}
              {Platform.OS === "ios" && (
                <InputAccessoryView nativeID="weight-input-accessory" />
              )}

              {message !== "" && (
                <Text style={weightStyles.errorText}>{message}</Text>
              )}

              <TouchableOpacity
                style={[
                  weightStyles.saveBtn,
                  (!inputValid || saving) && weightStyles.saveBtnDisabled,
                ]}
                onPress={saveWeight}
                disabled={!inputValid || saving}
                activeOpacity={0.8}
              >
                <Text style={weightStyles.saveBtnText}>
                  {saving ? "Saving…" : todayKg != null ? "Update" : "Save"}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Recent entries ─────────────────────────────────────────── */}
          {loaded && history.length > 0 && (
            <View style={weightStyles.historyCard}>
              <View style={weightStyles.cardHeader}>
                <Ionicons name="time-outline" size={17} color="#C48A1A" />
                <Text style={weightStyles.cardHeading}>Recent entries</Text>
              </View>

              {history.map((entry, i) => (
                <View
                  key={entry.log_date}
                  style={[
                    weightStyles.historyRow,
                    i < history.length - 1 && weightStyles.historyRowBorder,
                  ]}
                >
                  <Text style={weightStyles.historyDate}>
                    {formatWeightDate(entry.log_date)}
                  </Text>
                  <Text style={weightStyles.historyKg}>
                    {kgToDisplay(entry.weight_kg, unit)} {unit}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {loaded && history.length === 0 && (
            <Text style={weightStyles.emptyText}>
              No entries yet. Log your weight above to get started.
            </Text>
          )}

          {/* ── What to expect (prediction) ────────────────────────────── */}
          {predLoading && (
            <View style={weightStyles.predCard}>
              <Text style={weightStyles.predLoading}>Loading prediction…</Text>
            </View>
          )}

          {!predLoading && prediction && (() => {
            const isLow = prediction.confidence === "low";
            const badgeStyle = prediction.confidence === "high"
              ? weightStyles.badgeHigh
              : prediction.confidence === "medium"
                ? weightStyles.badgeMedium
                : weightStyles.badgeLow;
            const badgeTextStyle = prediction.confidence === "high"
              ? weightStyles.badgeTextHigh
              : prediction.confidence === "medium"
                ? weightStyles.badgeTextMedium
                : weightStyles.badgeTextLow;

            const fmtKcal = (v: number | null) =>
              v != null ? `${Math.round(v)} kcal/day` : "—";

            const fmtWeekly = (v: number | null) => {
              if (v === null) return "—";
              const display = kgToDisplay(Math.abs(v), unit);
              const sign    = v > 0 ? "+" : v < 0 ? "−" : "";
              return `${sign}${display} ${unit}/week`;
            };

            const weeklyColor = prediction.weekly_change_kg === null
              ? weightStyles.predValueNeutral
              : prediction.weekly_change_kg < 0
                ? weightStyles.predValueLoss
                : prediction.weekly_change_kg > 0
                  ? weightStyles.predValueGain
                  : weightStyles.predValueNeutral;

            return (
              <View style={[weightStyles.predCard, isLow && weightStyles.predCardMuted]}>
                <View style={weightStyles.cardHeader}>
                  <Ionicons name="analytics-outline" size={17} color="#C48A1A" />
                  <Text style={weightStyles.cardHeading}>What to expect</Text>
                </View>

                {/* Intake vs TDEE */}
                <View style={weightStyles.predRow}>
                  <Text style={weightStyles.predLabel}>Avg intake</Text>
                  <Text style={weightStyles.predValue}>{fmtKcal(prediction.avg_daily_calories)}</Text>
                </View>
                <View style={weightStyles.predRow}>
                  <Text style={weightStyles.predLabel}>Est. TDEE</Text>
                  <Text style={weightStyles.predValue}>
                    {prediction.tdee != null ? `~${Math.round(prediction.tdee)} kcal/day` : "—"}
                  </Text>
                </View>

                <View style={weightStyles.predDivider} />

                {/* Weekly rate */}
                <View style={weightStyles.predRow}>
                  <Text style={weightStyles.predLabel}>At this rate</Text>
                  <Text style={[weightStyles.predValue, weeklyColor]}>
                    {fmtWeekly(prediction.weekly_change_kg)}
                  </Text>
                </View>

                {/* 30-day projection */}
                <View style={weightStyles.predRow}>
                  <Text style={weightStyles.predLabel}>In 30 days</Text>
                  <Text style={weightStyles.predValue}>
                    {prediction.projected_weight_30d_kg != null
                      ? `~${kgToDisplay(prediction.projected_weight_30d_kg, unit)} ${unit}`
                      : "—"}
                  </Text>
                </View>

                <View style={weightStyles.predDivider} />

                {/* Confidence */}
                <View style={weightStyles.predConfRow}>
                  <View style={[weightStyles.confBadge, badgeStyle]}>
                    <Text style={[weightStyles.confBadgeText, badgeTextStyle]}>
                      {prediction.confidence} confidence
                    </Text>
                  </View>
                </View>
                <Text style={weightStyles.predNote}>{prediction.confidence_note}</Text>
              </View>
            );
          })()}
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

// weightStyles — scoped to WeightScreen only.
const weightStyles = StyleSheet.create({
  subhead: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "rgba(26,26,20,0.5)",
    marginTop: 4,
    marginBottom: 20,
  },
  card: {
    borderRadius: 20,
    padding: 24,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
    marginBottom: 16,
  },
  // Header row: title on the left, unit toggle on the right
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  unitToggle: {
    flexDirection: "row",
    backgroundColor: "rgba(26,26,20,0.06)",
    borderRadius: 8,
    padding: 2,
  },
  unitSegment: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  unitSegmentActive: {
    backgroundColor: "#1A1A14",
  },
  unitSegmentText: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.45)",
  },
  unitSegmentTextActive: {
    color: "#F8E94A",
    fontFamily: "Chillax-Medium",
  },
  historyCard: {
    borderRadius: 20,
    padding: 24,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  cardHeading: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 16,
    color: "#1A1A14",
    letterSpacing: -0.3,
  },
  savedDisplay: {
    fontFamily: "Chillax-Bold",
    fontSize: 32,
    color: "#1A1A14",
    letterSpacing: -1,
    marginBottom: 16,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
  },
  weightInput: {
    flex: 1,
    backgroundColor: "#FAFAF7",
    borderWidth: 1.5,
    borderColor: "#e5e5e0",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 18,
    fontFamily: "Inter-Variable",
    color: "#1A1A14",
  },
  unitLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "rgba(26,26,20,0.45)",
    width: 24,
  },
  errorText: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#c62828",
    marginBottom: 10,
  },
  saveBtn: {
    backgroundColor: "#1A1A14",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  saveBtnDisabled: {
    opacity: 0.4,
  },
  saveBtnText: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 16,
    color: "#F8E94A",
    letterSpacing: -0.2,
  },
  historyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
  },
  historyRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: "rgba(26,26,20,0.07)",
  },
  historyDate: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "rgba(26,26,20,0.6)",
  },
  historyKg: {
    fontFamily: "Chillax-Medium",
    fontSize: 15,
    color: "#1A1A14",
    letterSpacing: -0.2,
  },
  emptyText: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.4)",
    textAlign: "center",
    marginTop: 24,
    lineHeight: 19,
  },

  // ── Prediction card ────────────────────────────────────────────────────────
  predCard: {
    borderRadius: 20,
    padding: 24,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
    marginTop: 16,
  },
  predCardMuted: {
    opacity: 0.72,
  },
  predLoading: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.4)",
    textAlign: "center",
    paddingVertical: 12,
  },
  predRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
  },
  predLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.55)",
  },
  predValue: {
    fontFamily: "Chillax-Medium",
    fontSize: 14,
    color: "#1A1A14",
    letterSpacing: -0.1,
  },
  predValueLoss: {
    color: "#2e7d32",
  },
  predValueGain: {
    color: "#C48A1A",
  },
  predValueNeutral: {
    color: "#1A1A14",
  },
  predDivider: {
    height: 1,
    backgroundColor: "rgba(26,26,20,0.07)",
    marginVertical: 6,
  },
  predConfRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
  },
  confBadge: {
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  confBadgeText: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    letterSpacing: 0.2,
  },
  badgeHigh:     { backgroundColor: "#e8f5e9" },
  badgeMedium:   { backgroundColor: "#fff8e1" },
  badgeLow:      { backgroundColor: "#fce4ec" },
  badgeTextHigh: { color: "#2e7d32" },
  badgeTextMedium: { color: "#7a4a00" },
  badgeTextLow:  { color: "#b71c1c" },
  predNote: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.4)",
    lineHeight: 16,
    marginTop: 4,
  },
});

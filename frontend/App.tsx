import React, { useState, useEffect, useRef, useCallback } from "react";
import MapView, { Callout, Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import * as Location from "expo-location";
import { Keyboard, KeyboardAvoidingView, Platform, Modal, Linking, InputAccessoryView } from "react-native";
import HomepageHero from "./components/HomepageHero";
import { CameraView, useCameraPermissions } from "expo-camera";
const barcodIcon = require("./assets/barcode.png");
import { useFonts } from "expo-font";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import Slider from "@react-native-community/slider";
import {
  ActivityIndicator,
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
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Circle, G, Defs, LinearGradient as SvgLinearGradient, Stop, Line as SvgLine, Path as SvgPath, Text as SvgText, Polyline as SvgPolyline } from "react-native-svg";
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
  goal_weight_kg:       number | null;
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
  const tabScrollRef = useRef<ScrollView>(null);
  const sidebarAnim  = useRef(new Animated.Value(0)).current;  // 0 = closed, 1 = open
  // Solar Bloom animated glow values — each loops 0→1→0 at a different duration
  const glowOuter   = useRef(new Animated.Value(0)).current;  // 7 s
  const glowMid     = useRef(new Animated.Value(0)).current;  // 5.5 s
  const glowCore    = useRef(new Animated.Value(0)).current;  // 4 s
  const glowShimmer = useRef(new Animated.Value(0)).current;  // 6.5 s
  const tabAnim     = useRef(new Animated.Value(0)).current;  // 0 = home, 1 = weight
  const [weeklyData,    setWeeklyData]    = useState<WeeklyDay[]>([]);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [weeklyError,   setWeeklyError]   = useState(false);
  const [foodStreak,    setFoodStreak]    = useState<number>(0);
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
  const [isMultiLogOpen, setIsMultiLogOpen] = useState(false);
  const [homeWeightKg,     setHomeWeightKg]     = useState<number | null>(null);
  const [homeUserLocation, setHomeUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [homeWeightPrevKg, setHomeWeightPrevKg] = useState<number | null>(null);
  const [homePrediction,   setHomePrediction]   = useState<WeightPrediction | null>(null);
  const [homePredLoading,  setHomePredLoading]  = useState(false);
  const [homeWeightLogs,   setHomeWeightLogs]   = useState<WeightLogEntry[]>([]);
  const [currentPage,        setCurrentPage]        = useState<"home" | "weight" | "cardio">("home");
  const [isRoutePlannerOpen,  setIsRoutePlannerOpen]  = useState(false);
  const [isWorkoutLogOpen,    setIsWorkoutLogOpen]    = useState(false);
  const [wlActivity,          setWlActivity]          = useState<"run"|"walk"|"bike"|"swim"|"other">("run");
  const [wlDistanceStr,       setWlDistanceStr]       = useState("");
  const [wlDurationStr,       setWlDurationStr]       = useState("");
  const [wlUnit,              setWlUnit]              = useState<"km"|"mi">("km");
  const [wlSaving,            setWlSaving]            = useState(false);

  const { width: screenW } = useWindowDimensions();
  const [tabBarW, setTabBarW] = useState(screenW - 40);
  // Natural tab widths measured via onLayout — lets tabs sit close together.
  const [tab0W, setTab0W] = useState(0);
  const [tab1W, setTab1W] = useState(0);
  const [tab2W, setTab2W] = useState(0);
  const homeTabOpacity   = tabAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [1,    0.22, 0.22] });
  const weightTabOpacity = tabAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [0.22, 1,    0.22] });
  const cardioTabOpacity = tabAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [0.22, 0.22, 1   ] });
  const homeTabScale     = tabAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [1,    0.78, 0.78] });
  const weightTabScale   = tabAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [0.78, 1,    0.78] });
  const cardioTabScale   = tabAnim.interpolate({ inputRange: [0, 1, 2], outputRange: [0.78, 0.78, 1   ] });
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
        .limit(2);
      setHomeWeightKg(data?.[0]?.weight_kg ?? null);
      setHomeWeightPrevKg(data?.[1]?.weight_kg ?? null);
    } catch {
      // silently ignore — widget keeps last known value
    }
  };

  const fetchHomePrediction = async () => {
    setHomePredLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await axios.get<WeightPrediction>(`${API_URL}/prediction/weight`, { headers });
      setHomePrediction(res.data);
    } catch {
      // silently ignore — card stays hidden
    } finally {
      setHomePredLoading(false);
    }
  };

  const fetchFoodStreak = async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await axios.get<{ streak: number }>(`${API_URL}/dashboard/food-streak`, { headers });
      setFoodStreak(res.data.streak);
    } catch {
      // silently ignore — streak stays at last known value
    }
  };

  const fetchHomeWeightLogs = async () => {
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      if (!s?.user?.id) return;
      const { data: rows } = await supabase
        .from("weight_logs")
        .select("log_date, weight_kg")
        .eq("user_id", s.user.id)
        .order("log_date", { ascending: false })
        .limit(120);
      setHomeWeightLogs((rows ?? []).map(r => ({ log_date: r.log_date, weight_kg: Number(r.weight_kg) })));
    } catch {
      // silently ignore
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

  // Drive the tab bar opacity/scale and scroll position whenever page changes.
  useEffect(() => {
    const toValue = currentPage === "home" ? 0 : currentPage === "weight" ? 1 : 2;
    Animated.spring(tabAnim, {
      toValue,
      useNativeDriver: true,
      friction: 8,
      tension: 70,
    }).start();
    if (tab0W > 0 && tab1W > 0 && tab2W > 0) {
      const TAB_GAP = 36;
      let x: number;
      if (currentPage === "home") {
        x = tab0W / 2;
      } else if (currentPage === "weight") {
        x = tab0W + TAB_GAP + tab1W / 2;
      } else {
        x = tab0W + TAB_GAP + tab1W + TAB_GAP + tab2W / 2;
      }
      tabScrollRef.current?.scrollTo({ x, animated: true });
    }
  }, [currentPage, tab0W, tab1W, tab2W]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const res = await axios.post(`${API_URL}/food/search`, { query: foodQuery }, { headers: await getAuthHeaders() });
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
      fetchHomePrediction();
      fetchFoodStreak();
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
      fetchHomePrediction();
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
      fetchHomePrediction();
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
    setWeeklyError(false);
    try {
      const res = await axios.get(`${API_URL}/dashboard/weekly`, {
        headers: await getAuthHeaders(),
      });
      setWeeklyData(res.data);
    } catch {
      setWeeklyError(true);
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
      setHomePrediction(null);
      setHomeWeightLogs([]);
    } else {
      loadWeekly();
      loadTodayCalories();
      fetchHomeWaterSummary();
      fetchHomeWeightSummary();
      fetchHomePrediction();
      fetchHomeWeightLogs();
      fetchFoodStreak();
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

  // Refresh the homepage weight widget and prediction whenever the weight screen is dismissed.
  useEffect(() => {
    if (!isWeightOpen && session?.access_token) {
      fetchHomeWeightSummary();
      fetchHomePrediction();
      fetchHomeWeightLogs();
    }
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
        const res  = await axios.post(`${API_URL}/food/barcode`, { barcode }, { headers: await getAuthHeaders() });
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
          fetchHomePrediction();
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

    // ── Mode: forgot password ──
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

    // ── Mode: login (default) — HomepageHero with Three.js background ──
    return (
      <HomepageHero
        onForgotPassword={() => { setAuthMode("forgot"); setResetEmail(""); setAuthMessage(""); }}
      />
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

  // ── Multi-food log screen ─────────────────────────────────────────────────
  if (isMultiLogOpen) {
    return (
      <MultiLogScreen
        selectedDate={selectedDate}
        onBack={() => setIsMultiLogOpen(false)}
        onDone={() => {
          setIsMultiLogOpen(false);
          Promise.all([loadSummary(), loadLogs(), loadWeekly(), loadTodayCalories()]);
          fetchHomePrediction();
        }}
      />
    );
  }

  // ── Tracker screen (logged in) ──────────────────────────────────────────────
  // profile is guaranteed non-null here (the setup gate above would have caught it).
  const calorieGoal = profile ? computeCalorieTarget(profile) : CALORIE_GOAL;

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient
        colors={["#FFFEF8", "#FFF8D4", "#FDF3B0"]}
        locations={[0, 0.5, 1]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={StyleSheet.absoluteFillObject}
        pointerEvents="none"
      />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.container}
        scrollEnabled={true}
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
          <Animated.View pointerEvents="none" style={[styles.headerGlowOuter, {
            opacity: glowOuter.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.85] }),
            transform: [{ scale: glowOuter.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) }],
          }]} />
          <Animated.View pointerEvents="none" style={[styles.headerGlowMid, {
            opacity: glowMid.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
            transform: [{ scale: glowMid.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }) }],
          }]} />
          <TouchableOpacity onPress={() => setIsSidebarOpen(true)} activeOpacity={0.8}>
            <Image
              source={require("./assets/Lume.png")}
              style={styles.logo}
              resizeMode="contain"
            />
          </TouchableOpacity>
        </View>

        {/* Page tab scroller — negative margin escapes padding:20 so the
            ScrollView is full screen width. Half-screen padding on each side
            lets any tab be scrolled to the exact center. */}
        <ScrollView
          ref={tabScrollRef}
          horizontal
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          onLayout={(e) => setTabBarW(e.nativeEvent.layout.width)}
          contentContainerStyle={{ paddingHorizontal: tabBarW / 2 }}
          style={[styles.pageTabBar, { marginHorizontal: -20 }]}
        >
          <TouchableOpacity
            onLayout={(e) => setTab0W(e.nativeEvent.layout.width)}
            style={styles.pageTabItem}
            onPress={() => setCurrentPage("home")}
            activeOpacity={1}
          >
            <Animated.Text style={[styles.pageTabText, { opacity: homeTabOpacity, transform: [{ scale: homeTabScale }] }]}>
              Home
            </Animated.Text>
          </TouchableOpacity>
          <View style={{ width: 36 }} />
          <TouchableOpacity
            onLayout={(e) => setTab1W(e.nativeEvent.layout.width)}
            style={styles.pageTabItem}
            onPress={() => setCurrentPage("weight")}
            activeOpacity={1}
          >
            <Animated.Text style={[styles.pageTabText, { opacity: weightTabOpacity, transform: [{ scale: weightTabScale }] }]}>
              Weight Projection
            </Animated.Text>
          </TouchableOpacity>
          <View style={{ width: 36 }} />
          <TouchableOpacity
            onLayout={(e) => setTab2W(e.nativeEvent.layout.width)}
            style={styles.pageTabItem}
            onPress={() => setCurrentPage("cardio")}
            activeOpacity={1}
          >
            <Animated.Text style={[styles.pageTabText, { opacity: cardioTabOpacity, transform: [{ scale: cardioTabScale }] }]}>
              Cardio
            </Animated.Text>
          </TouchableOpacity>
        </ScrollView>

        {currentPage === "home" && (
          <>

        {/* Greeting */}
        <GreetingHeader
          displayName={profile?.display_name ?? null}
          todayCalories={todayCalories}
          calorieGoal={calorieGoal}
        />

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
          {!summaryLoading && summary && (
            <CalorieProgressBar consumed={summary.total_calories} goal={calorieGoal} />
          )}
          {!summaryLoading && summary && (
            <MacroPills
              protein={summary.total_protein}
              carbs={summary.total_carbs}
              fat={summary.total_fat}
              calorieGoal={calorieGoal}
            />
          )}
          {!summaryLoading && summary && weeklyData.length > 0 && (
            <DailyInsight
              summary={summary}
              calorieGoal={calorieGoal}
              weeklyData={weeklyData}
            />
          )}

          {/* Water + Weight compact strip */}
          <View style={styles.dailyStatStrip}>
            <TouchableOpacity style={styles.dailyStatHalf} onPress={() => setIsWaterOpen(true)} activeOpacity={0.8}>
              <Ionicons
                name="water-outline"
                size={16}
                color={homeWaterOz >= homeWaterGoalOz ? "#29B6F6" : "#1A1A14"}
              />
              <View style={styles.dailyStatContent}>
                <View style={styles.dailyStatTopRow}>
                  <Text style={styles.dailyStatLabel}>Water</Text>
                  <Text style={[
                    styles.dailyStatPct,
                    homeWaterOz >= homeWaterGoalOz && { color: "#29B6F6" },
                  ]}>
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
                  <>
                    <Text style={styles.dailyStatValue}>
                      {homeWeightKg}{" "}
                      <Text style={styles.dailyStatUnit}>kg</Text>
                    </Text>
                    {homeWeightPrevKg != null && (() => {
                      const delta = Math.round((homeWeightKg - homeWeightPrevKg) * 10) / 10;
                      if (delta === 0) return null;
                      const up = delta > 0;
                      return (
                        <Text style={{ fontSize: 11, fontFamily: "Inter-Variable", color: up ? "#E57373" : "#66BB6A", marginTop: 2 }}>
                          {up ? "▲" : "▼"} {Math.abs(delta)} kg
                        </Text>
                      );
                    })()}
                  </>
                ) : (
                  <Text style={styles.dailyStatEmpty}>Tap to log</Text>
                )}
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Streak */}
        {foodStreak > 0 && <StreakCard streak={foodStreak} />}

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
          {!weeklyLoading && weeklyError && weeklyData.length === 0 && (
            <Text style={styles.error}>Couldn't load weekly data. Pull down to retry.</Text>
          )}
          {weeklyData.length > 0 && <WeeklyGlowLine data={weeklyData} goal={calorieGoal} />}
        </View>

          </>
        )}

        {currentPage === "weight" && (() => {
          if (homePredLoading && !homePrediction) {
            return (
              <View style={styles.section}>
                <Text style={styles.predCardLoading}>Loading projection…</Text>
              </View>
            );
          }
          if (!homePrediction) {
            return (
              <View style={styles.section}>
                <Text style={styles.predCardLoading}>
                  Log food and weight to see your projection.
                </Text>
              </View>
            );
          }
          const p = homePrediction;
          const isLow = p.confidence === "low";

          const fmtWeekly = (v: number | null) => {
            if (v === null) return "—";
            const abs = Math.round(Math.abs(v) * 10) / 10;
            const sign = v > 0 ? "+" : v < 0 ? "−" : "";
            return `${sign}${abs} kg/wk`;
          };

          const weeklyColor = p.weekly_change_kg === null
            ? styles.predStatNeutral
            : p.weekly_change_kg < 0
              ? styles.predStatLoss
              : p.weekly_change_kg > 0
                ? styles.predStatGain
                : styles.predStatNeutral;

          const badgeStyle = p.confidence === "high"
            ? styles.predBadgeHigh
            : p.confidence === "medium"
              ? styles.predBadgeMedium
              : styles.predBadgeLow;
          const badgeTextStyle = p.confidence === "high"
            ? styles.predBadgeTextHigh
            : p.confidence === "medium"
              ? styles.predBadgeTextMedium
              : styles.predBadgeTextLow;

          // Goal headline — three states: reached / on track / off track
          const goalHeadline = !isLow && p.goal_weight_kg != null && p.goal_direction != null ? (
            p.goal_direction === "maintain" ? (
              <LinearGradient
                colors={["#E8F5E9", "#C8E6C9"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.goalHeadlineCard}
              >
                <Text style={styles.goalHeadlineEmoji}>🎉</Text>
                <Text style={styles.goalHeadlineTitle}>Goal reached!</Text>
                <Text style={styles.goalHeadlineSub}>You're at your target weight. Keep it up.</Text>
              </LinearGradient>
            ) : p.projected_goal_date != null && p.estimated_weeks_to_goal != null ? (
              <LinearGradient
                colors={["#FFF8D4", "#FDEFA5", "#F7DF6A"]}
                locations={[0, 0.55, 1]}
                start={{ x: 0.1, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.goalHeadlineCard}
              >
                <Text style={styles.goalHeadlineSub}>At your current pace</Text>
                <Text style={styles.goalHeadlineDate}>
                  {new Date(p.projected_goal_date + "T00:00:00").toLocaleDateString("en-US", {
                    month: "long", day: "numeric", year: "numeric",
                  })}
                </Text>
                <Text style={styles.goalHeadlineSub}>
                  ~{Math.round(p.estimated_weeks_to_goal)} weeks away · {p.goal_weight_kg} kg goal
                </Text>
              </LinearGradient>
            ) : (
              <View style={styles.goalOffTrackCard}>
                <Ionicons name="trending-down" size={18} color="#92400E" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.goalOffTrackTitle}>Not on track for your goal</Text>
                  <Text style={styles.goalOffTrackBody}>
                    You're currently {p.goal_direction === "lose" ? "gaining" : "losing"} weight.
                    Adjust your intake to move toward your {p.goal_weight_kg} kg goal.
                  </Text>
                </View>
              </View>
            )
          ) : null;

          // Has the user logged their weight today?
          const hasLoggedToday = homeWeightLogs.some(e => e.log_date === localToday());

          // Weekly consistency — did at least one log exist in each of the last 7 weeks?
          const nowMs = Date.UTC(
            new Date().getFullYear(), new Date().getMonth(), new Date().getDate()
          );
          // oldest week first (index 0 = 42–48 days ago, index 6 = 0–6 days ago)
          const weekLogged = Array.from({ length: 7 }, (_, wi) => {
            const startDay = (6 - wi) * 7;
            const endDay   = startDay + 6;
            return homeWeightLogs.some(e => {
              const [y, mo, d] = e.log_date.split("-").map(Number);
              const daysAgo = Math.round((nowMs - Date.UTC(y, mo - 1, d)) / 86400000);
              return daysAgo >= startDay && daysAgo <= endDay;
            });
          });
          const weeksLoggedCount = weekLogged.filter(Boolean).length;

          return (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>WEIGHT PROJECTION</Text>

              {goalHeadline}

              {/* Nudge to log today's weight — taps straight into WeightScreen */}
              {!hasLoggedToday && (
                <TouchableOpacity
                  style={styles.weightNudgeCard}
                  onPress={() => setIsWeightOpen(true)}
                  activeOpacity={0.8}
                >
                  <View style={styles.weightNudgeLeft}>
                    <Ionicons name="scale-outline" size={20} color="#C48A1A" />
                    <View>
                      <Text style={styles.weightNudgeTitle}>Log today's weight</Text>
                      <Text style={styles.weightNudgeSub}>Fresh data improves your projection</Text>
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color="rgba(26,26,20,0.3)" />
                </TouchableOpacity>
              )}

              {!isLow && p.latest_weight_kg != null && p.weekly_change_kg != null && (
                <View style={{ marginBottom: 16 }}>
                  <WeightProjectionChart
                    startWeight={p.latest_weight_kg}
                    weeklyChangeKg={p.weekly_change_kg}
                    goalWeightKg={p.goal_weight_kg}
                    weightLogs={homeWeightLogs}
                    avgDailyCalories={p.avg_daily_calories}
                  />
                </View>
              )}

              {/* Weekly consistency score */}
              <View style={styles.consistencyCard}>
                <View style={styles.consistencyHeader}>
                  <Text style={styles.consistencyTitle}>Weekly consistency</Text>
                  <Text style={styles.consistencyCount}>
                    {weeksLoggedCount} of 7 weeks logged
                  </Text>
                </View>
                <View style={styles.consistencyRow}>
                  {weekLogged.map((logged, i) => (
                    <View
                      key={i}
                      style={[
                        styles.consistencySegment,
                        logged && styles.consistencySegmentFilled,
                        i === 6 && styles.consistencySegmentCurrent,
                        i === 6 && logged && styles.consistencySegmentCurrentFilled,
                      ]}
                    />
                  ))}
                </View>
                <View style={styles.consistencyLabels}>
                  <Text style={styles.consistencyLabelText}>7 weeks ago</Text>
                  <Text style={styles.consistencyLabelText}>This week</Text>
                </View>
              </View>

              {/* Pace comparison — only when moving toward goal */}
              {!isLow && p.weekly_change_kg != null &&
                p.goal_direction != null && p.goal_direction !== "maintain" && (() => {
                const rate = p.weekly_change_kg;
                const isLoss = p.goal_direction === "lose";
                const movingRight = isLoss ? rate < 0 : rate > 0;
                if (!movingRight) return null; // goal headline already handles off-track

                const inRange = isLoss ? (rate <= -0.5 && rate >= -1.0) : (rate >= 0.25 && rate <= 0.5);
                const tooSlow = isLoss ? rate > -0.5 : (rate > 0 && rate < 0.25);

                let calorieHint: string | null = null;
                if (tooSlow && p.tdee != null && p.avg_daily_calories != null) {
                  const targetRate = isLoss ? -0.5 : 0.25;
                  const neededCalories = p.tdee + (targetRate * 7700) / 7;
                  const delta = Math.abs(Math.round(neededCalories - p.avg_daily_calories));
                  calorieHint = isLoss
                    ? `Eating ~${delta} kcal/day less would put you in the healthy range.`
                    : `Eating ~${delta} kcal/day more would put you in the healthy range.`;
                }

                if (inRange) {
                  return (
                    <View style={styles.paceOnTrackCard}>
                      <Ionicons name="checkmark-circle" size={17} color="#2e7d32" />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.paceOnTrackTitle}>You're in the zone</Text>
                        <Text style={styles.paceOnTrackBody}>
                          {Math.abs(rate).toFixed(2)} kg/wk is right in the healthy{" "}
                          {isLoss ? "loss" : "gain"} range of{" "}
                          {isLoss ? "0.5–1" : "0.25–0.5"} kg/wk.
                        </Text>
                      </View>
                    </View>
                  );
                }

                if (tooSlow) {
                  return (
                    <View style={styles.paceSlowCard}>
                      <Ionicons name="information-circle-outline" size={17} color="#1e40af" />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.paceSlowTitle}>
                          {isLoss ? "Slower than recommended" : "Below recommended gain rate"}
                        </Text>
                        <Text style={styles.paceSlowBody}>
                          {Math.abs(rate).toFixed(2)} kg/wk is below the recommended{" "}
                          {isLoss ? "0.5–1" : "0.25–0.5"} kg/wk range.
                          {calorieHint ? `\n${calorieHint}` : ""}
                        </Text>
                      </View>
                    </View>
                  );
                }

                return null;
              })()}

              {/* Aggressive pace warning — based on actual ML rate, not the slider */}
              {p.weekly_change_kg != null && p.weekly_change_kg < -1.0 && (
                <View style={styles.paceWarningCard}>
                  <Ionicons name="warning-outline" size={17} color="#92400E" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.paceWarningTitle}>Faster than recommended</Text>
                    <Text style={styles.paceWarningBody}>
                      At {Math.abs(p.weekly_change_kg).toFixed(1)} kg/wk you're above the safe range of 0.5–1 kg/wk. Rapid loss can be hard to sustain and may affect muscle mass.
                    </Text>
                  </View>
                </View>
              )}

              <View style={[styles.predCard, isLow && styles.predCardMuted]}>
                <View style={styles.predCardHeader}>
                  <View style={styles.predCardHeaderLeft}>
                    <Ionicons name="analytics-outline" size={16} color="#C48A1A" />
                    <Text style={styles.predCardTitle}>What to expect</Text>
                  </View>
                </View>

                {isLow ? (
                  <Text style={styles.predCardNote}>{p.confidence_note}</Text>
                ) : (
                  <>
                    <View style={styles.predStatRow}>
                      <Text style={styles.predStatLabel}>At this rate</Text>
                      <Text style={[styles.predStatValue, weeklyColor]}>
                        {fmtWeekly(p.weekly_change_kg)}
                      </Text>
                    </View>
                    <View style={styles.predStatRow}>
                      <Text style={styles.predStatLabel}>In 30 days</Text>
                      <Text style={styles.predStatValue}>
                        {p.projected_weight_30d_kg != null
                          ? `~${Math.round(p.projected_weight_30d_kg * 10) / 10} kg`
                          : "—"}
                      </Text>
                    </View>
                    <View style={styles.predStatRow}>
                      <Text style={styles.predStatLabel}>Avg intake</Text>
                      <Text style={styles.predStatValue}>
                        {p.avg_daily_calories != null ? `${Math.round(p.avg_daily_calories)} kcal/day` : "—"}
                      </Text>
                    </View>
                    <View style={styles.predStatRow}>
                      <Text style={styles.predStatLabel}>Est. TDEE</Text>
                      <Text style={styles.predStatValue}>
                        {p.tdee != null ? `~${Math.round(p.tdee)} kcal/day` : "—"}
                      </Text>
                    </View>
                    {p.goal_weight_kg != null && p.goal_direction !== "maintain" && p.estimated_weeks_to_goal != null && (
                      <>
                        <View style={styles.predStatRow}>
                          <Text style={styles.predStatLabel}>Goal in</Text>
                          <Text style={styles.predStatValue}>{p.estimated_weeks_to_goal} wks</Text>
                        </View>
                        {p.projected_goal_date != null && (
                          <View style={styles.predStatRow}>
                            <Text style={styles.predStatLabel}>Goal date</Text>
                            <Text style={styles.predStatValue}>
                              {new Date(p.projected_goal_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            </Text>
                          </View>
                        )}
                      </>
                    )}
                    {p.goal_weight_kg != null && p.goal_direction === "maintain" && (
                      <Text style={styles.predGoalReached}>Goal reached 🎉</Text>
                    )}
                  </>
                )}

                <View style={styles.predCardFooter}>
                  <View style={[styles.predBadge, badgeStyle]}>
                    <Text style={[styles.predBadgeText, badgeTextStyle]}>
                      {p.confidence} confidence
                    </Text>
                  </View>
                </View>
                <Text style={styles.predCardNote}>{p.confidence_note}</Text>
              </View>
            </View>
          );
        })()}

        {/* ── Cardio page ── */}
        {currentPage === "cardio" && (() => {
          // MET values per activity
          const METS: Record<string, number> = { run: 8.0, walk: 3.5, bike: 7.5, swim: 6.0, other: 5.0 };
          const ACTIVITY_LABELS: Record<string, string> = { run: "Run", walk: "Walk", bike: "Bike", swim: "Swim", other: "Other" };
          const ACTIVITY_ICONS: Record<string, string> = { run: "walk-outline", walk: "footsteps-outline", bike: "bicycle-outline", swim: "water-outline", other: "flash-outline" };

          const wlDistKm = (() => {
            const v = parseFloat(wlDistanceStr);
            if (isNaN(v) || v <= 0) return null;
            return wlUnit === "mi" ? v / 0.621371 : v;
          })();
          const wlDurationMin = parseFloat(wlDurationStr);
          const wlCalories = !isNaN(wlDurationMin) && wlDurationMin > 0 && homeWeightKg
            ? Math.round(METS[wlActivity] * homeWeightKg * (wlDurationMin / 60))
            : null;
          const wlCanSave = !isNaN(wlDurationMin) && wlDurationMin > 0;

          const handleSaveWorkout = async () => {
            if (!wlCanSave || !session?.user.id) return;
            setWlSaving(true);
            await supabase.from("cardio_logs").insert({
              user_id:     session.user.id,
              activity:    wlActivity,
              distance_km: wlDistKm,
              duration_min: wlDurationMin,
              calories:    wlCalories,
            });
            setWlSaving(false);
            setIsWorkoutLogOpen(false);
            setWlDistanceStr("");
            setWlDurationStr("");
            setWlActivity("run");
          };

          return (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>CARDIO</Text>

              {/* Route Planner card */}
              <TouchableOpacity style={styles.routeCard} onPress={() => setIsRoutePlannerOpen(true)} activeOpacity={0.92}>
                <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                  <MapView
                    style={StyleSheet.absoluteFill}
                    provider={PROVIDER_DEFAULT}
                    initialRegion={
                      homeUserLocation
                        ? { ...homeUserLocation, latitudeDelta: 0.018, longitudeDelta: 0.018 }
                        : { latitude: 37.7749, longitude: -122.4194, latitudeDelta: 0.05, longitudeDelta: 0.05 }
                    }
                    scrollEnabled={false} zoomEnabled={false} rotateEnabled={false} pitchEnabled={false}
                    showsUserLocation={!!homeUserLocation} showsMyLocationButton={false}
                  />
                </View>
                <View style={styles.routeCardOverlay}>
                  <View style={styles.routeCardLabel}>
                    <Ionicons name="map-outline" size={18} color="#fff" />
                    <Text style={styles.routeCardTitle}>Route Planner</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.8)" />
                </View>
              </TouchableOpacity>

              {/* Log Workout card */}
              <TouchableOpacity style={styles.logWorkoutCard} onPress={() => setIsWorkoutLogOpen(true)} activeOpacity={0.85}>
                <View style={styles.logWorkoutCardLeft}>
                  <Ionicons name="add-circle-outline" size={22} color="#E86F2C" />
                  <Text style={styles.logWorkoutCardTitle}>Log Workout</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#C0C0B0" />
              </TouchableOpacity>

              {/* Log Workout modal */}
              <Modal visible={isWorkoutLogOpen} transparent animationType="slide" onRequestClose={() => setIsWorkoutLogOpen(false)}>
                <View style={styles.wlOverlay}>
                  <View style={[styles.wlSheet, { paddingBottom: insets.bottom + 16 }]}>
                    {/* Header */}
                    <View style={styles.wlHeader}>
                      <Text style={styles.wlTitle}>Log Workout</Text>
                      <TouchableOpacity onPress={() => setIsWorkoutLogOpen(false)} activeOpacity={0.7}>
                        <Ionicons name="close" size={22} color="#6B6B5E" />
                      </TouchableOpacity>
                    </View>

                    {/* Activity type */}
                    <Text style={styles.wlLabel}>Activity</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.wlActivityScroll}>
                      {(["run","walk","bike","swim","other"] as const).map(a => (
                        <TouchableOpacity
                          key={a}
                          style={[styles.wlActivityChip, wlActivity === a && styles.wlActivityChipActive]}
                          onPress={() => setWlActivity(a)}
                          activeOpacity={0.75}
                        >
                          <Ionicons name={ACTIVITY_ICONS[a] as any} size={16} color={wlActivity === a ? "#fff" : "#6B6B5E"} />
                          <Text style={[styles.wlActivityChipLabel, wlActivity === a && styles.wlActivityChipLabelActive]}>
                            {ACTIVITY_LABELS[a]}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>

                    {/* Duration + Distance row */}
                    <View style={styles.wlFieldRow}>
                      <View style={styles.wlFieldGroup}>
                        <Text style={styles.wlLabel}>Duration</Text>
                        <View style={styles.wlInputWrap}>
                          <TextInput
                            style={styles.wlInput}
                            value={wlDurationStr}
                            onChangeText={setWlDurationStr}
                            placeholder="0"
                            placeholderTextColor="#ccc"
                            keyboardType="decimal-pad"
                          />
                          <Text style={styles.wlInputUnit}>min</Text>
                        </View>
                      </View>

                      <View style={styles.wlFieldGroup}>
                        <View style={styles.wlDistLabelRow}>
                          <Text style={styles.wlLabel}>Distance</Text>
                          <View style={styles.wlUnitToggle}>
                            {(["km","mi"] as const).map(u => (
                              <TouchableOpacity key={u} onPress={() => setWlUnit(u)} style={[styles.wlUnitBtn, wlUnit === u && styles.wlUnitBtnActive]} activeOpacity={0.8}>
                                <Text style={[styles.wlUnitBtnLabel, wlUnit === u && styles.wlUnitBtnLabelActive]}>{u}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </View>
                        <View style={styles.wlInputWrap}>
                          <TextInput
                            style={styles.wlInput}
                            value={wlDistanceStr}
                            onChangeText={setWlDistanceStr}
                            placeholder="0"
                            placeholderTextColor="#ccc"
                            keyboardType="decimal-pad"
                          />
                          <Text style={styles.wlInputUnit}>{wlUnit}</Text>
                        </View>
                      </View>
                    </View>

                    {/* Calorie preview */}
                    {wlCalories != null && (
                      <View style={styles.wlCalRow}>
                        <Ionicons name="flame-outline" size={16} color="#E86F2C" />
                        <Text style={styles.wlCalText}>~{wlCalories} kcal burned</Text>
                      </View>
                    )}
                    {wlCalories == null && homeWeightKg == null && wlDurationStr.length > 0 && (
                      <Text style={styles.wlCalNote}>Log your weight to see calorie estimates</Text>
                    )}

                    {/* Save */}
                    <TouchableOpacity
                      style={[styles.wlSaveBtn, !wlCanSave && { opacity: 0.4 }]}
                      onPress={handleSaveWorkout}
                      disabled={!wlCanSave || wlSaving}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.wlSaveBtnLabel}>{wlSaving ? "Saving…" : "Save Workout"}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </Modal>
            </View>
          );
        })()}

      </ScrollView>

      {/* Cardio plan mode — full-screen overlay.
          Rendered outside the ScrollView so MapView touch gestures work cleanly. */}
      {isRoutePlannerOpen && (
        <CardioScreen
          onBack={() => setIsRoutePlannerOpen(false)}
          weightKg={homeWeightKg}
          userId={session?.user.id ?? null}
          onLocationFound={setHomeUserLocation}
        />
      )}

      {/* Today's calorie badge — absolutely positioned so it stays fixed
          while the ScrollView content scrolls beneath it.
          top: 20 / right: 20 matches the container padding so it sits flush
          with the right margin, vertically level with the header row.
          pointerEvents="none" keeps it non-interactive. */}
      {currentPage === "home" && todayCalories !== null && (
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
      {currentPage === "home" && (
      <View style={[styles.bottomBar, { bottom: keyboardHeight > 0 ? keyboardHeight - insets.bottom : 0, paddingBottom: keyboardHeight > 0 ? 8 : (insets.bottom || 8) }]}>
        <View style={[styles.inputRow, isSearchFocused && styles.inputRowFocused]}>
          <TouchableOpacity
            style={styles.multiLogButton}
            onPress={() => setIsMultiLogOpen(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="list-outline" size={22} color="rgba(26,26,20,0.5)" />
          </TouchableOpacity>
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
      )}

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
            <Ionicons name="arrow-back" size={18} color="#1A1A14" />
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
    borderRadius: 14,
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
        // Recompute total_oz from the active mode only — never mix both modes.
        // Switching to bottle: zero out direct_oz so stale oz don't inflate the total.
        // Switching to direct: zero out bottle_count so stale bottles don't inflate the total.
        const isBottle = setup.usesBottle === "yes";
        const recomputedTotal = isBottle
          ? (existing.bottle_count ?? 0) * (setup.bottleSize ?? 0)
          : (existing.direct_oz ?? 0);

        await supabase
          .from("hydration_daily_logs")
          .update({
            goal_oz_snapshot: setup.dailyGoalOz,
            total_oz:         recomputedTotal,
            bottle_count:     isBottle ? (existing.bottle_count ?? 0) : 0,
            direct_oz:        isBottle ? 0 : (existing.direct_oz ?? 0),
            updated_at:       new Date().toISOString(),
          })
          .eq("user_id", userId)
          .eq("log_date", today);

        // Mirror the zeroed state locally so the UI stays in sync.
        if (isBottle) setDirectOz(0);
        else setBottleCount(0);
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
          <Ionicons name="arrow-back" size={18} color="#1A1A14" />
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
                      <Ionicons name="remove" size={22} color={bottleCount === 0 ? "rgba(26,26,20,0.2)" : "#1A1A14"} />
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
  textPrimary:  "#1A1A14",
  textSecondary:"rgba(26,26,20,0.5)",
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
    backgroundColor: "transparent",
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
    overflow: "visible",
  },
  headerGlowOuter: {
    position: "absolute",
    width: 220,
    height: 130,
    borderRadius: 110,
    top: -30,
    left: -30,
    backgroundColor: "rgba(250,230,90,0.22)",
  },
  headerGlowMid: {
    position: "absolute",
    width: 140,
    height: 85,
    borderRadius: 70,
    top: -15,
    left: 10,
    backgroundColor: "rgba(255,245,150,0.30)",
  },
  appSubtitle: {
    fontSize: 14,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.5)",
    marginBottom: 16,
  },
  logOutText: {
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.5)",
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
    color: "#1A1A14",
    marginBottom: 32,
  },
  sidebarDivider: {
    height: 1,
    backgroundColor: "rgba(26,26,20,0.08)",
    marginBottom: 20,
  },
  sidebarItem: {
    fontSize: 15,
    fontFamily: "Chillax-Medium",
    color: "#1A1A14",
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
    color: "#1A1A14",
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
    color: "#1A1A14",
  },

  // Date selector
  dateSection: {
    marginBottom: 4,
    marginTop: 16,
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
    color: "#1A1A14",
  },
  dateTriggerIcon: {
    fontSize: 14,
    color: "rgba(26,26,20,0.5)",
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
    color: "rgba(26,26,20,0.5)",
    letterSpacing: 1.2,
    marginBottom: 10,
  },

  // Input
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(250,250,247,0.9)",
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
    color: "#1A1A14",
  },

  searchingText: {
    marginTop: 8,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.5)",
  },

  multiLogButton: {
    marginRight: 6,
    justifyContent: "center",
    padding: 2,
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
    backgroundColor: "#FAFAF7",
  },
  scannerPermissionText: {
    fontSize: 15,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.7)",
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
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.80)",
    borderWidth: 1,
    borderColor: "rgba(196,138,26,0.15)",
    shadowColor: "rgba(200,160,20,0.6)",
    shadowOpacity: 0.10,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  summaryCard: {
    backgroundColor: COLORS.primaryLight,
    borderColor: "#E3D517",
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: "Chillax-Medium",
    color: "#1A1A14",
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
    color: "#1A1A14",
  },
  macroUnit: {
    fontSize: 10,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.5)",
  },
  macroLabel: {
    fontSize: 11,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.5)",
    marginTop: 2,
  },

  // Summary
  entryCount: {
    fontSize: 12,
    fontFamily: "Chillax-Medium",
    color: "#1A1A14",
    textAlign: "right",
  },

  // Log list
  logEntry: {
    padding: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.80)",
    borderWidth: 1,
    borderColor: "rgba(196,138,26,0.15)",
    shadowColor: "rgba(200,160,20,0.6)",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
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
    color: "#1A1A14",
    textTransform: "capitalize",
  },
  logEntryMacros: {
    fontSize: 12,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.45)",
  },
  logEntryTime: {
    fontSize: 11,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.3)",
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
    color: "rgba(26,26,20,0.35)",
    flexShrink: 1,
  },
  sourceMetaText: {
    fontSize: 10,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.4)",
    flexShrink: 1,
  },
  // Log entry action buttons (Edit + Delete stacked)
  logEntryActions: {
    alignItems: "flex-end",
    gap: 6,
  },
  editButton: {
    fontSize: 12,
    fontFamily: "Inter-Variable",
    color: COLORS.primary,
    fontWeight: "600",
  },

  // Inline edit form
  editInput: {
    borderWidth: 1,
    borderColor: "rgba(26,26,20,0.12)",
    borderRadius: 6,
    padding: 8,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "#1A1A14",
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
    color: "rgba(26,26,20,0.5)",
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
    borderColor: "rgba(26,26,20,0.12)",
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: "center",
  },
  editCancelText: {
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.5)",
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
    fontFamily: "Inter-Variable",
    color: "#c62828",
    fontWeight: "600",
  },
  deleteButtonDisabled: {
    fontSize: 12,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.25)",
    fontWeight: "600",
  },

  // Empty states
  emptyState: {
    marginTop: 10,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "rgba(26,26,20,0.3)",
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
    color: "rgba(26,26,20,0.5)",
    width: 72,
  },
  weekBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: "rgba(26,26,20,0.08)",
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
    color: "rgba(26,26,20,0.5)",
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
  routeCard: {
    marginTop: 10,
    height: 130,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#c8d6c8",
  },
  routeCardOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.28)",
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  routeCardLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  routeCardTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 17,
    color: "#fff",
    letterSpacing: -0.3,
  },
  logWorkoutCard: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFEF8",
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },
  logWorkoutCardLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logWorkoutCardTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 16,
    color: "#1A1A14",
    letterSpacing: -0.2,
  },
  // Workout log modal
  wlOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  wlSheet: {
    backgroundColor: "#FFFEF8",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 20,
    gap: 16,
  },
  wlHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  wlTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 20,
    color: "#1A1A14",
    letterSpacing: -0.3,
  },
  wlLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    fontWeight: "600",
    color: "#6B6B5E",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  wlActivityScroll: {
    marginHorizontal: -20,
    paddingHorizontal: 20,
  },
  wlActivityChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.05)",
    marginRight: 8,
  },
  wlActivityChipActive: {
    backgroundColor: "#E86F2C",
  },
  wlActivityChipLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    fontWeight: "500",
    color: "#6B6B5E",
  },
  wlActivityChipLabelActive: {
    color: "#fff",
  },
  wlFieldRow: {
    flexDirection: "row",
    gap: 12,
  },
  wlFieldGroup: {
    flex: 1,
    gap: 8,
  },
  wlDistLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  wlUnitToggle: {
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  wlUnitBtn: {
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  wlUnitBtnActive: {
    backgroundColor: "#fff",
  },
  wlUnitBtnLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    fontWeight: "600",
    color: "#6B6B5E",
  },
  wlUnitBtnLabelActive: {
    color: "#1A1A14",
  },
  wlInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.1)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
    backgroundColor: "#fff",
  },
  wlInput: {
    flex: 1,
    fontFamily: "Chillax-SemiBold",
    fontSize: 22,
    color: "#1A1A14",
    padding: 0,
  },
  wlInputUnit: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "#6B6B5E",
  },
  wlCalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    justifyContent: "center",
  },
  wlCalText: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#E86F2C",
    fontWeight: "500",
  },
  wlCalNote: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "#aaa",
    textAlign: "center",
  },
  wlSaveBtn: {
    backgroundColor: "#E86F2C",
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
  },
  wlSaveBtnLabel: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 16,
    color: "#fff",
    letterSpacing: -0.2,
  },
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
    backgroundColor: "#29B6F6",
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
    color: "rgba(26,26,20,0.5)",
  },

  // ── Page tab scroller ─────────────────────────────────────────────────────
  pageTabBar: {
    height: 52,
    marginTop: 14,
    marginBottom: 4,
  },
  pageTabItem: {
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  pageTabText: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 19,
    color: "#1A1A14",
    letterSpacing: -0.4,
  },

  // ── Weight Projection home card ────────────────────────────────────────────
  predCard: {
    marginTop: 10,
    padding: 16,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderWidth: 1.5,
    borderColor: "#F5D834",
    shadowColor: "rgba(200,160,20,0.6)",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
    gap: 10,
  },
  predCardMuted: {
    opacity: 0.7,
  },
  predCardLoading: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.45)",
    textAlign: "center",
    paddingVertical: 6,
  },
  predCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  predCardHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  predCardTitle: {
    fontFamily: "Chillax-Medium",
    fontSize: 14,
    color: "#1A1A14",
    letterSpacing: 0.1,
  },
  predStatRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  predStatLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.55)",
  },
  predStatValue: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 14,
    color: "#1A1A14",
    letterSpacing: -0.2,
  },
  predStatLoss: { color: "#2e7d32" },
  predStatGain: { color: "#C48A1A" },
  predStatNeutral: { color: "#1A1A14" },
  predGoalReached: {
    fontFamily: "Chillax-Medium",
    fontSize: 13,
    color: "#2e7d32",
    textAlign: "center",
  },
  predCardNote: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.5)",
    fontStyle: "italic",
    lineHeight: 17,
  },
  predCardFooter: {
    flexDirection: "row",
    marginTop: 2,
  },
  predBadge: {
    borderRadius: 100,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  predBadgeHigh:   { backgroundColor: "rgba(46,125,50,0.12)" },
  predBadgeMedium: { backgroundColor: "rgba(196,138,26,0.12)" },
  predBadgeLow:    { backgroundColor: "rgba(26,26,20,0.07)" },
  predBadgeText: {
    fontFamily: "Chillax-Medium",
    fontSize: 11,
    letterSpacing: 0.2,
  },
  predBadgeTextHigh:   { color: "#2e7d32" },
  predBadgeTextMedium: { color: "#C48A1A" },
  predBadgeTextLow:    { color: "rgba(26,26,20,0.45)" },

  // Goal headline card — shown at top of Weight Projection page
  goalHeadlineCard: {
    borderRadius: 20,
    padding: 20,
    alignItems: "center",
    marginBottom: 16,
  },
  goalHeadlineEmoji: {
    fontSize: 28,
    marginBottom: 4,
  },
  goalHeadlineTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 22,
    color: "#1A1A14",
    letterSpacing: -0.3,
  },
  goalHeadlineDate: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 28,
    color: "#1A1A14",
    letterSpacing: -0.5,
    marginVertical: 4,
    textAlign: "center",
  },
  goalHeadlineSub: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.55)",
    textAlign: "center",
    marginTop: 2,
  },

  // Off-track variant (amber, no gradient)
  goalOffTrackCard: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
    backgroundColor: "#FEF3C7",
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#F59E0B",
  },
  goalOffTrackTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 13,
    color: "#92400E",
    marginBottom: 3,
  },
  goalOffTrackBody: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#92400E",
    lineHeight: 17,
  },

  // Log today's weight nudge
  weightNudgeCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFBEC",
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1.5,
    borderColor: "#F5D834",
  },
  weightNudgeLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  weightNudgeTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 14,
    color: "#1A1A14",
    marginBottom: 2,
  },
  weightNudgeSub: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.5)",
  },

  // Weekly consistency score card
  consistencyCard: {
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderWidth: 1,
    borderColor: "rgba(26,26,20,0.08)",
    padding: 14,
    marginBottom: 16,
  },
  consistencyHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  consistencyTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 13,
    color: "#1A1A14",
  },
  consistencyCount: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.5)",
  },
  consistencyRow: {
    flexDirection: "row",
    gap: 5,
  },
  consistencySegment: {
    flex: 1,
    height: 10,
    borderRadius: 100,
    backgroundColor: "rgba(26,26,20,0.08)",
  },
  consistencySegmentFilled: {
    backgroundColor: "#1A1A14",
  },
  consistencySegmentCurrent: {
    borderWidth: 1.5,
    borderColor: "rgba(26,26,20,0.2)",
  },
  consistencySegmentCurrentFilled: {
    backgroundColor: "#E3D517",
    borderColor: "#E3D517",
  },
  consistencyLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
  consistencyLabelText: {
    fontFamily: "Inter-Variable",
    fontSize: 10,
    color: "rgba(26,26,20,0.35)",
  },

  // Pace comparison cards
  paceOnTrackCard: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
    backgroundColor: "#F0FDF4",
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#86EFAC",
  },
  paceOnTrackTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 13,
    color: "#166534",
    marginBottom: 3,
  },
  paceOnTrackBody: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#166534",
    lineHeight: 17,
  },
  paceSlowCard: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
    backgroundColor: "#EFF6FF",
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#93C5FD",
  },
  paceSlowTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 13,
    color: "#1e40af",
    marginBottom: 3,
  },
  paceSlowBody: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#1e40af",
    lineHeight: 17,
  },

  // Aggressive pace warning card
  paceWarningCard: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
    backgroundColor: "#FEF3C7",
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#F59E0B",
  },
  paceWarningTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 13,
    color: "#92400E",
    marginBottom: 3,
  },
  paceWarningBody: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#92400E",
    lineHeight: 17,
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
    color: "#1A1A14",
    letterSpacing: -0.4,
    marginBottom: 6,
  },
  subhead: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "rgba(26,26,20,0.5)",
    marginBottom: 32,
    lineHeight: 20,
  },
  label: {
    fontFamily: "Chillax-Medium",
    fontSize: 12,
    color: "rgba(26,26,20,0.5)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  input: {
    backgroundColor: "rgba(250,250,247,0.85)",
    borderWidth: 1.5,
    borderColor: "rgba(26,26,20,0.12)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter-Variable",
    color: "#1A1A14",
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
    borderColor: "rgba(26,26,20,0.12)",
    backgroundColor: "rgba(250,250,247,0.85)",
  },
  pillSelected: {
    backgroundColor: "#1A1A14",
    borderColor: "#1A1A14",
  },
  pillText: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "rgba(26,26,20,0.5)",
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
    color: "rgba(26,26,20,0.5)",
  },
  acctGreeting: {
    fontFamily: "Chillax-Medium",
    fontSize: 15,
    color: "rgba(26,26,20,0.5)",
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
    borderColor: "rgba(26,26,20,0.12)",
    alignItems: "center",
    backgroundColor: "rgba(250,250,247,0.85)",
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
    backgroundColor: "rgba(250,250,247,0.9)",
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
    borderColor: "rgba(26,26,20,0.12)",
    backgroundColor: "rgba(250,250,247,0.85)",
  },
  pillSelected: {
    backgroundColor: "#1A1A14",
    borderColor: "#1A1A14",
  },
  pillText: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "rgba(26,26,20,0.5)",
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
    backgroundColor: "rgba(250,250,247,0.9)",
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
    borderColor: "rgba(26,26,20,0.12)",
    backgroundColor: "rgba(250,250,247,0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperButtonDisabled: {
    borderColor: "rgba(26,26,20,0.06)",
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
    color: "#F8E94A",
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
// WeightProjectionChart
// ─────────────────────────────────────────────────────────────────────────────

type WPRange = "2W" | "1M" | "3M" | "6M" | "1Y";
const WP_RANGES: WPRange[] = ["2W", "1M", "3M", "6M", "1Y"];
const WP_RANGE_DAYS: Record<WPRange, number> = {
  "2W": 14, "1M": 30, "3M": 91, "6M": 182, "1Y": 365,
};

function WeightProjectionChart({
  startWeight,
  weeklyChangeKg,
  goalWeightKg,
  weightLogs,
  avgDailyCalories,
}: {
  startWeight: number;
  weeklyChangeKg: number | null;
  goalWeightKg: number | null;
  weightLogs: WeightLogEntry[];
  avgDailyCalories: number | null;
}) {
  const [range, setRange] = useState<WPRange>("1M");
  const baseCalories = avgDailyCalories ?? null;
  const [sliderCalories, setSliderCalories] = useState<number>(baseCalories ?? 2000);

  // Sync slider base when prediction first loads
  useEffect(() => {
    if (baseCalories != null) setSliderCalories(baseCalories);
  }, [baseCalories]);

  const isAdjusted = baseCalories != null && Math.round(sliderCalories) !== Math.round(baseCalories);

  // Physics delta on top of ML baseline
  const dailyDelta = baseCalories != null ? sliderCalories - baseCalories : 0;
  const weeklyDeltaKg = (dailyDelta * 7) / 7700;
  const adjustedWeeklyChangeKg = (weeklyChangeKg ?? 0) + weeklyDeltaKg;
  const adjustedRatePerDay = adjustedWeeklyChangeKg / 7;

  const totalDays = WP_RANGE_DAYS[range];

  // ── Dynamic metabolic simulation ────────────────────────────────────────────
  // As weight changes, TDEE shifts by ~15 kcal/day per kg (Mifflin × moderate
  // activity 1.55). This curves the projection — weight loss decelerates as the
  // body gets lighter and needs fewer calories to maintain itself.
  const KCAL_PER_KG   = 7700;
  const TDEE_PER_KG   = 15;   // kcal/day TDEE change per kg body weight
  const impliedDeficit = adjustedRatePerDay * KCAL_PER_KG; // kcal/day at current weight

  const simWeights: number[] = [startWeight];
  let simW = startWeight;
  for (let d = 1; d <= totalDays; d++) {
    const weightDelta   = simW - startWeight;
    const adjustedDef   = impliedDeficit - TDEE_PER_KG * weightDelta;
    simW = Math.max(20, Math.min(500, simW + adjustedDef / KCAL_PER_KG));
    simWeights.push(simW);
  }
  const endWeight = simWeights[totalDays];

  // Past window scales with range so history stays visually meaningful
  const PAST_DAYS = Math.max(14, Math.round(totalDays / 3));
  const totalSpan = PAST_DAYS + totalDays;

  // SVG coordinate space
  const W = 300, H = 150;
  const PL = 38, PR = 8, PT = 12, PB = 26;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;
  const bottomY = H - PB;

  // dayOffset: 0 = today, negative = past, positive = future
  const toX = (dayOffset: number) => PL + ((dayOffset + PAST_DAYS) / totalSpan) * chartW;
  const todayX = toX(0);

  // Map weight log entries to day offsets relative to today
  const todayDate = new Date();
  const todayMs = Date.UTC(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
  const histPts: { dayOffset: number; weight: number }[] = [];
  for (const log of weightLogs) {
    const [y, mo, d] = log.log_date.split("-").map(Number);
    const logMs = Date.UTC(y, mo - 1, d);
    const dayOffset = Math.round((logMs - todayMs) / 86400000);
    if (dayOffset >= -PAST_DAYS && dayOffset <= 0) {
      histPts.push({ dayOffset, weight: log.weight_kg });
    }
  }
  histPts.sort((a, b) => a.dayOffset - b.dayOffset); // oldest first

  // Confidence band — uncertainty grows as √time (σ = 0.25 kg/wk)
  const SIGMA_PER_WEEK = 0.25;
  const maxBandUncertainty = SIGMA_PER_WEEK * Math.sqrt(totalDays / 7);

  // Y scale — includes simulation curve extremes + historical + goal + band
  const allW = [
    startWeight,
    endWeight + maxBandUncertainty,
    endWeight - maxBandUncertainty,
    ...histPts.map(p => p.weight),
  ];
  if (goalWeightKg != null) allW.push(goalWeightKg);
  let yMin = Math.min(...allW);
  let yMax = Math.max(...allW);
  const yPad = Math.max((yMax - yMin) * 0.18, 1.5);
  yMin -= yPad;
  yMax += yPad;
  const ySpan = yMax - yMin;

  const toY = (w: number) => PT + (1 - (w - yMin) / ySpan) * chartH;

  // Historical SVG points
  const histSvgPts = histPts.map(p => ({ x: toX(p.dayOffset), y: toY(p.weight) }));
  const histLinePath = histSvgPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Future projection — sample the simulation curve for SVG rendering
  const renderStep = totalDays <= 14 ? 1 : totalDays <= 30 ? 2 : totalDays <= 91 ? 5 : totalDays <= 182 ? 7 : 14;
  const futureDayOffsets: number[] = [];
  for (let d = 0; d <= totalDays; d += renderStep) futureDayOffsets.push(d);
  if (futureDayOffsets[futureDayOffsets.length - 1] !== totalDays) futureDayOffsets.push(totalDays);
  const futurePts = futureDayOffsets.map(d => ({ x: toX(d), y: toY(simWeights[d]) }));
  const futureLinePath = futurePts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${futureLinePath} L${futurePts[futurePts.length - 1].x.toFixed(1)},${bottomY} L${futurePts[0].x.toFixed(1)},${bottomY} Z`;

  // Confidence band — centered on the simulation curve
  const bandUpperPts = futureDayOffsets.map(d => {
    const u = SIGMA_PER_WEEK * Math.sqrt(d / 7);
    return { x: toX(d), y: toY(simWeights[d] + u) };
  });
  const bandLowerPts = futureDayOffsets.map(d => {
    const u = SIGMA_PER_WEEK * Math.sqrt(d / 7);
    return { x: toX(d), y: toY(simWeights[d] - u) };
  });
  const bandPath = [
    ...bandUpperPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    ...[...bandLowerPts].reverse().map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    "Z",
  ].join(" ");

  // Milestone markers — scan simulation for each 5 kg crossing
  const milestones: { weight: number; x: number; y: number }[] = [];
  if (adjustedRatePerDay !== 0) {
    const dir   = adjustedRatePerDay < 0 ? -1 : 1;
    const first = dir < 0 ? Math.floor(startWeight / 5) * 5 : Math.ceil(startWeight / 5) * 5;
    let m = first;
    for (let iter = 0; iter < 20 && milestones.length < 5; iter++, m += dir * 5) {
      let mDay: number | null = null;
      for (let d = 1; d <= totalDays; d++) {
        const crossed = dir < 0
          ? simWeights[d] <= m && simWeights[d - 1] > m
          : simWeights[d] >= m && simWeights[d - 1] < m;
        if (crossed) {
          const frac = Math.abs(simWeights[d - 1] - m) / Math.abs(simWeights[d] - simWeights[d - 1]);
          mDay = (d - 1) + frac;
          break;
        }
      }
      if (mDay === null) break;
      const mx = toX(mDay);
      const my = toY(m);
      if (my > PT + 10 && my < bottomY - 10) milestones.push({ weight: m, x: mx, y: my });
    }
  }

  // Goal reference line
  const goalY = goalWeightKg != null ? toY(goalWeightKg) : null;
  const goalVisible = goalY != null && goalY >= PT && goalY <= bottomY;

  // Goal intersection + date — scan simulation for crossing
  let goalIntersectX: number | null = null;
  let goalIntersectY: number | null = null;
  let adjustedGoalDate: string | null = null;
  if (goalWeightKg != null && adjustedRatePerDay !== 0) {
    const isLoss = adjustedRatePerDay < 0;
    for (let d = 1; d <= totalDays; d++) {
      const crossed = isLoss
        ? simWeights[d] <= goalWeightKg && simWeights[d - 1] > goalWeightKg
        : simWeights[d] >= goalWeightKg && simWeights[d - 1] < goalWeightKg;
      if (crossed) {
        const frac = Math.abs(simWeights[d - 1] - goalWeightKg) / Math.abs(simWeights[d] - simWeights[d - 1]);
        const exactDay = (d - 1) + frac;
        goalIntersectX = toX(exactDay);
        goalIntersectY = goalY;
        adjustedGoalDate = new Date(todayDate.getTime() + exactDay * 86400000)
          .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        break;
      }
    }
    // Goal within range but not crossed yet — still compute date for slider callout
    if (adjustedGoalDate === null) {
      // Extend simulation beyond range to find date (up to 5×)
      let extW = simWeights[totalDays];
      for (let d = totalDays + 1; d <= totalDays * 5 && adjustedGoalDate === null; d++) {
        const prev = extW;
        const def  = impliedDeficit - TDEE_PER_KG * (extW - startWeight);
        extW = Math.max(20, Math.min(500, extW + def / KCAL_PER_KG));
        const crossed = isLoss
          ? extW <= goalWeightKg && prev > goalWeightKg
          : extW >= goalWeightKg && prev < goalWeightKg;
        if (crossed) {
          adjustedGoalDate = new Date(todayDate.getTime() + d * 86400000)
            .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        }
      }
    }
  }

  // X-axis future tick labels (day offsets are positive = days from today)
  const xLabels: { dayOffset: number; label: string }[] = (() => {
    const fmt = (n: number) =>
      new Date(todayDate.getTime() + n * 86400000).toLocaleDateString("en-US", {
        month: "short", day: "numeric",
      });
    const fmtM = (n: number) =>
      new Date(todayDate.getTime() + n * 86400000).toLocaleDateString("en-US", { month: "short" });
    switch (range) {
      case "2W": return [7, 14].map(d => ({ dayOffset: d, label: fmt(d) }));
      case "1M": return [10, 20, 30].map(d => ({ dayOffset: d, label: fmt(d) }));
      case "3M": return [30, 60, 91].map(d => ({ dayOffset: d, label: fmtM(d) }));
      case "6M": return [61, 122, 182].map(d => ({ dayOffset: d, label: fmtM(d) }));
      case "1Y": return [91, 182, 274, 365].map(d => ({ dayOffset: d, label: fmtM(d) }));
    }
  })();

  const yTicks = [0, 1 / 3, 2 / 3, 1].map(f => yMin + f * ySpan);
  const showDisclaimer = range === "3M" || range === "6M" || range === "1Y";

  return (
    <View>
      {/* Range selector */}
      <View style={wpStyles.rangeRow}>
        {WP_RANGES.map((r) => (
          <TouchableOpacity
            key={r}
            style={[wpStyles.rangePill, range === r && wpStyles.rangePillActive]}
            onPress={() => setRange(r)}
            activeOpacity={0.75}
          >
            <Text style={[wpStyles.rangePillText, range === r && wpStyles.rangePillTextActive]}>
              {r}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* SVG chart */}
      <View style={wpStyles.chartCard}>
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
          <Defs>
            <SvgLinearGradient id="wp-area" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor="#F5D834" stopOpacity={0.45} />
              <Stop offset="100%" stopColor="#F5D834" stopOpacity={0} />
            </SvgLinearGradient>
            {/* Band fades in from "Today" to convey growing uncertainty */}
            <SvgLinearGradient id="wp-band" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0%" stopColor="#1A1A14" stopOpacity={0} />
              <Stop offset="25%" stopColor="#1A1A14" stopOpacity={0.07} />
              <Stop offset="100%" stopColor="#1A1A14" stopOpacity={0.12} />
            </SvgLinearGradient>
          </Defs>

          {/* Grid lines + Y labels */}
          {yTicks.map((w, i) => {
            const ty = toY(w);
            return (
              <G key={i}>
                <SvgLine x1={PL} y1={ty} x2={W - PR} y2={ty}
                  stroke="rgba(26,26,20,0.06)" strokeWidth={1} />
                <SvgText x={PL - 3} y={ty + 3} fontSize={6.5}
                  fill="rgba(26,26,20,0.38)" textAnchor="end">
                  {w.toFixed(1)}
                </SvgText>
              </G>
            );
          })}

          {/* "Today" vertical separator */}
          <SvgLine x1={todayX} y1={PT} x2={todayX} y2={bottomY}
            stroke="rgba(26,26,20,0.18)" strokeWidth={1} strokeDasharray="3,3" />

          {/* Goal dashed reference line */}
          {goalVisible && goalY != null && (
            <SvgLine x1={PL} y1={goalY} x2={W - PR} y2={goalY}
              stroke="#2e7d32" strokeWidth={1.5} strokeDasharray="4,3" />
          )}

          {/* Confidence band — subtle cone widening into the future */}
          <SvgPath d={bandPath} fill="url(#wp-band)" />

          {/* Future area fill */}
          <SvgPath d={areaPath} fill="url(#wp-area)" />

          {/* Future projection line */}
          <SvgPath d={futureLinePath} fill="none" stroke="#1A1A14"
            strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />

          {/* Milestone markers — hollow dots + kg label every 5 kg */}
          {milestones.map(({ weight, x, y }) => (
            <G key={weight}>
              <Circle cx={x} cy={y} r={3.5} fill="#fff" stroke="#1A1A14" strokeWidth={1.5} />
              <SvgText
                x={x} y={adjustedRatePerDay < 0 ? y - 7 : y + 14}
                fontSize={6.5} fill="rgba(26,26,20,0.5)" textAnchor="middle"
              >
                {weight} kg
              </SvgText>
            </G>
          ))}

          {/* Historical line — muted, connects real weigh-ins */}
          {histSvgPts.length >= 2 && (
            <SvgPath d={histLinePath} fill="none" stroke="rgba(26,26,20,0.4)"
              strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          )}

          {/* Historical dots */}
          {histSvgPts.map((p, i) => (
            <Circle key={i} cx={p.x} cy={p.y} r={2.8} fill="#1A1A14" fillOpacity={0.5} />
          ))}

          {/* Goal intersection */}
          {goalIntersectX != null && goalIntersectY != null && (
            <G>
              <Circle cx={goalIntersectX} cy={goalIntersectY} r={9}
                fill="none" stroke="#2e7d32" strokeWidth={1.5} strokeOpacity={0.3} />
              <Circle cx={goalIntersectX} cy={goalIntersectY} r={4.5} fill="#2e7d32" />
              <SvgText x={goalIntersectX} y={goalIntersectY - 13}
                fontSize={7.5} fill="#2e7d32" textAnchor="middle">
                Goal
              </SvgText>
            </G>
          )}

          {/* Today dot — prominent anchor between history and projection */}
          <Circle cx={todayX} cy={toY(startWeight)} r={4} fill="#1A1A14" />

          {/* End dot */}
          <Circle cx={toX(totalDays)} cy={toY(endWeight)} r={3.5} fill="#1A1A14" />

          {/* X-axis labels */}
          <SvgText x={todayX} y={H - 5} fontSize={6.5}
            fill="rgba(26,26,20,0.55)" textAnchor="middle">
            Today
          </SvgText>
          {xLabels.map(({ dayOffset, label }) => (
            <SvgText key={dayOffset} x={toX(dayOffset)} y={H - 5} fontSize={6.5}
              fill="rgba(26,26,20,0.42)" textAnchor="middle">
              {label}
            </SvgText>
          ))}
        </Svg>
      </View>

      {showDisclaimer && (
        <Text style={wpStyles.disclaimer}>Projection assumes current pace</Text>
      )}

      {/* What-if slider — only shown when avg calories are known */}
      {baseCalories != null && (
        <View style={[wpStyles.sliderCard, isAdjusted && wpStyles.sliderCardAdjusted]}>
          {/* Header row */}
          <View style={wpStyles.sliderHeader}>
            <Text style={wpStyles.sliderTitle}>What if I ate…</Text>
            {isAdjusted && (
              <TouchableOpacity
                onPress={() => setSliderCalories(baseCalories)}
                style={wpStyles.resetBtn}
                activeOpacity={0.75}
              >
                <Text style={wpStyles.resetBtnText}>Reset to actual pace</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Calorie value + delta */}
          <View style={wpStyles.sliderValueRow}>
            <Text style={wpStyles.sliderKcal}>
              {Math.round(sliderCalories).toLocaleString()} kcal/day
            </Text>
            {isAdjusted && (
              <Text style={[
                wpStyles.sliderDelta,
                dailyDelta < 0 ? wpStyles.sliderDeltaLess : wpStyles.sliderDeltaMore,
              ]}>
                {dailyDelta > 0 ? "+" : "−"}{Math.abs(Math.round(dailyDelta))} from your avg
              </Text>
            )}
            {!isAdjusted && (
              <Text style={wpStyles.sliderDeltaNeutral}>your current average</Text>
            )}
          </View>

          <Slider
            style={wpStyles.slider}
            minimumValue={Math.max(500, baseCalories - 800)}
            maximumValue={baseCalories + 1000}
            step={50}
            value={sliderCalories}
            onValueChange={setSliderCalories}
            minimumTrackTintColor={isAdjusted ? "#C48A1A" : "#1A1A14"}
            maximumTrackTintColor="rgba(26,26,20,0.15)"
            thumbTintColor={isAdjusted ? "#C48A1A" : "#1A1A14"}
          />

          {/* Projection summary */}
          <View style={wpStyles.sliderSummary}>
            <Text style={wpStyles.sliderSummaryLabel}>
              {isAdjusted ? "Hypothetical rate" : "Your current rate"}
            </Text>
            <Text style={[
              wpStyles.sliderSummaryRate,
              adjustedWeeklyChangeKg < -0.05 ? wpStyles.sliderRateLoss
                : adjustedWeeklyChangeKg > 0.05 ? wpStyles.sliderRateGain
                : wpStyles.sliderRateNeutral,
            ]}>
              {adjustedWeeklyChangeKg === 0 ? "Maintaining"
                : `${adjustedWeeklyChangeKg > 0 ? "+" : "−"}${Math.abs(adjustedWeeklyChangeKg).toFixed(2)} kg/wk`}
            </Text>
          </View>

          {adjustedGoalDate != null && (
            <Text style={wpStyles.sliderGoalDate}>
              {isAdjusted ? "Hypothetical goal date: " : "Goal date: "}
              <Text style={wpStyles.sliderGoalDateBold}>{adjustedGoalDate}</Text>
            </Text>
          )}

          {!isAdjusted && (
            <Text style={wpStyles.sliderHint}>
              Drag to explore hypothetical paces
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const wpStyles = StyleSheet.create({
  rangeRow: {
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    marginBottom: 12,
  },
  rangePill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 100,
    backgroundColor: "rgba(26,26,20,0.07)",
  },
  rangePillActive: {
    backgroundColor: "#1A1A14",
  },
  rangePillText: {
    fontFamily: "Chillax-Medium",
    fontSize: 12,
    color: "rgba(26,26,20,0.45)",
  },
  rangePillTextActive: {
    color: "#E3D517",
  },
  chartCard: {
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderWidth: 1.5,
    borderColor: "#F5D834",
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 4,
    overflow: "hidden",
  },
  disclaimer: {
    marginTop: 8,
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.35)",
    fontStyle: "italic",
    textAlign: "center",
  },
  sliderCard: {
    marginTop: 14,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderWidth: 1.5,
    borderColor: "rgba(26,26,20,0.1)",
    padding: 16,
  },
  sliderCardAdjusted: {
    borderColor: "#C48A1A",
    backgroundColor: "#FFFBEC",
  },
  sliderHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sliderTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 15,
    color: "#1A1A14",
  },
  resetBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 100,
    backgroundColor: "#1A1A14",
  },
  resetBtnText: {
    fontFamily: "Chillax-Medium",
    fontSize: 11,
    color: "#E3D517",
  },
  sliderValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    marginBottom: 4,
  },
  sliderKcal: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 22,
    color: "#1A1A14",
  },
  sliderDelta: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
  },
  sliderDeltaLess: {
    color: "#2e7d32",
  },
  sliderDeltaMore: {
    color: "#c0392b",
  },
  sliderDeltaNeutral: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.4)",
  },
  slider: {
    width: "100%",
    height: 36,
    marginVertical: 2,
  },
  sliderSummary: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
  },
  sliderSummaryLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.45)",
  },
  sliderSummaryRate: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 14,
  },
  sliderRateLoss: { color: "#2e7d32" },
  sliderRateGain: { color: "#c0392b" },
  sliderRateNeutral: { color: "#1A1A14" },
  sliderGoalDate: {
    marginTop: 6,
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.5)",
  },
  sliderGoalDateBold: {
    fontFamily: "Chillax-Medium",
    color: "#1A1A14",
  },
  sliderHint: {
    marginTop: 8,
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.3)",
    fontStyle: "italic",
    textAlign: "center",
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

function WeightTrendChart({ entries, unit }: { entries: WeightLogEntry[]; unit: "kg" | "lb" }) {
  const { width: windowWidth } = useWindowDimensions();

  if (entries.length === 0) {
    return (
      <View style={weightStyles.trendEmptyBox}>
        <Text style={weightStyles.trendEmptyText}>Log a few weights to see your trend</Text>
      </View>
    );
  }

  if (entries.length === 1) {
    return (
      <View style={weightStyles.trendEmptyBox}>
        <Text style={weightStyles.trendEmptyText}>Add another entry to see your trend</Text>
      </View>
    );
  }

  // Chart dimensions — card has 24px padding each side; container has 24px each side
  const CHART_W = windowWidth - 96;
  const CHART_H = 130;
  const PAD_L   = 40;
  const PAD_R   = 8;
  const PAD_T   = 14;
  const PAD_B   = 26;
  const plotW   = CHART_W - PAD_L - PAD_R;
  const plotH   = CHART_H - PAD_T - PAD_B;

  // Ascending (oldest left, newest right)
  const asc    = [...entries].reverse();
  const values = asc.map(e => kgToDisplay(e.weight_kg, unit));
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const spread = maxVal - minVal;

  // Y padding so dots don't touch the top/bottom edges
  const yPad = spread > 0 ? spread * 0.25 : 1;
  const yMin  = minVal - yPad;
  const yMax  = maxVal + yPad;
  const yRange = yMax - yMin;

  const toX = (i: number) =>
    PAD_L + (asc.length === 1 ? plotW / 2 : (i / (asc.length - 1)) * plotW);
  const toY = (v: number) => PAD_T + (1 - (v - yMin) / yRange) * plotH;

  // SVG line path
  const linePath = asc
    .map((_, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)},${toY(values[i]).toFixed(1)}`)
    .join(" ");

  // Area fill path (closes down to the baseline)
  const baseline = PAD_T + plotH;
  const areaPath =
    linePath +
    ` L ${toX(asc.length - 1).toFixed(1)},${baseline}` +
    ` L ${toX(0).toFixed(1)},${baseline} Z`;

  // Show at most 3 X-axis labels (first, middle, last)
  const xLabelIdx = new Set([0, Math.floor((asc.length - 1) / 2), asc.length - 1]);

  const fmtAxisDate = (dateStr: string) => {
    const d = parseDateStringToLocalDate(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const yLabelDecimals = spread < 2 ? 1 : 0;

  return (
    <Svg width={CHART_W} height={CHART_H}>
      <Defs>
        <SvgLinearGradient id="wTrendFill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor="#C48A1A" stopOpacity={0.15} />
          <Stop offset="100%" stopColor="#C48A1A" stopOpacity={0} />
        </SvgLinearGradient>
      </Defs>

      {/* Area fill */}
      <SvgPath d={areaPath} fill="url(#wTrendFill)" />

      {/* Trend line */}
      <SvgPath
        d={linePath}
        fill="none"
        stroke="#C48A1A"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Data points — latest dot is filled, others are hollow */}
      {asc.map((e, i) => {
        const isLatest = i === asc.length - 1;
        return (
          <Circle
            key={e.log_date}
            cx={toX(i)}
            cy={toY(values[i])}
            r={isLatest ? 4.5 : 3}
            fill={isLatest ? "#C48A1A" : "#fff"}
            stroke="#C48A1A"
            strokeWidth={isLatest ? 0 : 1.5}
          />
        );
      })}

      {/* Y-axis labels (min and max) */}
      <SvgText
        x={PAD_L - 4}
        y={PAD_T + 4}
        textAnchor="end"
        fontSize={10}
        fontFamily="Inter"
        fill="rgba(26,26,20,0.4)"
      >
        {maxVal.toFixed(yLabelDecimals)}
      </SvgText>
      <SvgText
        x={PAD_L - 4}
        y={PAD_T + plotH}
        textAnchor="end"
        fontSize={10}
        fontFamily="Inter"
        fill="rgba(26,26,20,0.4)"
      >
        {minVal.toFixed(yLabelDecimals)}
      </SvgText>

      {/* X-axis labels */}
      {asc.map((e, i) =>
        xLabelIdx.has(i) ? (
          <SvgText
            key={e.log_date}
            x={toX(i)}
            y={CHART_H - 4}
            textAnchor={i === 0 ? "start" : i === asc.length - 1 ? "end" : "middle"}
            fontSize={10}
            fontFamily="Inter"
            fill="rgba(26,26,20,0.4)"
          >
            {fmtAxisDate(e.log_date)}
          </SvgText>
        ) : null
      )}
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CardioScreen — Plan Mode
// Users tap waypoints on the map; the route snaps to real walking paths via
// OSRM's free public routing API. Distance updates live as points are added.
// ─────────────────────────────────────────────────────────────────────────────

type LatLng = { latitude: number; longitude: number };
type RouteSegment = { coords: LatLng[]; distanceKm: number };

const OSRM_FOOT = "https://router.project-osrm.org/route/v1/foot";

async function fetchOsrmRoute(a: LatLng, b: LatLng): Promise<RouteSegment | null> {
  try {
    const url = `${OSRM_FOOT}/${a.longitude},${a.latitude};${b.longitude},${b.latitude}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.code !== "Ok" || !json.routes?.[0]) return null;
    const route = json.routes[0];
    const coords: LatLng[] = route.geometry.coordinates.map(
      ([lng, lat]: [number, number]) => ({ latitude: lat, longitude: lng })
    );
    return { coords, distanceKm: route.distance / 1000 };
  } catch {
    return null;
  }
}

const KM_TO_MI = 0.621371;

function formatDistance(km: number, unit: "km" | "mi" = "km"): string {
  if (unit === "mi") {
    const mi = km * KM_TO_MI;
    if (mi < 0.1) return `${Math.round(mi * 5280)} ft`;
    return `${mi.toFixed(2)} mi`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(2)} km`;
}

// Haversine distance between two points in km
function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = (b.latitude - a.latitude) * Math.PI / 180;
  const dLon = (b.longitude - a.longitude) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * Math.PI / 180) *
    Math.cos(b.latitude * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Perpendicular distance from point p to the line segment a→b (in km).
// Used to find which segment a long-press is closest to.
function pointToSegmentDistKm(p: LatLng, a: LatLng, b: LatLng): number {
  const dx = b.longitude - a.longitude;
  const dy = b.latitude - a.latitude;
  if (dx === 0 && dy === 0) return haversineKm(p, a);
  const t = Math.max(0, Math.min(1,
    ((p.longitude - a.longitude) * dx + (p.latitude - a.latitude) * dy) / (dx * dx + dy * dy)
  ));
  return haversineKm(p, { latitude: a.latitude + t * dy, longitude: a.longitude + t * dx });
}

// Straight-line fallback segment when OSRM is unavailable
function straightSegment(a: LatLng, b: LatLng): RouteSegment {
  return { coords: [a, b], distanceKm: haversineKm(a, b) };
}

// Sample up to maxPts evenly from an array
function sampleCoords(coords: LatLng[], maxPts: number): LatLng[] {
  if (coords.length <= maxPts) return coords;
  const step = (coords.length - 1) / (maxPts - 1);
  return Array.from({ length: maxPts }, (_, i) => coords[Math.round(i * step)]);
}

async function fetchElevation(coords: LatLng[]): Promise<number[] | null> {
  try {
    const sampled = sampleCoords(coords, 60);
    const res = await fetch("https://api.open-elevation.com/api/v1/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ locations: sampled.map(c => ({ latitude: c.latitude, longitude: c.longitude })) }),
    });
    const json = await res.json();
    if (!json.results) return null;
    return (json.results as { elevation: number }[]).map(r => r.elevation);
  } catch {
    return null;
  }
}

function ElevationSparkline({ profile }: { profile: number[] }) {
  const W = 280;
  const H = 48;
  const PAD = 4;
  const min = Math.min(...profile);
  const max = Math.max(...profile);
  const range = max - min || 1;
  const pts = profile.map((e, i) => {
    const x = PAD + (i / (profile.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (e - min) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return (
    <View style={cardioStyles.sparklineWrap}>
      <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <SvgPolyline
          points={pts}
          fill="none"
          stroke="#E86F2C"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

type SavedRoute = {
  id: string;
  name: string;
  distance_km: number;
  elev_gain_m: number | null;
  waypoints: LatLng[];
  created_at: string;
};

function CardioScreen({ onBack, weightKg, userId, onLocationFound }: {
  onBack: () => void;
  weightKg: number | null;
  userId: string | null;
  onLocationFound?: (loc: { latitude: number; longitude: number }) => void;
}) {
  const insets = useSafeAreaInsets();
  const [locationGranted, setLocationGranted] = useState<boolean | null>(null);
  const [userLocation, setUserLocation] = useState<LatLng | null>(null);
  const [waypoints, setWaypoints] = useState<LatLng[]>([]);
  const [segments, setSegments] = useState<RouteSegment[]>([]);
  const [totalKm, setTotalKm] = useState(0);
  const [routing, setRouting] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const [elevGainM, setElevGainM] = useState<number | null>(null);
  const [elevProfile, setElevProfile] = useState<number[] | null>(null);
  // Pace in min/km — default 6:00/km (comfortable run)
  const [paceMinPerKm, setPaceMinPerKm] = useState(6);
  const [unit, setUnit] = useState<"km" | "mi">("km");
  const unitRef = useRef<"km" | "mi">("km");
  useEffect(() => { unitRef.current = unit; }, [unit]);
  // Save modal
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [routeName, setRouteName] = useState("");
  const [saving, setSaving] = useState(false);
  // History view
  const [view, setView] = useState<"plan" | "history">("plan");
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const mapRef = useRef<MapView>(null);
  // Stable refs so async callbacks always see the latest state
  const waypointsRef = useRef(waypoints);
  const segmentsRef  = useRef(segments);
  useEffect(() => { waypointsRef.current = waypoints; }, [waypoints]);
  useEffect(() => { segmentsRef.current  = segments;  }, [segments]);

  // Debounced elevation fetch — fires 700ms after segments settle
  useEffect(() => {
    if (segments.length === 0) {
      setElevGainM(null);
      setElevProfile(null);
      return;
    }
    const allCoords = segments.flatMap(s => s.coords);
    const timer = setTimeout(async () => {
      const elevs = await fetchElevation(allCoords);
      if (!elevs || elevs.length < 2) return;
      let gain = 0;
      for (let i = 1; i < elevs.length; i++) {
        const delta = elevs[i] - elevs[i - 1];
        if (delta > 0) gain += delta;
      }
      setElevGainM(Math.round(gain));
      setElevProfile(elevs);
    }, 700);
    return () => clearTimeout(timer);
  }, [segments]);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") { setLocationGranted(false); return; }
      setLocationGranted(true);
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const pt = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      setUserLocation(pt);
      onLocationFound?.(pt);
      mapRef.current?.animateToRegion({ ...pt, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 800);
    })();
  }, []);

  // Tap → append waypoint to end of route
  const handleMapPress = useCallback(async (e: any) => {
    const tapped: LatLng = e.nativeEvent.coordinate;
    const wps = waypointsRef.current;
    const prev = wps[wps.length - 1];

    if (prev) {
      setRouting(true);
      const seg = await fetchOsrmRoute(prev, tapped) ?? straightSegment(prev, tapped);
      setRouting(false);
      setSegments(s => [...s, seg]);
      setTotalKm(k => k + seg.distanceKm);
    }

    setWaypoints(w => [...w, tapped]);
  }, []);

  // Long-press → insert waypoint into the nearest existing segment
  const handleLongPress = useCallback(async (e: any) => {
    const tapped: LatLng = e.nativeEvent.coordinate;
    const wps = waypointsRef.current;
    const segs = segmentsRef.current;

    // With 0 or 1 waypoints there's no segment yet — fall through to append
    if (wps.length < 2) {
      handleMapPress(e);
      return;
    }

    // Find the segment closest to the long-pressed point
    let nearestIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < wps.length - 1; i++) {
      const d = pointToSegmentDistKm(tapped, wps[i], wps[i + 1]);
      if (d < minDist) { minDist = d; nearestIdx = i; }
    }

    setRouting(true);
    const [seg1, seg2] = await Promise.all([
      fetchOsrmRoute(wps[nearestIdx], tapped),
      fetchOsrmRoute(tapped, wps[nearestIdx + 1]),
    ]);
    setRouting(false);

    const s1 = seg1 ?? straightSegment(wps[nearestIdx], tapped);
    const s2 = seg2 ?? straightSegment(tapped, wps[nearestIdx + 1]);
    const oldDist = segs[nearestIdx].distanceKm;

    setWaypoints(w => {
      const next = [...w];
      next.splice(nearestIdx + 1, 0, tapped);
      return next;
    });
    setSegments(s => {
      const next = [...s];
      next.splice(nearestIdx, 1, s1, s2);
      return next;
    });
    setTotalKm(k => Math.max(0, k - oldDist + s1.distanceKm + s2.distanceKm));
  }, [handleMapPress]);

  // Drag existing marker → re-snap the two segments touching it
  const handleMarkerDrag = useCallback(async (index: number, newCoord: LatLng) => {
    const wps = waypointsRef.current;
    const segs = segmentsRef.current;

    const newWps = [...wps];
    newWps[index] = newCoord;

    setRouting(true);

    const fetches: Promise<RouteSegment | null>[] = [];
    if (index > 0)             fetches.push(fetchOsrmRoute(newWps[index - 1], newCoord));
    if (index < wps.length - 1) fetches.push(fetchOsrmRoute(newCoord, newWps[index + 1]));
    const results = await Promise.all(fetches);

    const newSegs = [...segs];
    let kmDelta = 0;
    let ri = 0;

    if (index > 0) {
      const old = segs[index - 1];
      const fresh = results[ri++] ?? straightSegment(newWps[index - 1], newCoord);
      kmDelta += fresh.distanceKm - old.distanceKm;
      newSegs[index - 1] = fresh;
    }
    if (index < wps.length - 1) {
      const old = segs[index];
      const fresh = results[ri++] ?? straightSegment(newCoord, newWps[index + 1]);
      kmDelta += fresh.distanceKm - old.distanceKm;
      newSegs[index] = fresh;
    }

    setRouting(false);
    setWaypoints(newWps);
    setSegments(newSegs);
    setTotalKm(k => Math.max(0, k + kmDelta));
  }, []);

  const handleDeleteWaypoint = useCallback(async (index: number) => {
    const wps = waypointsRef.current;
    const segs = segmentsRef.current;

    if (wps.length === 1) {
      // Only one point — just clear everything
      setWaypoints([]);
      setSegments([]);
      setTotalKm(0);
      return;
    }

    if (index === 0) {
      // Remove first point and the segment leading out of it
      setTotalKm(k => Math.max(0, k - segs[0].distanceKm));
      setSegments(s => s.slice(1));
      setWaypoints(w => w.slice(1));
      return;
    }

    if (index === wps.length - 1) {
      // Remove last point and the segment leading into it
      setTotalKm(k => Math.max(0, k - segs[segs.length - 1].distanceKm));
      setSegments(s => s.slice(0, -1));
      setWaypoints(w => w.slice(0, -1));
      return;
    }

    // Middle point — replace two surrounding segments with one re-fetched segment
    const before = wps[index - 1];
    const after  = wps[index + 1];
    const removedKm = segs[index - 1].distanceKm + segs[index].distanceKm;

    setRouting(true);
    const newSeg = await fetchOsrmRoute(before, after) ?? straightSegment(before, after);
    setRouting(false);

    setWaypoints(w => w.filter((_, i) => i !== index));
    setSegments(s => {
      const next = [...s];
      next.splice(index - 1, 2, newSeg);
      return next;
    });
    setTotalKm(k => Math.max(0, k - removedKm + newSeg.distanceKm));
  }, []);

  const handleCloseLoop = useCallback(async () => {
    const wps = waypointsRef.current;
    const segs = segmentsRef.current;
    if (wps.length < 2) return;
    const first = wps[0];
    const last  = wps[wps.length - 1];
    // Don't add a loop segment if already very close to start (~30 m)
    if (haversineKm(first, last) < 0.03) return;
    setRouting(true);
    const seg = await fetchOsrmRoute(last, first) ?? straightSegment(last, first);
    setRouting(false);
    setSegments(s => [...s, seg]);
    setTotalKm(k => k + seg.distanceKm);
    // Add the start point again so the polyline visually closes
    setWaypoints(w => [...w, { ...first }]);
  }, []);

  const handleRecenter = useCallback(() => {
    const loc = userLocation;
    if (!loc) return;
    mapRef.current?.animateToRegion({ ...loc, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 500);
  }, [userLocation]);

  const handleUndo = useCallback(() => {
    const wps = waypointsRef.current;
    const segs = segmentsRef.current;
    if (wps.length === 0) return;
    if (segs.length > 0) {
      setTotalKm(k => Math.max(0, k - segs[segs.length - 1].distanceKm));
      setSegments(s => s.slice(0, -1));
    }
    setWaypoints(w => w.slice(0, -1));
  }, []);

  const handleClear = useCallback(() => {
    setWaypoints([]);
    setSegments([]);
    setTotalKm(0);
    setElevGainM(null);
    setElevProfile(null);
  }, []);

  const handleSave = useCallback(() => {
    if (waypointsRef.current.length < 2) return;
    setRouteName(`${formatDistance(totalKm, unit)} route`);
    setShowSaveModal(true);
  }, [totalKm]);

  const handleConfirmSave = useCallback(async () => {
    const wps = waypointsRef.current;
    if (!userId || wps.length < 2 || !routeName.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("cardio_routes").insert({
      user_id:     userId,
      name:        routeName.trim(),
      waypoints:   wps,
      distance_km: Math.round(totalKm * 1000) / 1000,
      elev_gain_m: elevGainM,
    });
    setSaving(false);
    setShowSaveModal(false);
    if (!error) {
      // Refresh history cache so it's ready when user opens History
      loadHistory();
    }
  }, [userId, routeName, totalKm, elevGainM]);

  const loadHistory = useCallback(async () => {
    if (!userId) return;
    setLoadingHistory(true);
    const { data } = await supabase
      .from("cardio_routes")
      .select("id, name, distance_km, elev_gain_m, waypoints, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    setSavedRoutes((data ?? []) as SavedRoute[]);
    setLoadingHistory(false);
  }, [userId]);

  const handleOpenHistory = useCallback(() => {
    setView("history");
    loadHistory();
  }, [loadHistory]);

  const handleLoadRoute = useCallback(async (route: SavedRoute) => {
    setView("plan");
    setLoadingRoute(true);
    handleClear();
    const wps: LatLng[] = route.waypoints;
    // Re-fetch all segments for the loaded waypoints
    const newSegs: RouteSegment[] = [];
    for (let i = 0; i < wps.length - 1; i++) {
      const seg = await fetchOsrmRoute(wps[i], wps[i + 1]) ?? straightSegment(wps[i], wps[i + 1]);
      newSegs.push(seg);
    }
    const km = newSegs.reduce((s, seg) => s + seg.distanceKm, 0);
    setWaypoints(wps);
    setSegments(newSegs);
    setTotalKm(km);
    setLoadingRoute(false);
    // Fit map to loaded route
    if (wps.length > 0) {
      const lats = wps.map(p => p.latitude);
      const lngs = wps.map(p => p.longitude);
      mapRef.current?.animateToRegion({
        latitude:      (Math.min(...lats) + Math.max(...lats)) / 2,
        longitude:     (Math.min(...lngs) + Math.max(...lngs)) / 2,
        latitudeDelta:  Math.max(Math.max(...lats) - Math.min(...lats), 0.005) * 1.4,
        longitudeDelta: Math.max(Math.max(...lngs) - Math.min(...lngs), 0.005) * 1.4,
      }, 800);
    }
  }, [handleClear]);

  const handleDeleteRoute = useCallback(async (id: string) => {
    await supabase.from("cardio_routes").delete().eq("id", id);
    setSavedRoutes(r => r.filter(x => x.id !== id));
  }, []);

  const initialRegion = userLocation
    ? { ...userLocation, latitudeDelta: 0.01, longitudeDelta: 0.01 }
    : { latitude: 37.7749, longitude: -122.4194, latitudeDelta: 0.05, longitudeDelta: 0.05 };

  // Estimated time at current pace
  const estTotalMin = totalKm * paceMinPerKm;
  const estTimeStr = totalKm > 0
    ? estTotalMin < 60
      ? `~${Math.round(estTotalMin)} min`
      : `~${Math.floor(estTotalMin / 60)}h ${Math.round(estTotalMin % 60)}m`
    : null;

  // MET-based calorie estimate — pace determines intensity
  const met = paceMinPerKm >= 8 ? 3.5 : paceMinPerKm >= 5 ? 7.0 : 10.0;
  const estCalories = totalKm > 0 && weightKg
    ? Math.round(met * weightKg * (estTotalMin / 60))
    : null;

  // Pace display — convert to /mi when in miles mode
  const paceDisplay = unit === "mi" ? paceMinPerKm / KM_TO_MI : paceMinPerKm;
  const paceStr = `${Math.floor(paceDisplay)}:${String(Math.round((paceDisplay % 1) * 60)).padStart(2, "0")}`;
  const paceUnitLabel = unit === "mi" ? "/mi" : "/km";
  // Pace display step — always 15 sec in the active unit, converted to min/km for storage.
  // Reads from unitRef so the callback is never stale after a unit toggle.
  const paceStep = unit === "mi" ? 0.25 * KM_TO_MI : 0.25;
  const adjustPace = useCallback((dir: 1 | -1) => {
    setPaceMinPerKm(p => {
      const step = unitRef.current === "mi" ? 0.25 * KM_TO_MI : 0.25;
      return Math.min(20, Math.max(3, Math.round((p + dir * step) * 100) / 100));
    });
  }, []);

  // Elevation in ft when miles mode
  const elevDisplay = elevGainM != null
    ? unit === "mi"
      ? `↑${Math.round(elevGainM * 3.28084)} ft`
      : `↑${elevGainM} m`
    : null;

  const hintText = waypoints.length === 0
    ? "Tap to place your starting point"
    : routing
      ? "Routing…"
      : waypoints.length === 1
        ? "Tap to continue · long-press to insert · drag dots to adjust"
        : "Tap to extend · long-press to insert · drag dots to adjust";

  return (
    <View style={cardioStyles.container}>
      <View style={[cardioStyles.header, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={onBack} style={cardioStyles.backBtn} activeOpacity={0.75}>
          <Ionicons name="chevron-back" size={22} color="#1A1A14" />
          <Text style={cardioStyles.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={cardioStyles.title}>{view === "history" ? "My Routes" : "Plan Route"}</Text>
        <TouchableOpacity
          style={cardioStyles.historyBtn}
          onPress={view === "history" ? () => setView("plan") : handleOpenHistory}
          activeOpacity={0.75}
        >
          <Ionicons name={view === "history" ? "map-outline" : "list-outline"} size={20} color="#E86F2C" />
        </TouchableOpacity>
      </View>

      {/* Save name modal */}
      <Modal visible={showSaveModal} transparent animationType="fade" onRequestClose={() => setShowSaveModal(false)}>
        <View style={cardioStyles.modalOverlay}>
          <View style={cardioStyles.modalBox}>
            <Text style={cardioStyles.modalTitle}>Name this route</Text>
            <TextInput
              style={cardioStyles.modalInput}
              value={routeName}
              onChangeText={setRouteName}
              placeholder="e.g. Morning loop"
              placeholderTextColor="#aaa"
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleConfirmSave}
            />
            <View style={cardioStyles.modalBtnRow}>
              <TouchableOpacity style={cardioStyles.modalCancelBtn} onPress={() => setShowSaveModal(false)} activeOpacity={0.75}>
                <Text style={cardioStyles.modalCancelLabel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[cardioStyles.modalSaveBtn, (!routeName.trim() || saving) && { opacity: 0.5 }]} onPress={handleConfirmSave} disabled={!routeName.trim() || saving} activeOpacity={0.75}>
                <Text style={cardioStyles.modalSaveLabel}>{saving ? "Saving…" : "Save"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Loading overlay when re-fetching a saved route */}
      {loadingRoute && (
        <View style={cardioStyles.loadingOverlay}>
          <ActivityIndicator size="large" color="#E86F2C" />
          <Text style={cardioStyles.loadingText}>Loading route…</Text>
        </View>
      )}

      {view === "history" ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={cardioStyles.historyList}>
          {loadingHistory ? (
            <ActivityIndicator size="large" color="#E86F2C" style={{ marginTop: 40 }} />
          ) : savedRoutes.length === 0 ? (
            <View style={cardioStyles.historyEmpty}>
              <Ionicons name="map-outline" size={40} color="#ccc" />
              <Text style={cardioStyles.historyEmptyText}>No saved routes yet</Text>
            </View>
          ) : savedRoutes.map(route => (
            <View key={route.id} style={cardioStyles.historyCard}>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => handleLoadRoute(route)} activeOpacity={0.75}>
                <Text style={cardioStyles.historyCardName}>{route.name}</Text>
                <Text style={cardioStyles.historyCardMeta}>
                  {formatDistance(route.distance_km, unit)}
                  {route.elev_gain_m != null
                    ? unit === "mi"
                      ? `  ↑${Math.round(route.elev_gain_m * 3.28084)} ft`
                      : `  ↑${route.elev_gain_m} m`
                    : ""}
                  {"  ·  "}
                  {new Date(route.created_at).toLocaleDateString()}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleDeleteRoute(route.id)} activeOpacity={0.75} style={cardioStyles.historyDeleteBtn}>
                <Ionicons name="trash-outline" size={18} color="#ccc" />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      ) : locationGranted === false ? (
        <View style={cardioStyles.permissionBox}>
          <Text style={cardioStyles.permissionText}>
            Location access is needed to center the map on your neighborhood.
            Enable it in Settings → Lume → Location.
          </Text>
        </View>
      ) : (
        <>
          <View style={cardioStyles.hintBar}>
            <Text style={cardioStyles.hintText}>{hintText}</Text>
          </View>

          {/* Floating map controls */}
          <View style={cardioStyles.mapControls}>
            <TouchableOpacity style={cardioStyles.mapBtn} onPress={() => setSatellite(s => !s)} activeOpacity={0.8}>
              <Ionicons name={satellite ? "map-outline" : "layers-outline"} size={20} color="#1A1A14" />
            </TouchableOpacity>
            {userLocation && (
              <TouchableOpacity style={cardioStyles.mapBtn} onPress={handleRecenter} activeOpacity={0.8}>
                <Ionicons name="locate" size={20} color="#1A1A14" />
              </TouchableOpacity>
            )}
          </View>

          <MapView
            ref={mapRef}
            style={cardioStyles.map}
            provider={PROVIDER_DEFAULT}
            mapType={satellite ? "hybrid" : "standard"}
            initialRegion={initialRegion}
            onPress={handleMapPress}
            onLongPress={handleLongPress}
            showsUserLocation
            showsMyLocationButton={false}
          >
            {segments.map((seg, i) => (
              <Polyline
                key={`seg-${i}`}
                coordinates={seg.coords}
                strokeColor="#E86F2C"
                strokeWidth={4}
              />
            ))}
            {waypoints.map((pt, i) => (
              <Marker
                key={`wp-${i}`}
                coordinate={pt}
                anchor={{ x: 0.5, y: 0.5 }}
                draggable
                onDragEnd={(e) => handleMarkerDrag(i, e.nativeEvent.coordinate)}
              >
                <View style={[
                  cardioStyles.dot,
                  i === 0 && cardioStyles.dotStart,
                  i === waypoints.length - 1 && i !== 0 && cardioStyles.dotEnd,
                ]} />
                <Callout tooltip onPress={() => handleDeleteWaypoint(i)}>
                  <View style={cardioStyles.callout}>
                    <Ionicons name="trash" size={16} color="#fff" />
                  </View>
                </Callout>
              </Marker>
            ))}
          </MapView>

          <View style={[cardioStyles.panel, { paddingBottom: insets.bottom + 12 }]}>
            {/* Stats row */}
            <View style={cardioStyles.statsRow}>
              <Text style={cardioStyles.distanceText}>
                {totalKm > 0 ? formatDistance(totalKm, unit) : unit === "mi" ? "0 mi" : "0 m"}
              </Text>
              {(estTimeStr || estCalories || elevDisplay) && (
                <View style={cardioStyles.subStatsRow}>
                  {estTimeStr && <Text style={cardioStyles.estTimeText}>{estTimeStr}</Text>}
                  {estTimeStr && estCalories && <Text style={cardioStyles.estTimeSep}>·</Text>}
                  {estCalories && <Text style={cardioStyles.estTimeText}>~{estCalories} kcal</Text>}
                  {(estTimeStr || estCalories) && elevDisplay && <Text style={cardioStyles.estTimeSep}>·</Text>}
                  {elevDisplay && <Text style={cardioStyles.elevText}>{elevDisplay}</Text>}
                </View>
              )}
              {elevProfile && elevProfile.length > 1 && (
                <ElevationSparkline profile={elevProfile} />
              )}
            </View>

            {/* Pace picker */}
            <View style={cardioStyles.paceRow}>
              <Text style={cardioStyles.paceLabel}>Pace</Text>
              <TouchableOpacity style={cardioStyles.paceBtn} onPress={() => adjustPace(-1)} activeOpacity={0.7}>
                <Ionicons name="remove" size={18} color="#1A1A14" />
              </TouchableOpacity>
              <Text style={cardioStyles.paceValue}>{paceStr} <Text style={cardioStyles.paceUnit}>{paceUnitLabel}</Text></Text>
              <TouchableOpacity style={cardioStyles.paceBtn} onPress={() => adjustPace(1)} activeOpacity={0.7}>
                <Ionicons name="add" size={18} color="#1A1A14" />
              </TouchableOpacity>
            </View>

            {/* km / mi toggle */}
            <View style={cardioStyles.unitToggleRow}>
              <TouchableOpacity
                style={[cardioStyles.unitBtn, unit === "km" && cardioStyles.unitBtnActive]}
                onPress={() => setUnit("km")}
                activeOpacity={0.8}
              >
                <Text style={[cardioStyles.unitBtnLabel, unit === "km" && cardioStyles.unitBtnLabelActive]}>km</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[cardioStyles.unitBtn, unit === "mi" && cardioStyles.unitBtnActive]}
                onPress={() => setUnit("mi")}
                activeOpacity={0.8}
              >
                <Text style={[cardioStyles.unitBtnLabel, unit === "mi" && cardioStyles.unitBtnLabelActive]}>mi</Text>
              </TouchableOpacity>
            </View>

            {/* Utility buttons */}
            <View style={cardioStyles.btnRow}>
              <TouchableOpacity
                style={[cardioStyles.ctrlBtn, { flex: 1 }, waypoints.length === 0 && cardioStyles.ctrlBtnDisabled]}
                onPress={handleUndo}
                disabled={waypoints.length === 0}
                activeOpacity={0.75}
              >
                <Ionicons name="arrow-undo" size={18} color={waypoints.length === 0 ? "#ccc" : "#1A1A14"} />
                <Text style={[cardioStyles.ctrlBtnLabel, waypoints.length === 0 && { color: "#ccc" }]}>Undo</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[cardioStyles.ctrlBtn, { flex: 1 }, waypoints.length === 0 && cardioStyles.ctrlBtnDisabled]}
                onPress={handleClear}
                disabled={waypoints.length === 0}
                activeOpacity={0.75}
              >
                <Ionicons name="trash-outline" size={18} color={waypoints.length === 0 ? "#ccc" : "#1A1A14"} />
                <Text style={[cardioStyles.ctrlBtnLabel, waypoints.length === 0 && { color: "#ccc" }]}>Clear</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[cardioStyles.ctrlBtn, { flex: 1 }, waypoints.length < 2 && cardioStyles.ctrlBtnDisabled]}
                onPress={handleCloseLoop}
                disabled={waypoints.length < 2}
                activeOpacity={0.75}
              >
                <Ionicons name="refresh-circle-outline" size={18} color={waypoints.length < 2 ? "#ccc" : "#1A1A14"} />
                <Text style={[cardioStyles.ctrlBtnLabel, waypoints.length < 2 && { color: "#ccc" }]}>Loop</Text>
              </TouchableOpacity>
            </View>

            {/* Full-width save button */}
            <TouchableOpacity
              style={[cardioStyles.saveBtn, waypoints.length < 2 && cardioStyles.ctrlBtnDisabled]}
              onPress={handleSave}
              disabled={waypoints.length < 2}
              activeOpacity={0.75}
            >
              <Text style={cardioStyles.saveBtnLabel}>Save Route</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

const cardioStyles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#fff",
    zIndex: 100,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "#FFFEF8",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.06)",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    width: 70,
  },
  backLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 16,
    color: "#1A1A14",
  },
  title: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 18,
    color: "#1A1A14",
    letterSpacing: -0.3,
  },
  hintBar: {
    backgroundColor: "rgba(255,254,248,0.95)",
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.04)",
  },
  hintText: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "#6B6B5E",
  },
  map: {
    flex: 1,
  },
  mapControls: {
    position: "absolute",
    right: 14,
    top: 130,
    zIndex: 10,
    gap: 10,
  },
  mapBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#FFFEF8",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  statsRow: {
    alignItems: "center",
    gap: 2,
  },
  subStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  estTimeText: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#6B6B5E",
    textAlign: "center",
  },
  estTimeSep: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#C0C0B0",
  },
  elevText: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#E86F2C",
  },
  sparklineWrap: {
    marginTop: 6,
    alignItems: "center",
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#E86F2C",
    borderWidth: 2,
    borderColor: "#fff",
  },
  dotStart: {
    backgroundColor: "#4CAF50",
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  dotEnd: {
    backgroundColor: "#E86F2C",
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  callout: {
    backgroundColor: "#1A1A14",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  panel: {
    backgroundColor: "#FFFEF8",
    paddingTop: 16,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.06)",
    gap: 14,
  },
  distanceText: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 36,
    color: "#1A1A14",
    textAlign: "center",
    letterSpacing: -1,
  },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  savedText: {
    fontFamily: "Inter-Variable",
    fontSize: 16,
    color: "#4CAF50",
  },
  paceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  paceLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "#6B6B5E",
    marginRight: 4,
  },
  paceBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(0,0,0,0.05)",
    alignItems: "center",
    justifyContent: "center",
  },
  paceValue: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 18,
    color: "#1A1A14",
    minWidth: 70,
    textAlign: "center",
  },
  paceUnit: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "#6B6B5E",
  },
  unitToggleRow: {
    flexDirection: "row",
    alignSelf: "center",
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.05)",
    padding: 3,
    gap: 2,
  },
  unitBtn: {
    paddingVertical: 5,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  unitBtnActive: {
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  unitBtnLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    fontWeight: "600",
    color: "#6B6B5E",
  },
  unitBtnLabelActive: {
    color: "#1A1A14",
  },
  btnRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  ctrlBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  ctrlBtnDisabled: {
    opacity: 0.4,
  },
  ctrlBtnLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "#1A1A14",
    fontWeight: "500",
  },
  saveBtn: {
    alignItems: "center",
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: "#E86F2C",
  },
  saveBtnLabel: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 16,
    color: "#fff",
    letterSpacing: -0.2,
  },
  permissionBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  permissionText: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#6B6B5E",
    textAlign: "center",
    lineHeight: 22,
  },
  historyBtn: {
    width: 70,
    alignItems: "flex-end",
  },
  historyList: {
    padding: 16,
    gap: 12,
  },
  historyEmpty: {
    alignItems: "center",
    marginTop: 60,
    gap: 12,
  },
  historyEmptyText: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#aaa",
  },
  historyCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFEF8",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  historyCardName: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 16,
    color: "#1A1A14",
    marginBottom: 4,
  },
  historyCardMeta: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "#6B6B5E",
  },
  historyDeleteBtn: {
    padding: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  modalBox: {
    backgroundColor: "#FFFEF8",
    borderRadius: 18,
    padding: 24,
    width: "80%",
    gap: 16,
  },
  modalTitle: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 18,
    color: "#1A1A14",
    textAlign: "center",
  },
  modalInput: {
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.12)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#1A1A14",
  },
  modalBtnRow: {
    flexDirection: "row",
    gap: 10,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  modalCancelLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#6B6B5E",
  },
  modalSaveBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "#E86F2C",
  },
  modalSaveLabel: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 15,
    color: "#fff",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,254,248,0.88)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 20,
    gap: 12,
  },
  loadingText: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#6B6B5E",
  },
});

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
  goal_weight_kg:          number | null;
  kg_to_goal:              number | null;
  goal_direction:          "lose" | "gain" | "maintain" | null;
  estimated_weeks_to_goal: number | null;
  projected_goal_date:     string | null;
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
  const [goalKg,      setGoalKg]      = useState<number | null>(null);
  const [goalInput,   setGoalInput]   = useState("");
  const [goalSaving,  setGoalSaving]  = useState(false);
  const [goalMessage, setGoalMessage] = useState("");

  const parsedDisplay = parseFloat(input);
  const parsedKg      = !isNaN(parsedDisplay) ? displayToKg(parsedDisplay, unit) : NaN;
  const inputValid    = !isNaN(parsedKg) && parsedKg >= 20 && parsedKg <= 500;

  const parsedGoalDisplay = parseFloat(goalInput);
  const parsedGoalKg      = !isNaN(parsedGoalDisplay) ? displayToKg(parsedGoalDisplay, unit) : NaN;
  const goalInputValid    = !isNaN(parsedGoalKg) && parsedGoalKg >= 20 && parsedGoalKg <= 500;

  // loadData accepts the active unit so input is set in the right unit after
  // load or save, without relying on stale closure state.
  const loadData = async (uid: string, activeUnit: "kg" | "lb") => {
    try {
      const { data: rows } = await supabase
        .from("weight_logs")
        .select("log_date, weight_kg")
        .eq("user_id", uid)
        .order("log_date", { ascending: false })
        .limit(14);

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

  const loadGoalWeight = async (activeUnit: "kg" | "lb") => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const res = await axios.get<{ profile: { goal_weight_kg: number | null } | null }>(
        `${API_URL}/profile`,
        { headers: { Authorization: `Bearer ${session.access_token}` } },
      );
      const gw = res.data.profile?.goal_weight_kg ?? null;
      setGoalKg(gw != null ? Number(gw) : null);
      if (gw != null) setGoalInput(String(kgToDisplay(Number(gw), activeUnit)));
    } catch {
      // silently ignore
    }
  };

  const saveGoalWeight = async () => {
    if (!goalInputValid) return;
    setGoalSaving(true);
    setGoalMessage("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const rounded = Math.round(parsedGoalKg * 10) / 10;
      await axios.put(
        `${API_URL}/profile`,
        { goal_weight_kg: rounded },
        { headers: { Authorization: `Bearer ${session.access_token}` } },
      );
      setGoalKg(rounded);
      fetchPrediction();
    } catch {
      setGoalMessage("Failed to save. Please try again.");
    } finally {
      setGoalSaving(false);
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
      // Run weight-log load, goal weight load, and prediction fetch in parallel.
      await Promise.all([loadData(user.id, "kg"), loadGoalWeight("kg"), fetchPrediction()]);
    })();
  }, []);

  // When the unit toggle is tapped, convert current weight input and goal input in-place.
  const switchUnit = (newUnit: "kg" | "lb") => {
    if (newUnit === unit) return;
    const parsed = parseFloat(input);
    if (!isNaN(parsed) && parsed > 0) {
      const asKg      = displayToKg(parsed, unit);
      const converted = kgToDisplay(asKg, newUnit);
      setInput(String(converted));
    }
    const parsedGoal = parseFloat(goalInput);
    if (!isNaN(parsedGoal) && parsedGoal > 0) {
      const asKg      = displayToKg(parsedGoal, unit);
      const converted = kgToDisplay(asKg, newUnit);
      setGoalInput(String(converted));
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
            <Ionicons name="arrow-back" size={18} color="#1A1A14" />
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

          {/* ── Goal weight ────────────────────────────────────────────── */}
          {loaded && (
            <View style={weightStyles.card}>
              <View style={weightStyles.cardHeaderRow}>
                <View style={weightStyles.cardHeader}>
                  <Ionicons name="flag-outline" size={19} color="#C48A1A" />
                  <Text style={weightStyles.cardHeading}>Goal weight</Text>
                </View>
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

              {goalKg != null && (
                <Text style={weightStyles.savedDisplay}>
                  {kgToDisplay(goalKg, unit)} {unit}
                </Text>
              )}

              <View style={weightStyles.inputRow}>
                <TextInput
                  style={weightStyles.weightInput}
                  value={goalInput}
                  onChangeText={t => { setGoalInput(t); setGoalMessage(""); }}
                  placeholder={goalKg == null
                    ? (unit === "kg" ? "Set a goal weight" : "Set a goal weight")
                    : (unit === "kg" ? "e.g. 68" : "e.g. 150")}
                  placeholderTextColor="rgba(26,26,20,0.3)"
                  keyboardType="decimal-pad"
                  returnKeyType="done"
                  maxLength={7}
                  inputAccessoryViewID="goal-weight-input-accessory"
                />
                <Text style={weightStyles.unitLabel}>{unit}</Text>
              </View>
              {Platform.OS === "ios" && (
                <InputAccessoryView nativeID="goal-weight-input-accessory" />
              )}

              {goalMessage !== "" && (
                <Text style={weightStyles.errorText}>{goalMessage}</Text>
              )}

              <TouchableOpacity
                style={[
                  weightStyles.saveBtn,
                  (!goalInputValid || goalSaving) && weightStyles.saveBtnDisabled,
                ]}
                onPress={saveGoalWeight}
                disabled={!goalInputValid || goalSaving}
                activeOpacity={0.8}
              >
                <Text style={weightStyles.saveBtnText}>
                  {goalSaving ? "Saving…" : goalKg != null ? "Update goal" : "Set goal"}
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

          {/* ── Trend chart ────────────────────────────────────────────── */}
          {loaded && (
            <View style={weightStyles.trendCard}>
              <View style={weightStyles.cardHeader}>
                <Ionicons name="pulse-outline" size={17} color="#C48A1A" />
                <Text style={weightStyles.cardHeading}>Trend</Text>
              </View>
              <WeightTrendChart entries={history} unit={unit} />
            </View>
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

                {/* ── Goal progress ──────────────────────────────── */}
                {prediction.goal_weight_kg != null && (() => {
                  const gw        = prediction.goal_weight_kg!;
                  const remaining = prediction.kg_to_goal != null ? Math.abs(prediction.kg_to_goal) : null;
                  const reached   = prediction.goal_direction === "maintain";
                  const trending  = prediction.estimated_weeks_to_goal != null;
                  const notMoving = !reached && !trending && prediction.goal_direction != null;

                  const fmtGoalDate = (iso: string): string => {
                    const d = new Date(iso + "T00:00:00");
                    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  };

                  return (
                    <>
                      <View style={weightStyles.predDivider} />

                      {reached ? (
                        <Text style={weightStyles.predGoalReached}>Goal reached 🎉</Text>
                      ) : (
                        <>
                          <View style={weightStyles.predRow}>
                            <Text style={weightStyles.predLabel}>Goal weight</Text>
                            <Text style={weightStyles.predValue}>
                              {kgToDisplay(gw, unit)} {unit}
                            </Text>
                          </View>

                          {remaining != null && (
                            <View style={weightStyles.predRow}>
                              <Text style={weightStyles.predLabel}>Remaining</Text>
                              <Text style={weightStyles.predValue}>
                                {kgToDisplay(remaining, unit)} {unit}
                              </Text>
                            </View>
                          )}

                          {trending && (
                            <>
                              <View style={weightStyles.predRow}>
                                <Text style={weightStyles.predLabel}>Est. weeks</Text>
                                <Text style={weightStyles.predValue}>
                                  {prediction.estimated_weeks_to_goal} wks
                                </Text>
                              </View>
                              {prediction.projected_goal_date != null && (
                                <View style={weightStyles.predRow}>
                                  <Text style={weightStyles.predLabel}>Goal date</Text>
                                  <Text style={weightStyles.predValue}>
                                    {fmtGoalDate(prediction.projected_goal_date)}
                                  </Text>
                                </View>
                              )}
                            </>
                          )}

                          {notMoving && (
                            <Text style={weightStyles.predNote}>
                              At your current pace, you are not trending toward your goal yet.
                            </Text>
                          )}
                        </>
                      )}
                    </>
                  );
                })()}

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
    backgroundColor: "rgba(250,250,247,0.9)",
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
    backgroundColor: "rgba(250,250,247,0.9)",
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
    borderColor: "rgba(26,26,20,0.12)",
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

  // ── Trend chart card ──────────────────────────────────────────────────────
  trendCard: {
    borderRadius: 20,
    padding: 24,
    backgroundColor: "rgba(250,250,247,0.9)",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
    marginTop: 16,
  },
  trendEmptyBox: {
    paddingVertical: 18,
    alignItems: "center",
  },
  trendEmptyText: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "rgba(26,26,20,0.4)",
    textAlign: "center",
  },

  // ── Prediction card ────────────────────────────────────────────────────────
  predCard: {
    borderRadius: 20,
    padding: 24,
    backgroundColor: "rgba(250,250,247,0.9)",
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
  predGoalReached: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 15,
    color: "#1A1A14",
    textAlign: "center",
    paddingVertical: 8,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// MultiLogScreen
// ─────────────────────────────────────────────────────────────────────────────

type ParsedItem = {
  original_line:       string;
  name:                string;
  calories:            number;
  protein:             number;
  carbs:               number;
  fat:                 number;
  source_type:         string | null;
  confidence:          number | null;
  is_estimated:        boolean;
  serving_description: string | null;
  parse_error:         boolean;
  error_message:       string | null;
};

function MultiLogScreen({
  selectedDate,
  onBack,
  onDone,
}: {
  selectedDate: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [phase,          setPhase]          = useState<"idle" | "parsing" | "reviewing" | "logging">("idle");
  const [rawInput,       setRawInput]       = useState("");
  const [items,          setItems]          = useState<ParsedItem[]>([]);
  const [removedIndices, setRemovedIndices] = useState<Set<number>>(new Set());
  const [multipliers,    setMultipliers]    = useState<Record<number, string>>({});
  const [parseError,     setParseError]     = useState("");
  const [logProgress,    setLogProgress]    = useState(0);
  const [logTotal,       setLogTotal]       = useState(0);
  const [logFailed,      setLogFailed]      = useState<string[]>([]);

  // Strict qty parser: normalises comma-decimals, rejects partial parses,
  // zero, and negatives.  Returns null for anything that should not be logged.
  const parseQty = (raw: string): number | null => {
    const s = (raw ?? "").trim();
    if (!s) return null;
    const normalized = s.replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
    const v = parseFloat(normalized);
    return isFinite(v) && v > 0 ? v : null;
  };

  const getMultiplier = (i: number): number =>
    parseQty(multipliers[i] ?? "1") ?? 1;

  const isQtyValid = (i: number): boolean =>
    parseQty(multipliers[i] ?? "1") !== null;

  const validCount = items.filter(
    (item, i) => !item.parse_error && !removedIndices.has(i),
  ).length;

  const hasInvalidQty = items.some(
    (item, i) => !item.parse_error && !removedIndices.has(i) && !isQtyValid(i),
  );

  const totals = items.reduce(
    (acc, item, i) => {
      if (item.parse_error || removedIndices.has(i)) return acc;
      const m = getMultiplier(i);
      return {
        calories: acc.calories + item.calories * m,
        protein:  acc.protein  + item.protein  * m,
        carbs:    acc.carbs    + item.carbs    * m,
        fat:      acc.fat      + item.fat      * m,
      };
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  const handleParse = async () => {
    const trimmed = rawInput.trim();
    if (!trimmed) return;
    setPhase("parsing");
    setParseError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : {};
      const res = await axios.post<{ items: ParsedItem[]; skipped: number }>(
        `${API_URL}/food/parse-multi`,
        { text: trimmed },
        { headers },
      );
      setItems(res.data.items);
      setRemovedIndices(new Set());
      setMultipliers({});
      setPhase("reviewing");
    } catch (err: any) {
      setParseError(err?.response?.data?.detail ?? "Failed to parse. Please try again.");
      setPhase("idle");
    }
  };

  const removeItem = (index: number) => {
    setRemovedIndices(prev => new Set([...prev, index]));
  };

  const handleLog = async () => {
    // Build ordered list of items to log, preserving original indices for multiplier lookup.
    const toLog = items
      .map((item, i) => ({ item, i }))
      .filter(({ item, i }) => !item.parse_error && !removedIndices.has(i));

    if (toLog.length === 0) return;
    setPhase("logging");
    setLogProgress(0);
    setLogTotal(toLog.length);
    setLogFailed([]);

    const { data: { session } } = await supabase.auth.getSession();
    const headers = session?.access_token
      ? { Authorization: `Bearer ${session.access_token}` }
      : {};

    const failed: string[] = [];
    for (let idx = 0; idx < toLog.length; idx++) {
      const { item, i } = toLog[idx];
      const m = getMultiplier(i);
      try {
        await axios.post(
          `${API_URL}/logs`,
          {
            name:                item.name,
            calories:            Math.round(item.calories * m * 10) / 10,
            protein:             Math.round(item.protein  * m * 10) / 10,
            carbs:               Math.round(item.carbs    * m * 10) / 10,
            fat:                 Math.round(item.fat      * m * 10) / 10,
            log_date:            selectedDate,
            source_type:         item.source_type,
            confidence:          item.confidence,
            is_estimated:        item.is_estimated,
            serving_description: item.serving_description,
            serving_quantity:    m,
            serving_unit:        "serving",
            base_calories:       item.calories,
            base_protein:        item.protein,
            base_carbs:          item.carbs,
            base_fat:            item.fat,
          },
          { headers },
        );
        setLogProgress(idx + 1);
      } catch {
        failed.push(item.name);
      }
    }

    setLogFailed(failed);
    if (failed.length === 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDone();
    } else {
      setPhase("reviewing");
    }
  };

  const handleBack = () => {
    if (phase === "logging") return;
    if (phase === "reviewing") {
      setItems([]);
      setRemovedIndices(new Set());
      setMultipliers({});
      setPhase("idle");
    } else {
      onBack();
    }
  };

  const inReview = phase === "reviewing" || phase === "logging";

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
            onPress={handleBack}
            style={[setupStyles.acctBackButton, phase === "logging" && mlStyles.backDisabled]}
            activeOpacity={phase === "logging" ? 1 : 0.7}
          >
            <Ionicons name="arrow-back" size={18} color="#1A1A14" />
            <Text style={setupStyles.acctBackText}>
              {phase === "reviewing" ? "Edit input" : "Back"}
            </Text>
          </TouchableOpacity>

          <Text style={setupStyles.headline}>
            {inReview ? "Review items" : "Log a meal"}
          </Text>

          {/* ── Idle / Parsing ──────────────────────────────────────────── */}
          {!inReview && (
            <>
              <Text style={weightStyles.subhead}>
                Paste your foods — one item per line.
              </Text>

              <View style={mlStyles.inputCard}>
                <TextInput
                  style={mlStyles.multilineInput}
                  value={rawInput}
                  onChangeText={setRawInput}
                  placeholder={"e.g.\n2 eggs\n1 cup oatmeal\nbanana"}
                  placeholderTextColor="rgba(26,26,20,0.3)"
                  multiline
                  numberOfLines={6}
                  autoCapitalize="none"
                  editable={phase === "idle"}
                  textAlignVertical="top"
                />
              </View>

              {parseError !== "" && (
                <Text style={mlStyles.parseErrorText}>{parseError}</Text>
              )}

              <TouchableOpacity
                style={[
                  mlStyles.actionBtn,
                  (phase === "parsing" || !rawInput.trim()) && mlStyles.actionBtnDisabled,
                ]}
                onPress={handleParse}
                disabled={phase === "parsing" || !rawInput.trim()}
                activeOpacity={0.8}
              >
                <Text style={mlStyles.actionBtnText}>
                  {phase === "parsing" ? "Parsing…" : "Parse foods"}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {/* ── Reviewing / Logging ─────────────────────────────────────── */}
          {inReview && (
            <>
              {items.map((item, index) => {
                if (removedIndices.has(index)) return null;
                const m = getMultiplier(index);
                return (
                  <View
                    key={index}
                    style={item.parse_error ? mlStyles.errorItemCard : mlStyles.itemCard}
                  >
                    <View style={mlStyles.itemHeaderRow}>
                      <Text
                        style={item.parse_error ? mlStyles.itemNameError : mlStyles.itemName}
                        numberOfLines={2}
                      >
                        {item.name}
                      </Text>
                      {!item.parse_error && (
                        <TouchableOpacity
                          onPress={() => removeItem(index)}
                          style={mlStyles.removeBtn}
                          activeOpacity={0.7}
                          disabled={phase === "logging"}
                        >
                          <Ionicons name="close" size={18} color="rgba(26,26,20,0.45)" />
                        </TouchableOpacity>
                      )}
                    </View>

                    {item.parse_error ? (
                      <Text style={mlStyles.itemErrorMsg} numberOfLines={2}>
                        Could not parse this item
                      </Text>
                    ) : (
                      <>
                        <Text style={mlStyles.itemMacros}>
                          {Math.round(item.calories * m)} cal ·{" "}
                          {(item.protein * m).toFixed(1)}g P ·{" "}
                          {(item.carbs * m).toFixed(1)}g C ·{" "}
                          {(item.fat * m).toFixed(1)}g F
                        </Text>
                        <View style={mlStyles.multRow}>
                          <Text style={mlStyles.multLabel}>qty</Text>
                          <TextInput
                            style={[
                              mlStyles.multInput,
                              !isQtyValid(index) && mlStyles.multInputError,
                            ]}
                            value={multipliers[index] ?? "1"}
                            onChangeText={t =>
                              setMultipliers(prev => ({ ...prev, [index]: t }))
                            }
                            keyboardType="decimal-pad"
                            returnKeyType="done"
                            maxLength={5}
                            selectTextOnFocus
                            editable={phase !== "logging"}
                          />
                        </View>
                        {!isQtyValid(index) && (
                          <Text style={mlStyles.qtyWarning}>
                            Enter a positive number (e.g. 0.5, 1, 2)
                          </Text>
                        )}
                      </>
                    )}
                  </View>
                );
              })}

              {/* Totals */}
              {validCount > 0 && (
                <View style={mlStyles.totalsCard}>
                  <Text style={mlStyles.totalsLabel}>
                    {validCount} item{validCount !== 1 ? "s" : ""}
                  </Text>
                  <Text style={mlStyles.totalsMacros}>
                    {Math.round(totals.calories)} cal · {totals.protein.toFixed(1)}g P ·{" "}
                    {totals.carbs.toFixed(1)}g C · {totals.fat.toFixed(1)}g F
                  </Text>
                </View>
              )}

              {/* Log button / progress */}
              {phase === "logging" ? (
                <Text style={mlStyles.logProgressText}>
                  Logging {logProgress} of {logTotal}…
                </Text>
              ) : (
                <TouchableOpacity
                  style={[
                    mlStyles.actionBtn,
                    (validCount === 0 || hasInvalidQty) && mlStyles.actionBtnDisabled,
                  ]}
                  onPress={handleLog}
                  disabled={validCount === 0 || hasInvalidQty}
                  activeOpacity={0.8}
                >
                  <Text style={mlStyles.actionBtnText}>
                    {validCount === 0
                      ? "No items to log"
                      : hasInvalidQty
                      ? "Fix qty to log"
                      : `Log ${validCount} item${validCount !== 1 ? "s" : ""}`}
                  </Text>
                </TouchableOpacity>
              )}

              {logFailed.length > 0 && (
                <Text style={mlStyles.parseErrorText}>
                  Failed to log: {logFailed.join(", ")}
                </Text>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const mlStyles = StyleSheet.create({
  backDisabled: {
    opacity: 0.35,
  },
  inputCard: {
    backgroundColor: "rgba(250,250,247,0.9)",
    borderRadius: 20,
    padding: 20,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
    marginBottom: 16,
  },
  multilineInput: {
    fontFamily: "Inter-Variable",
    fontSize: 15,
    color: "#1A1A14",
    minHeight: 140,
    lineHeight: 22,
  },
  parseErrorText: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#c62828",
    marginBottom: 10,
    lineHeight: 17,
  },
  actionBtn: {
    backgroundColor: "#1A1A14",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
    marginBottom: 16,
  },
  actionBtnDisabled: {
    opacity: 0.4,
  },
  actionBtnText: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 16,
    color: "#F8E94A",
    letterSpacing: -0.2,
  },
  itemCard: {
    backgroundColor: "rgba(250,250,247,0.9)",
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  errorItemCard: {
    backgroundColor: "#fff5f5",
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(198,40,40,0.15)",
  },
  itemHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 6,
  },
  itemName: {
    fontFamily: "Chillax-Medium",
    fontSize: 14,
    color: "#1A1A14",
    flex: 1,
    marginRight: 8,
    letterSpacing: -0.2,
  },
  itemNameError: {
    fontFamily: "Chillax-Medium",
    fontSize: 14,
    color: "#c62828",
    flex: 1,
    letterSpacing: -0.2,
  },
  removeBtn: {
    padding: 2,
  },
  itemMacros: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.5)",
    lineHeight: 17,
  },
  itemErrorMsg: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#c62828",
    lineHeight: 17,
  },
  totalsCard: {
    backgroundColor: "rgba(248,233,74,0.18)",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginBottom: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  totalsLabel: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 13,
    color: "#1A1A14",
    letterSpacing: -0.2,
  },
  totalsMacros: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "rgba(26,26,20,0.6)",
    flexShrink: 1,
    textAlign: "right",
    marginLeft: 8,
  },
  logProgressText: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "rgba(26,26,20,0.55)",
    textAlign: "center",
    paddingVertical: 16,
  },
  multRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 8,
    gap: 6,
  },
  multLabel: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "rgba(26,26,20,0.4)",
    letterSpacing: 0.2,
  },
  multInput: {
    width: 56,
    borderWidth: 1,
    borderColor: "rgba(26,26,20,0.15)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "#1A1A14",
    textAlign: "right",
    backgroundColor: "#FAFAF7",
  },
  multInputError: {
    borderColor: "#D9534F",
    backgroundColor: "#FFF5F5",
  },
  qtyWarning: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: "#D9534F",
    textAlign: "right",
    marginTop: 3,
  },
});

// ── GreetingHeader ────────────────────────────────────────────────────────────

function getGreetingTime(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function getCalorieMessage(todayCalories: number | null, calorieGoal: number): string {
  if (todayCalories === null) return "Let's get your first meal logged.";
  const diff = todayCalories - calorieGoal;
  if (diff > 200)  return "You've exceeded your calorie goal today.";
  if (diff > 0)    return "Almost at your calorie goal — nice work.";
  if (diff > -300) return "You're right on track today.";
  return "Plenty of room left in your calorie budget.";
}

function GreetingHeader({
  displayName,
  todayCalories,
  calorieGoal,
}: {
  displayName: string | null;
  todayCalories: number | null;
  calorieGoal: number;
}) {
  const greeting = getGreetingTime();
  const name     = displayName ? `, ${displayName.split(" ")[0]}` : "";
  const message  = getCalorieMessage(todayCalories, calorieGoal);

  return (
    <View style={greetingStyles.container}>
      <Text style={greetingStyles.heading}>{greeting}{name}</Text>
      <Text style={greetingStyles.sub}>{message}</Text>
    </View>
  );
}

const greetingStyles = StyleSheet.create({
  container: {
    marginBottom: 8,
  },
  heading: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 26,
    color: "#1A1A14",
    letterSpacing: -0.5,
  },
  sub: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: COLORS.textSecondary,
    marginTop: 3,
  },
});

// ── CalorieProgressBar ────────────────────────────────────────────────────────

function CalorieProgressBar({ consumed, goal }: { consumed: number; goal: number }) {
  const pct     = goal > 0 ? Math.min(1, consumed / goal) : 0;
  const over    = consumed > goal;
  const barColor = over ? "#E57373" : COLORS.primary;

  return (
    <View style={calorieBarStyles.container}>
      <View style={calorieBarStyles.track}>
        <View style={[calorieBarStyles.fill, { width: `${Math.round(pct * 100)}%` as any, backgroundColor: barColor }]} />
      </View>
      <View style={calorieBarStyles.labels}>
        <Text style={calorieBarStyles.consumed}>{Math.round(consumed)} kcal</Text>
        <Text style={calorieBarStyles.goal}>goal {Math.round(goal)}</Text>
      </View>
    </View>
  );
}

const calorieBarStyles = StyleSheet.create({
  container: {
    marginTop: 10,
    marginBottom: 4,
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "#EDECDF",
    overflow: "hidden",
  },
  fill: {
    height: 6,
    borderRadius: 3,
  },
  labels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 5,
  },
  consumed: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#1A1A14",
    fontWeight: "600",
  },
  goal: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: COLORS.textSecondary,
  },
});

// ── MacroPills ────────────────────────────────────────────────────────────────

const computeMacroTargets = (calorieGoal: number) => ({
  protein: Math.round(calorieGoal * 0.30 / 4),
  carbs:   Math.round(calorieGoal * 0.40 / 4),
  fat:     Math.round(calorieGoal * 0.30 / 9),
});

const MACRO_COLORS = {
  protein: { track: "#E8F5E9", fill: "#66BB6A", over: "#E57373" },
  carbs:   { track: "#FFF8E1", fill: "#FFD54F", over: "#E57373" },
  fat:     { track: "#FCE4EC", fill: "#F06292", over: "#E57373" },
};

function MacroPill({
  label,
  consumed,
  target,
  colors,
}: {
  label: string;
  consumed: number;
  target: number;
  colors: { track: string; fill: string; over: string };
}) {
  const pct      = target > 0 ? Math.min(1, consumed / target) : 0;
  const over     = consumed > target;
  const fillColor = over ? colors.over : colors.fill;

  return (
    <View style={macroPillStyles.pill}>
      <View style={macroPillStyles.pillHeader}>
        <Text style={macroPillStyles.label}>{label}</Text>
        <Text style={[macroPillStyles.value, over && macroPillStyles.valueOver]}>
          {Math.round(consumed)}<Text style={macroPillStyles.target}>/{target}g</Text>
        </Text>
      </View>
      <View style={[macroPillStyles.track, { backgroundColor: colors.track }]}>
        <View style={[macroPillStyles.fill, { width: `${Math.round(pct * 100)}%` as any, backgroundColor: fillColor }]} />
      </View>
    </View>
  );
}

function MacroPills({
  protein,
  carbs,
  fat,
  calorieGoal,
}: {
  protein: number;
  carbs: number;
  fat: number;
  calorieGoal: number;
}) {
  const targets = computeMacroTargets(calorieGoal);

  return (
    <View style={macroPillStyles.row}>
      <MacroPill label="Protein" consumed={protein} target={targets.protein} colors={MACRO_COLORS.protein} />
      <MacroPill label="Carbs"   consumed={carbs}   target={targets.carbs}   colors={MACRO_COLORS.carbs}   />
      <MacroPill label="Fat"     consumed={fat}      target={targets.fat}     colors={MACRO_COLORS.fat}     />
    </View>
  );
}

const macroPillStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    marginBottom: 4,
  },
  pill: {
    flex: 1,
    backgroundColor: "#FAFAF5",
    borderRadius: 12,
    padding: 10,
  },
  pillHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 6,
  },
  label: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: COLORS.textSecondary,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  value: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: "#1A1A14",
    fontWeight: "700",
  },
  valueOver: {
    color: "#E57373",
  },
  target: {
    fontFamily: "Inter-Variable",
    fontSize: 11,
    color: COLORS.textSecondary,
    fontWeight: "400",
  },
  track: {
    height: 5,
    borderRadius: 3,
    overflow: "hidden",
  },
  fill: {
    height: 5,
    borderRadius: 3,
  },
});

// ── DailyInsight ──────────────────────────────────────────────────────────────

function getDailyInsight(
  summary: { total_calories: number; total_protein: number },
  calorieGoal: number,
  weeklyData: { date: string; total_calories: number }[],
): { text: string; icon: string } {
  const proteinTarget = computeMacroTargets(calorieGoal).protein;
  const loggedDays    = weeklyData.filter(d => d.total_calories > 0);
  const avgCalories   = loggedDays.length > 0
    ? loggedDays.reduce((s, d) => s + d.total_calories, 0) / loggedDays.length
    : null;

  if (avgCalories !== null && avgCalories > calorieGoal + 200) {
    return {
      icon: "📈",
      text: `You've averaged ${Math.round(avgCalories - calorieGoal)} kcal over your goal this week.`,
    };
  }
  if (avgCalories !== null && avgCalories < calorieGoal - 300) {
    return {
      icon: "⚠️",
      text: `You've been under your calorie goal this week — make sure you're eating enough.`,
    };
  }
  if (summary.total_protein < proteinTarget - 20) {
    return {
      icon: "💪",
      text: `Protein is running low today (${Math.round(summary.total_protein)}g of ${proteinTarget}g). Consider a high-protein snack.`,
    };
  }
  if (Math.abs(summary.total_calories - calorieGoal) <= 100) {
    return {
      icon: "✅",
      text: `You're right on track with your calorie goal today.`,
    };
  }
  return {
    icon: "📊",
    text: `Keep logging to see your weekly trends.`,
  };
}

function DailyInsight({
  summary,
  calorieGoal,
  weeklyData,
}: {
  summary: { total_calories: number; total_protein: number };
  calorieGoal: number;
  weeklyData: { date: string; total_calories: number }[];
}) {
  const { icon, text } = getDailyInsight(summary, calorieGoal, weeklyData);

  return (
    <View style={insightStyles.container}>
      <Text style={insightStyles.icon}>{icon}</Text>
      <Text style={insightStyles.text}>{text}</Text>
    </View>
  );
}

const insightStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#FAFAF5",
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    gap: 8,
  },
  icon: {
    fontSize: 16,
    lineHeight: 20,
  },
  text: {
    flex: 1,
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "#1A1A14",
    lineHeight: 18,
  },
});

// ── StreakCard ────────────────────────────────────────────────────────────────

function StreakCard({ streak }: { streak: number }) {
  const label = streak === 1 ? "day streak" : "day streak";
  const message = streak >= 7
    ? "You're on fire — keep it up!"
    : streak >= 3
    ? "Great consistency this week."
    : "Good start — keep logging daily.";

  return (
    <View style={streakStyles.card}>
      <Text style={streakStyles.flame}>🔥</Text>
      <View style={streakStyles.content}>
        <Text style={streakStyles.count}>{streak} <Text style={streakStyles.label}>{label}</Text></Text>
        <Text style={streakStyles.message}>{message}</Text>
      </View>
    </View>
  );
}

const streakStyles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFF8E1",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
    gap: 12,
  },
  flame: {
    fontSize: 28,
  },
  content: {
    flex: 1,
  },
  count: {
    fontFamily: "Chillax-SemiBold",
    fontSize: 20,
    color: "#1A1A14",
    letterSpacing: -0.3,
  },
  label: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: COLORS.textSecondary,
    fontWeight: "400",
  },
  message: {
    fontFamily: "Inter-Variable",
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
});

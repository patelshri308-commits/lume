import { useState, useEffect, useRef } from "react";
import { Platform, Modal } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
const barcodIcon = require("./assets/barcode.png");
import { useFonts } from "expo-font";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import {
  Alert,
  Image,
  RefreshControl,
  View,
  Text,
  TextInput,
  Button,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import axios from "axios";
import { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { API_URL } from "./lib/config";

type NutritionResult = {
  name:         string;
  calories:     number;
  protein:      number;
  carbs:        number;
  fat:          number;
  is_estimated: boolean;
  source_type?:         string;   // "barcode" for scanned results, absent for text search
  brand_name?:          string | null;
  serving_description?: string | null;
};

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

export default function App() {
  const [fontsLoaded] = useFonts({
    "Chillax-Regular": require("./assets/fonts/Chillax-Regular.otf"),
    "Chillax-Medium":  require("./assets/fonts/Chillax-Medium.otf"),
    "Inter-Variable":  require("./assets/fonts/Inter-VariableFont_opsz,wght.ttf"),
  });

  const [query,      setQuery]      = useState("");
  const [logMessage, setLogMessage] = useState("");
  const [logs,       setLogs]       = useState<FoodLogEntry[]>([]);
  const [showAllLogs, setShowAllLogs] = useState(false);
  const [summary,    setSummary]    = useState<DailySummary | null>(null);
  const [todayCalories, setTodayCalories] = useState<number | null>(null);
  const [searching,     setSearching]     = useState(false);
  const [logsLoading,   setLogsLoading]   = useState(false);
  const [summaryLoading,setSummaryLoading]= useState(false);
  const [deletingLogId, setDeletingLogId] = useState<number | null>(null);
  const [editingLogId,  setEditingLogId]  = useState<number | null>(null);
  const [editFields,    setEditFields]    = useState({ name: "", calories: "", protein: "", carbs: "", fat: "" });
  const [savingEdit,    setSavingEdit]    = useState(false);
  const [isScannerOpen,  setIsScannerOpen]  = useState(false);
  const [scannedBarcode, setScannedBarcode] = useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanLockRef = useRef(false);  // prevents duplicate scan callbacks
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

  // Initialise session on mount and listen for auth changes.
  // onAuthStateChange fires INITIAL_SESSION immediately on subscription (Supabase v2),
  // so a separate getSession() call is not needed and would cause a duplicate setSession.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
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
        },
        { headers: await getAuthHeaders() },
      );
      setQuery("");      // clear input for next item
      setLogMessage("Food logged");
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
    } else {
      loadWeekly();
      loadTodayCalories();
    }
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a barcode is scanned, look it up and immediately auto-log it —
  // same pattern as searchAndLog so there is one consistent logging path.
  useEffect(() => {
    if (!scannedBarcode) return;
    const barcode = scannedBarcode;
    setLogMessage("");
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
            },
            { headers: await getAuthHeaders() },
          );
          setLogMessage(`Logged: ${food.name}`);
          await loadSummary();
          await loadLogs();
          await loadWeekly();
          await loadTodayCalories();
        } catch {
          setLogMessage("Failed to log scanned item.");
        }
      } catch {
        setLogMessage("Barcode not found — try searching by name.");
      } finally {
        setScannedBarcode(null);
        setSearching(false);
      }
    })();
  }, [scannedBarcode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wait for custom fonts before rendering anything
  if (!fontsLoaded) return null;

  // ── Auth screen ────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <View style={styles.authContainer}>
          <View style={styles.logoContainer}>
            <Image
              source={require("./assets/Lume.png")}
              style={styles.logo}
              resizeMode="contain"
            />
          </View>
          <Text style={styles.appSubtitle}>Track what you eat</Text>

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#aaa"
            value={authEmail}
            onChangeText={setAuthEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor="#aaa"
            value={authPassword}
            onChangeText={setAuthPassword}
            secureTextEntry
          />

          <View style={styles.authButtons}>
            <View style={styles.authButtonItem}>
              <Button title="Log In" onPress={logIn} />
            </View>
            <View style={styles.authButtonItem}>
              <Button title="Sign Up" onPress={signUp} color="#aaa" />
            </View>
          </View>

          {authMessage ? (
            <Text style={styles.authMessage}>{authMessage}</Text>
          ) : null}
        </View>
      </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  // ── Tracker screen (logged in) ──────────────────────────────────────────────
  return (
    <SafeAreaProvider>
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
          <Image
            source={require("./assets/Lume.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <TouchableOpacity onPress={logOut}>
            <Text style={styles.logOutText}>Log Out</Text>
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
                <Button title="Grant Permission" onPress={requestCameraPermission} />
                <View style={{ marginTop: 12 }}>
                  <Button title="Cancel" onPress={() => setIsScannerOpen(false)} color="#aaa" />
                </View>
              </View>
            ) : (
              <>
                <CameraView
                  style={styles.scannerCamera}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "qr"] }}
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
                </View>
                <View style={styles.scannerActions}>
                  <Button title="Cancel" onPress={() => setIsScannerOpen(false)} color="#aaa" />
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
            <View style={[styles.card, styles.summaryCard]}>
              <Text style={styles.cardTitle}>
                {selectedDate === localToday()
                  ? "Today's Totals"
                  : `Totals — ${formatDateLabel(selectedDate)}`}
              </Text>
              <View style={styles.macroRow}>
                <MacroItem label="Calories" value={`${summary.total_calories}`} unit="kcal" />
                <MacroItem label="Protein"  value={`${summary.total_protein}`}  unit="g" />
                <MacroItem label="Carbs"    value={`${summary.total_carbs}`}    unit="g" />
                <MacroItem label="Fat"      value={`${summary.total_fat}`}      unit="g" />
              </View>
              <Text style={styles.entryCount}>
                {summary.entries_count} {summary.entries_count === 1 ? "entry" : "entries"} logged
              </Text>
            </View>
          )}
        </View>

        {/* Logged Foods */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>LOGGED FOODS</Text>
          {logsLoading && <Text style={styles.searchingText}>Loading logs...</Text>}
          {!logsLoading && logs.length === 0 && (
            <Text style={styles.emptyState}>No food logged yet — let's get your first one in</Text>
          )}
          {!logsLoading && (showAllLogs ? logs : logs.slice(0, 1)).map((entry) => (
            <View key={entry.id} style={styles.logEntry}>
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
                <View style={styles.logEntryRow}>
                  <View style={styles.logEntryText}>
                    <Text style={styles.logEntryName}>{entry.name}</Text>
                    <Text style={styles.logEntryMacros}>
                      {entry.calories} kcal · {entry.protein}g protein · {entry.carbs}g carbs · {entry.fat}g fat
                    </Text>
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
                      <Text style={styles.editButton}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        Alert.alert(
                          "Delete entry",
                          `Remove "${entry.name}" from your log?`,
                          [
                            { text: "Cancel", style: "cancel" },
                            { text: "Delete", style: "destructive", onPress: () => deleteLog(entry.id) },
                          ],
                        );
                      }}
                      disabled={deletingLogId === entry.id}
                    >
                      <Text style={deletingLogId === entry.id ? styles.deleteButtonDisabled : styles.deleteButton}>
                        {deletingLogId === entry.id ? "..." : "Delete"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          ))}
          {!logsLoading && logs.length > 1 && (
            <TouchableOpacity
              onPress={() => setShowAllLogs(v => !v)}
              style={styles.logsToggle}
            >
              <Text style={styles.logsToggleText}>
                {showAllLogs ? "Hide" : `Show all ${logs.length}`}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Weekly Analytics */}
        <View style={styles.section}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={styles.sectionLabel}>LAST 7 DAYS</Text>
            <Text style={styles.sectionLabel}>Cals</Text>
          </View>
          {weeklyLoading && weeklyData.length === 0 && <Text style={styles.searchingText}>Loading...</Text>}
          {weeklyData.length > 0 && (() => {
            const max = Math.max(...weeklyData.map(d => d.total_calories), 1);
            return weeklyData.map((day) => {
              const label = new Date(day.date + "T00:00:00").toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
              const barWidth = `${Math.round((day.total_calories / max) * 100)}%` as `${number}%`;
              return (
                <View key={day.date} style={styles.weekRow}>
                  <Text style={styles.weekLabel}>{label}</Text>
                  <View style={styles.weekBarTrack}>
                    <View style={[styles.weekBarFill, { width: barWidth }]} />
                  </View>
                  <Text style={styles.weekCalories}>
                    {day.total_calories === 0 ? "—" : `${Math.round(day.total_calories)}`}
                  </Text>
                </View>
              );
            });
          })()}
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
            {`${Math.round(todayCalories)} cals`}
          </Text>
        </View>
      )}

      {/* Floating bottom search bar — lives outside the ScrollView so it
          stays pinned at the bottom of the SafeAreaView on all screen sizes.
          SafeAreaView already insets for the home indicator, so no extra
          bottom padding is needed here. */}
      <View style={styles.bottomBar}>
        <View style={styles.inputRow}>
          <TextInput
            placeholder="e.g. banana, grilled chicken..."
            placeholderTextColor="#aaa"
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={searchAndLog}
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
        {searching && <Text style={styles.searchingText}>Searching...</Text>}
        {!searching && logMessage ? (
          <Text style={logMessage.startsWith("Logged") || logMessage === "Food logged" ? styles.success : styles.error}>
            {logMessage}
          </Text>
        ) : null}
      </View>

    </SafeAreaView>
    </SafeAreaProvider>
  );
}

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

const COLORS = {
  primary:      "#E3D517",  // brand yellow
  primaryLight: "#FAF3B0",  // soft yellow for card accents
  textPrimary:  "#111111",
  textSecondary:"#666666",
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#fff",
  },
  // flex:1 ensures the ScrollView fills available space so the bottom bar
  // is always pushed to the bottom rather than floating mid-screen.
  scrollView: {
    flex: 1,
  },
  container: {
    padding: 20,
    paddingBottom: 48,
  },
  // Docked search bar — sits between the ScrollView and the safe-area bottom.
  // Not absolutely positioned: keyboard avoidance works naturally because iOS
  // pushes the whole SafeAreaView up when the keyboard opens.
  bottomBar: {
    borderTopWidth: 1,
    borderTopColor: "#eee",
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },

  // Auth screen
  authContainer: {
    flex: 1,
    padding: 28,
    justifyContent: "center",
  },
  authButtons: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  authButtonItem: {
    flex: 1,
  },
  authMessage: {
    marginTop: 14,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "#555",
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
    color: "#999",
    marginBottom: 16,
  },
  logOutText: {
    fontSize: 13,
    color: "#aaa",
    paddingTop: 8,
  },
  calorieBadge: {
    position: "absolute",
    top: 48,
    right: 20,
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    zIndex: 10,
  },
  calorieBadgeText: {
    fontSize: 12,
    fontFamily: "Inter-Variable",
    fontWeight: "600",
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
    color: "#999",
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
    color: "#aaa",
    letterSpacing: 1.2,
    marginBottom: 10,
  },

  // Input
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    paddingHorizontal: 12,
    marginBottom: 10,
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
    color: "#aaa",
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
  scannerActions: {
    position: "absolute",
    bottom: 48,
    left: 0,
    right: 0,
    alignItems: "center",
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
    color: "#888",
  },
  macroLabel: {
    fontSize: 11,
    fontFamily: "Inter-Variable",
    color: "#aaa",
    marginTop: 2,
  },

  // Summary
  entryCount: {
    marginTop: 12,
    fontSize: 12,
    fontFamily: "Inter-Variable",
    color: "#888",
    textAlign: "center",
  },

  // Log list
  logEntry: {
    marginTop: 10,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#f9f9f9",
    borderWidth: 1,
    borderColor: "#eee",
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
  logEntryName: {
    fontSize: 14,
    fontFamily: "Chillax-Medium",
    marginBottom: 3,
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
    color: "#999",
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
    fontFamily: "Inter-Variable",
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
    fontFamily: "Inter-Variable",
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
});

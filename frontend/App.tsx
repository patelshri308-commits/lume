import { useState, useEffect } from "react";
import { Platform } from "react-native";
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

export default function App() {
  const [fontsLoaded] = useFonts({
    "Chillax-Regular": require("./assets/fonts/Chillax-Regular.otf"),
    "Chillax-Medium":  require("./assets/fonts/Chillax-Medium.otf"),
    "Inter-Variable":  require("./assets/fonts/Inter-VariableFont_opsz,wght.ttf"),
  });

  const [query,      setQuery]      = useState("");
  const [result,     setResult]     = useState<NutritionResult | null>(null);
  const [logMessage, setLogMessage] = useState("");
  const [logs,       setLogs]       = useState<FoodLogEntry[]>([]);
  const [summary,    setSummary]    = useState<DailySummary | null>(null);
  const [searching,     setSearching]     = useState(false);
  const [hasSearched,   setHasSearched]   = useState(false);
  const [logsLoading,   setLogsLoading]   = useState(false);
  const [summaryLoading,setSummaryLoading]= useState(false);
  const [loggingFood,   setLoggingFood]   = useState(false);
  const [deletingLogId, setDeletingLogId] = useState<number | null>(null);
  const [editingLogId,  setEditingLogId]  = useState<number | null>(null);
  const [editFields,    setEditFields]    = useState({ name: "", calories: "", protein: "", carbs: "", fat: "" });
  const [savingEdit,    setSavingEdit]    = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [weeklyData,    setWeeklyData]    = useState<WeeklyDay[]>([]);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [refreshing,    setRefreshing]    = useState(false);
  const [servings,      setServings]      = useState(1);
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

  const searchFood = async () => {
    setLogMessage("");
    setHasSearched(true);

    // Map of supported number words to their integer values
    const NUMBER_WORDS: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4,  five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    };

    // Build a regex that matches a leading digit(s) OR a supported number word, followed by a space
    const wordList   = Object.keys(NUMBER_WORDS).join("|");
    const pattern    = new RegExp(`^(\\d+|${wordList})\\s+(.+)$`, "i");
    const match      = query.trim().match(pattern);

    let parsedServings = 1;
    let foodQuery      = query.trim();

    if (match) {
      const token = match[1].toLowerCase();
      parsedServings = NUMBER_WORDS[token] ?? parseInt(token, 10);
      foodQuery      = match[2].trim();
    }

    setServings(parsedServings);
    setSearching(true);
    try {
      const res = await axios.post(`${API_URL}/food/search`, { query: foodQuery });
      setResult(res.data);
    } catch (err) {
      setLogMessage("Failed to search");
    } finally {
      setSearching(false);
    }
  };

  const logFood = async () => {
    if (!result) return;
    setLoggingFood(true);
    try {
      await axios.post(
        `${API_URL}/logs`,
        {
          name:     result.name,
          calories: result.calories * servings,
          protein:  result.protein  * servings,
          carbs:    result.carbs    * servings,
          fat:      result.fat      * servings,
          log_date: selectedDate,
        },
        { headers: await getAuthHeaders() },
      );
      setLogMessage("Food logged");
      await loadSummary();
      await loadLogs();
      await loadWeekly();
    } catch (err) {
      setLogMessage("Failed to log food");
    } finally {
      setLoggingFood(false);
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

  const deleteLog = async (id: number) => {
    setDeletingLogId(id);
    try {
      await axios.delete(`${API_URL}/logs/${id}`, {
        headers: await getAuthHeaders(),
      });
      await loadSummary();
      await loadLogs();
      await loadWeekly();
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
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  const clearSearch = () => {
    setQuery("");
    setResult(null);
    setLogMessage("");
    setServings(1);
    setHasSearched(false);
  };

  // Reload logs + summary whenever selectedDate OR session changes.
  // session is included so the effect re-runs (with a current, non-stale closure)
  // as soon as a valid token arrives — no request is made until then.
  useEffect(() => {
    if (!session?.access_token || !isValidDate(selectedDate)) return;
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
      setResult(null);
      setLogMessage("");
      setQuery("");
      setServings(1);
    } else {
      loadWeekly();
    }
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived: adjusted nutrition values for the current serving count.
  // The original `result` object is never mutated.
  const adjusted = result
    ? {
        calories: parseFloat((result.calories * servings).toFixed(1)),
        protein:  parseFloat((result.protein  * servings).toFixed(1)),
        carbs:    parseFloat((result.carbs     * servings).toFixed(1)),
        fat:      parseFloat((result.fat       * servings).toFixed(1)),
      }
    : null;

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
            <Text style={styles.dateTriggerText}>{selectedDate}</Text>
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

        {/* Search */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>FOOD SEARCH</Text>
          <TextInput
            placeholder="e.g. banana, grilled chicken..."
            placeholderTextColor="#aaa"
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={searchFood}
            returnKeyType="search"
            autoCapitalize="none"
            style={styles.input}
          />
          <View style={styles.searchButtons}>
            <View style={styles.searchButtonItem}>
              <Button title="Search" onPress={searchFood} disabled={searching} />
            </View>
            <View style={styles.searchButtonItem}>
              <Button title="Clear" onPress={clearSearch} color="#aaa" />
            </View>
          </View>
          <TouchableOpacity
            style={styles.scanButton}
            onPress={() => setIsScannerOpen(true)}
          >
            <Text style={styles.scanButtonText}>Scan Barcode</Text>
          </TouchableOpacity>
          {searching && <Text style={styles.searchingText}>Searching...</Text>}
        </View>

        {/* Search Result */}
        {!result && !searching && !hasSearched && (
          <Text style={styles.emptyState}>Search for a food to see nutrition info</Text>
        )}
        {!result && !searching && hasSearched && (
          <Text style={styles.emptyState}>No results found — try something simpler</Text>
        )}
        {result && adjusted && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{result.name}</Text>
            <View style={styles.macroRow}>
              <MacroItem label="Calories" value={`${adjusted.calories}`} unit="kcal" />
              <MacroItem label="Protein"  value={`${adjusted.protein}`}  unit="g" />
              <MacroItem label="Carbs"    value={`${adjusted.carbs}`}    unit="g" />
              <MacroItem label="Fat"      value={`${adjusted.fat}`}      unit="g" />
            </View>
            {servings > 1 && (
              <Text style={styles.perServing}>
                {result.calories} kcal · {result.protein}g · {result.carbs}g · {result.fat}g per serving
              </Text>
            )}
            <View style={styles.servingRow}>
              <TouchableOpacity
                style={styles.servingButton}
                onPress={() => setServings(s => Math.max(1, s - 1))}
              >
                <Text style={styles.servingButtonText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.servingCount}>{servings} {servings === 1 ? "serving" : "servings"}</Text>
              <TouchableOpacity
                style={styles.servingButton}
                onPress={() => setServings(s => s + 1)}
              >
                <Text style={styles.servingButtonText}>+</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.cardAction}>
              <Button title={loggingFood ? "Logging..." : "Log Food"} onPress={logFood} disabled={loggingFood} />
            </View>
            {result.is_estimated && (
              <Text style={styles.estimatedLabel}>Estimated</Text>
            )}
            <Text style={styles.disclaimer}>
              Nutrition data is estimated and may vary based on brand and preparation.
            </Text>
            {logMessage ? (
              <Text style={!logMessage.startsWith("Failed") ? styles.success : styles.error}>
                {logMessage}
              </Text>
            ) : null}
          </View>
        )}

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
          {!logsLoading && logs.map((entry) => (
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
        </View>

        {/* Weekly Analytics */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>LAST 7 DAYS</Text>
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
  container: {
    padding: 20,
    paddingBottom: 48,
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
  appTitle: {
    fontSize: 34,
    fontFamily: "Chillax-Medium",
    letterSpacing: 1,
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

  // Date selector
  dateSection: {
    marginBottom: 4,
  },
  dateTrigger: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    marginBottom: 4,
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
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter-Variable",
    marginBottom: 10,
    color: "#111",
  },

  searchingText: {
    marginTop: 8,
    fontSize: 13,
    fontFamily: "Inter-Variable",
    color: "#aaa",
  },

  // Search buttons
  searchButtons: {
    flexDirection: "row",
    gap: 10,
  },
  searchButtonItem: {
    flex: 1,
  },

  scanButton: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ccc",
    alignItems: "center",
  },
  scanButtonText: {
    fontSize: 14,
    fontFamily: "Inter-Variable",
    color: "#555",
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
    marginBottom: 12,
    textTransform: "capitalize",
  },
  cardAction: {
    marginTop: 14,
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

  perServing: {
    marginTop: 6,
    fontSize: 11,
    fontFamily: "Inter-Variable",
    color: "#bbb",
    textAlign: "center",
  },

  // Serving control
  servingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 14,
    gap: 16,
  },
  servingButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ccc",
    alignItems: "center",
    justifyContent: "center",
  },
  servingButtonText: {
    fontSize: 18,
    color: "#333",
    lineHeight: 22,
  },
  servingCount: {
    fontSize: 14,
    fontFamily: "Inter-Variable",
    color: "#333",
    minWidth: 80,
    textAlign: "center",
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

  disclaimer: {
    marginTop: 12,
    fontSize: 11,
    fontFamily: "Inter-Variable",
    color: "#bbb",
    textAlign: "center",
  },

  estimatedLabel: {
    marginTop: 10,
    fontSize: 11,
    fontFamily: "Inter-Variable",
    color: "#aaa",
    textAlign: "center",
    fontStyle: "italic",
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

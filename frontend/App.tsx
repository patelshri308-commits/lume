import { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Button,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  TouchableOpacity,
} from "react-native";
import axios from "axios";
import { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";

type NutritionResult = {
  name:     string;
  calories: number;
  protein:  number;
  carbs:    number;
  fat:      number;
};

type FoodLogEntry = NutritionResult & { id: number };

type DailySummary = {
  total_calories: number;
  total_protein:  number;
  total_carbs:    number;
  total_fat:      number;
  entries_count:  number;
};

// Returns today's date as YYYY-MM-DD using local time (not UTC)
function localToday(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

// Returns true only for strings that are valid YYYY-MM-DD dates
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s);
  return !isNaN(d.getTime());
}

export default function App() {
  const [query,      setQuery]      = useState("");
  const [result,     setResult]     = useState<NutritionResult | null>(null);
  const [logMessage, setLogMessage] = useState("");
  const [logs,       setLogs]       = useState<FoodLogEntry[]>([]);
  const [summary,    setSummary]    = useState<DailySummary | null>(null);
  const [searching,     setSearching]     = useState(false);
  const [logsLoading,   setLogsLoading]   = useState(false);
  const [summaryLoading,setSummaryLoading]= useState(false);
  const [loggingFood,   setLoggingFood]   = useState(false);
  const [deletingLogId, setDeletingLogId] = useState<number | null>(null);
  const [servings,      setServings]      = useState(1);
  const [selectedDate,  setSelectedDate]  = useState(localToday());
  const [dateError,     setDateError]     = useState("");

  // Auth state
  const [session,       setSession]       = useState<Session | null>(null);
  const [authEmail,     setAuthEmail]     = useState("");
  const [authPassword,  setAuthPassword]  = useState("");
  const [authMessage,   setAuthMessage]   = useState("");

  // Initialise session on mount and listen for auth changes
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);
  const getAuthHeaders = () => {
  console.log("TOKEN:", session?.access_token);  

  if (!session?.access_token) {
    throw new Error("No active session");
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
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
      const res = await axios.post("http://127.0.0.1:8000/food/search", { query: foodQuery });
      setResult(res.data);
    } catch (err) {
      console.log(err);
    } finally {
      setSearching(false);
    }
  };

  const logFood = async () => {
    if (!result) return;
    setLoggingFood(true);
    try {
      await axios.post(
        "http://127.0.0.1:8000/logs",
        {
          name:     result.name,
          calories: result.calories * servings,
          protein:  result.protein  * servings,
          carbs:    result.carbs    * servings,
          fat:      result.fat      * servings,
          log_date: selectedDate,
        },
        { headers: getAuthHeaders() },
      );
      setLogMessage("Food logged successfully!");
      await loadSummary();
      await loadLogs();
    } catch (err) {
      setLogMessage("Failed to log food. Is the backend running?");
    } finally {
      setLoggingFood(false);
    }
  };

  const loadSummary = async (date = selectedDate) => {
    setSummaryLoading(true);
    try {
      const res = await axios.get(`http://127.0.0.1:8000/dashboard/daily?date=${date}`, {
        headers: getAuthHeaders(),
      });
      setSummary(res.data);
    } catch (err) {
      console.log(err);
    } finally {
      setSummaryLoading(false);
    }
  };

  const deleteLog = async (id: number) => {
    setDeletingLogId(id);
    try {
      await axios.delete(`http://127.0.0.1:8000/logs/${id}`, {
        headers: getAuthHeaders(),
      });
      await loadSummary();
      await loadLogs();
    } catch (err) {
      console.log(err);
    } finally {
      setDeletingLogId(null);
    }
  };

  const loadLogs = async (date = selectedDate) => {
    setLogsLoading(true);
    try {
      const res = await axios.get(`http://127.0.0.1:8000/logs?date=${date}`, {
        headers: getAuthHeaders(),
      });
      setLogs(res.data.logs);
    } catch (err) {
      console.log(err);
    } finally {
      setLogsLoading(false);
    }
  };

  const clearSearch = () => {
    setQuery("");
    setResult(null);
    setLogMessage("");
    setServings(1);
  };

  // Reload data whenever selectedDate changes, but only if it's a valid date
  useEffect(() => {
    if (!isValidDate(selectedDate)) return;
    loadLogs(selectedDate);
    loadSummary(selectedDate);
  }, [selectedDate]);

  // Clear stale state on logout; reload fresh data on login / user switch
  useEffect(() => {
    if (!session) {
      // Wipe every piece of user-specific state so the next user starts clean
      setLogs([]);
      setSummary(null);
      setResult(null);
      setLogMessage("");
      setQuery("");
      setServings(1);
    } else {
      // A valid session just arrived (login or token refresh) — load their data
      if (isValidDate(selectedDate)) {
        loadLogs(selectedDate);
        loadSummary(selectedDate);
      }
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

  // ── Auth screen ────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.authContainer}>
          <Text style={styles.appTitle}>Lume</Text>
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
    );
  }

  // ── Tracker screen (logged in) ──────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>

        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.appTitle}>Lume</Text>
            <Text style={styles.appSubtitle}>Track what you eat</Text>
          </View>
          <TouchableOpacity onPress={logOut}>
            <Text style={styles.logOutText}>Log Out</Text>
          </TouchableOpacity>
        </View>

        {/* Date selector */}
        <View style={styles.dateSection}>
          <Text style={styles.sectionLabel}>VIEWING DATE</Text>
          <TextInput
            style={[styles.input, dateError ? styles.inputError : null]}
            value={selectedDate}
            onChangeText={(text) => {
              setSelectedDate(text);
              setDateError(isValidDate(text) ? "" : "Enter a valid date: YYYY-MM-DD");
            }}
            placeholder="YYYY-MM-DD"
            placeholderTextColor="#aaa"
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
          />
          {dateError ? <Text style={styles.dateErrorText}>{dateError}</Text> : null}
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
          {searching && <Text style={styles.searchingText}>Searching...</Text>}
        </View>

        {/* Search Result */}
        {!result && !searching && (
          <Text style={styles.emptyState}>Search for a food to see nutrition info</Text>
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
            {logMessage ? (
              <Text style={logMessage.includes("successfully") ? styles.success : styles.error}>
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
              <Text style={styles.cardTitle}>Today's Totals</Text>
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
            <Text style={styles.emptyState}>No foods logged yet</Text>
          )}
          {!logsLoading && logs.map((entry) => (
            <View key={entry.id} style={styles.logEntry}>
              <View style={styles.logEntryRow}>
                <View style={styles.logEntryText}>
                  <Text style={styles.logEntryName}>{entry.name}</Text>
                  <Text style={styles.logEntryMacros}>
                    {entry.calories} kcal · {entry.protein}g protein · {entry.carbs}g carbs · {entry.fat}g fat
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => deleteLog(entry.id)}
                  disabled={deletingLogId === entry.id}
                >
                  <Text style={deletingLogId === entry.id ? styles.deleteButtonDisabled : styles.deleteButton}>
                    {deletingLogId === entry.id ? "..." : "Delete"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>

      </ScrollView>
    </SafeAreaView>
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
    color: "#555",
    textAlign: "center",
  },

  // Header
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginTop: 12,
    marginBottom: 4,
  },
  appTitle: {
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: 1,
  },
  appSubtitle: {
    fontSize: 14,
    color: "#999",
    marginBottom: 4,
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
  inputError: {
    borderColor: "#c62828",
  },
  dateErrorText: {
    fontSize: 12,
    color: "#c62828",
    marginTop: 4,
  },

  // Sections
  section: {
    marginTop: 28,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
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
    marginBottom: 10,
    color: "#111",
  },

  searchingText: {
    marginTop: 8,
    fontSize: 13,
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
    backgroundColor: "#f0f6ff",
    borderColor: "#d0e4ff",
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "600",
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
    fontWeight: "700",
    color: "#111",
  },
  macroUnit: {
    fontSize: 10,
    color: "#888",
  },
  macroLabel: {
    fontSize: 11,
    color: "#aaa",
    marginTop: 2,
  },

  // Summary
  entryCount: {
    marginTop: 12,
    fontSize: 12,
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
    alignItems: "center",
  },
  logEntryText: {
    flex: 1,
    marginRight: 12,
  },
  logEntryName: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 3,
    textTransform: "capitalize",
  },
  logEntryMacros: {
    fontSize: 12,
    color: "#777",
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
    fontWeight: "600",
    color: "#333",
    minWidth: 80,
    textAlign: "center",
  },

  // Empty states
  emptyState: {
    marginTop: 10,
    fontSize: 13,
    color: "#bbb",
    fontStyle: "italic",
  },

  // Feedback
  success: {
    color: "#2e7d32",
    marginTop: 10,
    fontSize: 13,
  },
  error: {
    color: "#c62828",
    marginTop: 10,
    fontSize: 13,
  },
});

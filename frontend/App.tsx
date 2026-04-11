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

export default function App() {
  const [query,      setQuery]      = useState("");
  const [result,     setResult]     = useState<NutritionResult | null>(null);
  const [logMessage, setLogMessage] = useState("");
  const [logs,       setLogs]       = useState<FoodLogEntry[]>([]);
  const [summary,    setSummary]    = useState<DailySummary | null>(null);
  const [searching,  setSearching]  = useState(false);
  const [servings,   setServings]   = useState(1);

  const searchFood = async () => {
    setLogMessage("");
    setSearching(true);
    try {
      const res = await axios.post("http://127.0.0.1:8000/food/search", { query });
      setResult(res.data);
      setServings(1);
    } catch (err) {
      console.log(err);
    } finally {
      setSearching(false);
    }
  };

  const logFood = async () => {
    if (!result) return;
    try {
      await axios.post("http://127.0.0.1:8000/logs", {
        name:     result.name,
        calories: result.calories * servings,
        protein:  result.protein  * servings,
        carbs:    result.carbs    * servings,
        fat:      result.fat      * servings,
      });
      setLogMessage("Food logged successfully!");
      await loadSummary();
      await loadLogs();
    } catch (err) {
      setLogMessage("Failed to log food. Is the backend running?");
    }
  };

  const loadSummary = async () => {
    try {
      const res = await axios.get("http://127.0.0.1:8000/dashboard/daily");
      setSummary(res.data);
    } catch (err) {
      console.log(err);
    }
  };

  const deleteLog = async (id: number) => {
    try {
      await axios.delete(`http://127.0.0.1:8000/logs/${id}`);
      await loadSummary();
      await loadLogs();
    } catch (err) {
      console.log(err);
    }
  };

  const loadLogs = async () => {
    try {
      const res = await axios.get("http://127.0.0.1:8000/logs");
      setLogs(res.data.logs);
    } catch (err) {
      console.log(err);
    }
  };

  const clearSearch = () => {
    setQuery("");
    setResult(null);
    setLogMessage("");
    setServings(1);
  };

  useEffect(() => {
    loadLogs();
    loadSummary();
  }, []);

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

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>

        {/* Header */}
        <Text style={styles.appTitle}>Lume</Text>
        <Text style={styles.appSubtitle}>Track what you eat</Text>

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
              <Button title="Log Food" onPress={logFood} />
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
          {summary && (
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
          {logs.length === 0 && (
            <Text style={styles.emptyState}>No foods logged yet</Text>
          )}
          {logs.map((entry) => (
            <View key={entry.id} style={styles.logEntry}>
              <View style={styles.logEntryRow}>
                <View style={styles.logEntryText}>
                  <Text style={styles.logEntryName}>{entry.name}</Text>
                  <Text style={styles.logEntryMacros}>
                    {entry.calories} kcal · {entry.protein}g protein · {entry.carbs}g carbs · {entry.fat}g fat
                  </Text>
                </View>
                <TouchableOpacity onPress={() => deleteLog(entry.id)}>
                  <Text style={styles.deleteButton}>Delete</Text>
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

  // Header
  appTitle: {
    fontSize: 34,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 12,
    letterSpacing: 1,
  },
  appSubtitle: {
    fontSize: 14,
    color: "#999",
    textAlign: "center",
    marginBottom: 28,
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

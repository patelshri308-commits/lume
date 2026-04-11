import { useState } from "react";
import { View, Text, TextInput, Button, StyleSheet, ScrollView } from "react-native";
import axios from "axios";

type NutritionResult = {
  name:     string;
  calories: number;
  protein:  number;
  carbs:    number;
  fat:      number;
};

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
  const [logs,       setLogs]       = useState<NutritionResult[]>([]);
  const [summary,    setSummary]    = useState<DailySummary | null>(null);

  const searchFood = async () => {
    setLogMessage("");
    try {
      const res = await axios.post("http://127.0.0.1:8000/food/search", { query });
      setResult(res.data);
    } catch (err) {
      console.log(err);
    }
  };

  const logFood = async () => {
    if (!result) return;
    try {
      await axios.post("http://127.0.0.1:8000/logs", {
        name:     result.name,
        calories: result.calories,
        protein:  result.protein,
        carbs:    result.carbs,
        fat:      result.fat,
      });
      setLogMessage("Food logged successfully!");
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

  const loadLogs = async () => {
    try {
      const res = await axios.get("http://127.0.0.1:8000/logs");
      setLogs(res.data.logs);
    } catch (err) {
      console.log(err);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Lume</Text>

      <TextInput
        placeholder="Enter food..."
        value={query}
        onChangeText={setQuery}
        style={styles.input}
      />

      <Button title="Search" onPress={searchFood} />

      {result && (
        <View style={styles.result}>
          <Text>Name: {result.name}</Text>
          <Text>Calories: {result.calories}</Text>
          <Text>Protein: {result.protein}</Text>
          <Text>Carbs: {result.carbs}</Text>
          <Text>Fat: {result.fat}</Text>

          <View style={styles.logButton}>
            <Button title="Log Food" onPress={logFood} />
          </View>

          {logMessage ? (
            <Text style={logMessage.includes("successfully") ? styles.success : styles.error}>
              {logMessage}
            </Text>
          ) : null}
        </View>
      )}

      <View style={styles.summarySection}>
        <Button title="Load Daily Summary" onPress={loadSummary} />

        {summary && (
          <View style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>Today's Totals</Text>
            <Text>Calories: {summary.total_calories} kcal</Text>
            <Text>Protein:  {summary.total_protein}g</Text>
            <Text>Carbs:    {summary.total_carbs}g</Text>
            <Text>Fat:      {summary.total_fat}g</Text>
            <Text>Entries:  {summary.entries_count}</Text>
          </View>
        )}
      </View>

      <View style={styles.logsSection}>
        <Button title="Load Logged Foods" onPress={loadLogs} />

        {logs.map((entry, index) => (
          <View key={index} style={styles.logEntry}>
            <Text style={styles.logName}>{entry.name}</Text>
            <Text>Calories: {entry.calories}</Text>
            <Text>Protein: {entry.protein}g</Text>
            <Text>Carbs: {entry.carbs}g</Text>
            <Text>Fat: {entry.fat}g</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    paddingTop: 60,
  },
  title: {
    fontSize: 28,
    marginBottom: 20,
    textAlign: "center",
  },
  input: {
    borderWidth: 1,
    padding: 10,
    marginBottom: 10,
  },
  result: {
    marginTop: 20,
  },
  logButton: {
    marginTop: 12,
  },
  success: {
    color: "green",
    marginTop: 8,
  },
  error: {
    color: "red",
    marginTop: 8,
  },
  summarySection: {
    marginTop: 32,
  },
  summaryCard: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#eef6ff",
    gap: 4,
  },
  summaryTitle: {
    fontWeight: "600",
    marginBottom: 4,
  },
  logsSection: {
    marginTop: 32,
  },
  logEntry: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#f5f5f5",
    gap: 2,
  },
  logName: {
    fontWeight: "600",
    marginBottom: 4,
  },
});

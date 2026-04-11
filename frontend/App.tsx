import { useState } from "react";
import { View, Text, TextInput, Button, StyleSheet } from "react-native";
import axios from "axios";

export default function App() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<any>(null);

  const searchFood = async () => {
    try {
      const res = await axios.post("http://127.0.0.1:8000/food/search", {
        query,
      });
      setResult(res.data);
    } catch (err) {
      console.log(err);
    }
  };

  return (
    <View style={styles.container}>
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
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: "center",
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
});

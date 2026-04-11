import { useState } from 'react';
import {
  ActivityIndicator,
  Button,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { searchFood } from '../../api/client';

// Shape of the response returned by POST /food/search
type NutritionResult = {
  name:         string;
  calories:     number;
  protein:      number;
  carbs:        number;
  fat:          number;
  matched_food?: string;  // debug field — remove once USDA matching is confirmed
};

export default function SearchScreen() {
  const [query,   setQuery]   = useState('');
  const [result,  setResult]  = useState<NutritionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  async function handleSearch() {
    if (!query.trim()) return;

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const data = await searchFood(query);
      setResult(data);
    } catch {
      setError('Could not reach the server. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Search Food</Text>

      <TextInput
        style={styles.input}
        placeholder="e.g. banana, grilled chicken, apple"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={handleSearch}
        returnKeyType="search"
        autoCapitalize="none"
      />

      <Button title="Search" onPress={handleSearch} />

      {loading && <ActivityIndicator style={styles.spacer} />}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {result && (
        <View style={styles.card}>
          <Text style={styles.foodName}>{result.name}</Text>

          <View style={styles.row}>
            <Text style={styles.label}>Calories</Text>
            <Text>{result.calories} kcal</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Protein</Text>
            <Text>{result.protein} g</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Carbs</Text>
            <Text>{result.carbs} g</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Fat</Text>
            <Text>{result.fat} g</Text>
          </View>

          {result.matched_food && (
            <Text style={styles.matched}>
              Source: {result.matched_food}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 12,
  },
  spacer: {
    marginTop: 20,
  },
  error: {
    color: 'red',
    marginTop: 12,
  },
  card: {
    marginTop: 24,
    padding: 16,
    borderRadius: 10,
    backgroundColor: '#f5f5f5',
    gap: 10,
  },
  foodName: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  label: {
    color: '#555',
  },
  matched: {
    fontSize: 11,
    color: '#aaa',
    marginTop: 8,
  },
});

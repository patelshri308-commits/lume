import axios from 'axios';

// ---------------------------------------------------------------------------
// Base URL points to your local FastAPI server.
// iOS simulator:    http://127.0.0.1:8000  ← works as-is
// Android emulator: replace with http://10.0.2.2:8000
// Physical device:  replace with your machine's local IP, e.g. http://192.168.1.5:8000
// ---------------------------------------------------------------------------
const client = axios.create({
  baseURL: 'http://127.0.0.1:8000',
});

// ---------------------------------------------------------------------------
// Food API
// ---------------------------------------------------------------------------

export async function searchFood(query: string) {
  const response = await client.post('/food/search', { query });
  return response.data;
}

export default client;

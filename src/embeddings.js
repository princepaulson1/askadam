// Embeddings via MongoDB's Voyage AI API (https://ai.mongodb.com/v1/embeddings).
// Used to turn text into vectors for semantic memory (RAG) stored in pgvector.
// Key is read from EMBEDDINGS_API_KEY and never logged.

const EMBED_URL = process.env.EMBEDDINGS_URL || "https://ai.mongodb.com/v1/embeddings";
const EMBED_MODEL = process.env.EMBEDDING_MODEL || "voyage-3.5-lite";
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1024);

export function embeddingsConfigured() {
  return Boolean(process.env.EMBEDDINGS_API_KEY);
}

/**
 * Embed one or more texts. Returns an array of vectors (array of numbers[]).
 * @param {string|string[]} texts
 * @param {"query"|"document"} inputType
 */
export async function embed(texts, inputType = "document") {
  const key = process.env.EMBEDDINGS_API_KEY;
  if (!key) throw new Error("EMBEDDINGS_API_KEY not set");
  const input = Array.isArray(texts) ? texts : [texts];

  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      input,
      model: EMBED_MODEL,
      input_type: inputType,
      output_dimension: EMBEDDING_DIM,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Embeddings ${res.status}`);
    err.status = res.status;
    err.detail = detail.slice(0, 300);
    throw err;
  }

  const data = await res.json();
  // Voyage/OpenAI-style: { data: [{ embedding: [...] }, ...] }
  return (data.data || []).map((d) => d.embedding);
}

export async function embedOne(text, inputType = "document") {
  const [vec] = await embed([text], inputType);
  return vec;
}


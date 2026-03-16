/**
 * Local embedding pipeline — Qwen3-Embedding-0.6B via Transformers.js
 * Zero external API dependencies. Model auto-downloads on first run (~560MB).
 * LRU cache to avoid recomputation.
 */

const EMBEDDING_DIM = 1024;
const MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const CACHE_SIZE = 256;

let pipeline = null;
let tokenizer = null;
let loading = null;

// Simple LRU cache
class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      // Delete oldest (first entry)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

const embeddingCache = new LRUCache(CACHE_SIZE);

async function loadModel() {
  if (pipeline) return;
  if (loading) {
    await loading;
    return;
  }

  loading = (async () => {
    const { AutoTokenizer, AutoModel } = await import('@huggingface/transformers');
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
    pipeline = await AutoModel.from_pretrained(MODEL_ID, {
      dtype: 'q8',  // quantized for Apple Silicon
    });
  })();

  try {
    await loading;
  } catch (e) {
    loading = null; // allow retry on next call
    throw e;
  }
}

/**
 * Generate embedding for a single text string.
 * Returns Float32Array of length 1024.
 */
export async function embed(text) {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  await loadModel();

  const inputs = tokenizer(text, { padding: true, truncation: true });
  const output = await pipeline(inputs);

  // Mean pooling over token dimension (attention-mask-aware)
  const lastHidden = output.last_hidden_state;
  const dims = lastHidden.dims; // [batch, seq_len, hidden_dim]
  const data = lastHidden.data; // Float32Array
  const seqLen = dims[1];
  const hiddenDim = dims[2];

  // Use attention_mask to exclude padding tokens from mean
  const attentionMask = inputs.attention_mask?.data;

  const embedding = new Float32Array(hiddenDim);
  let validTokens = 0;
  for (let i = 0; i < seqLen; i++) {
    const maskVal = attentionMask ? attentionMask[i] : 1;
    if (maskVal === 0) continue; // skip padding
    validTokens++;
    for (let j = 0; j < hiddenDim; j++) {
      embedding[j] += data[i * hiddenDim + j];
    }
  }
  const divisor = validTokens || seqLen; // fallback if no mask
  for (let j = 0; j < hiddenDim; j++) {
    embedding[j] /= divisor;
  }

  // L2 normalize
  let norm = 0;
  for (let j = 0; j < hiddenDim; j++) norm += embedding[j] * embedding[j];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let j = 0; j < hiddenDim; j++) embedding[j] /= norm;
  }

  embeddingCache.set(text, embedding);
  return embedding;
}

/**
 * Check if embedding model is loaded and ready.
 */
export function isReady() {
  return pipeline !== null;
}

/**
 * Get embedding dimension.
 */
export function getDimension() {
  return EMBEDDING_DIM;
}

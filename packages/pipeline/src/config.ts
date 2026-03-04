// ── LLM Role config ───────────────────────────────────────────────────────────
// Each role is independently configurable — point at Ollama, OpenAI,
// or any OpenAI-compatible endpoint (LM Studio, vLLM, Together, etc.)

export interface LLMRole {
  url:     string
  model:   string
  apiKey?: string   // optional — omit for local/unauthenticated endpoints
}

export interface LLMConfig {
  /** Dedicated embedding model (must support POST /v1/embeddings) */
  embed: LLMRole

  /** Entity + locus extraction from raw content (chat/completions) */
  extract: LLMRole

  /** Truth promotion + summarization (chat/completions) — falls back to extract */
  summary: LLMRole
}

export interface PipelineConfig {
  llm:      LLMConfig
  palaceId: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function role(
  urlEnv: string,
  modelEnv: string,
  keyEnv: string,
  defaultUrl: string,
  defaultModel: string,
): LLMRole {
  return {
    url:    process.env[urlEnv]   ?? defaultUrl,
    model:  process.env[modelEnv] ?? defaultModel,
    apiKey: process.env[keyEnv]   ?? undefined,
  }
}

export function defaultLLMConfig(): LLMConfig {
  const extract = role(
    'LOCIGRAM_EXTRACT_URL',
    'LOCIGRAM_EXTRACT_MODEL',
    'LOCIGRAM_EXTRACT_KEY',
    // default: Ollama local — community users just need `ollama pull qwen2.5:7b`
    'http://localhost:11434/v1',
    'qwen2.5:7b',
  )

  const summary = role(
    'LOCIGRAM_SUMMARY_URL',
    'LOCIGRAM_SUMMARY_MODEL',
    'LOCIGRAM_SUMMARY_KEY',
    '',   // blank = fall back to extract
    '',
  )

  return {
    embed: role(
      'LOCIGRAM_EMBED_URL',
      'LOCIGRAM_EMBED_MODEL',
      'LOCIGRAM_EMBED_KEY',
      // default: Ollama local — community users just need `ollama pull nomic-embed-text`
      'http://localhost:11434/v1',
      'nomic-embed-text',
    ),
    extract,
    // summary falls back to extract if not configured
    summary: summary.url ? summary : extract,
  }
}

export function defaultPipelineConfig(): Partial<PipelineConfig> {
  return { llm: defaultLLMConfig() }
}

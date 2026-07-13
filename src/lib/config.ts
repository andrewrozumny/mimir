import fs from "fs";
import path from "path";

export interface CorpusSource {
  type: "file" | "url";
  path?: string;
  url?: string;
}

export interface CorpusConfig {
  corpus: string;
  sources: CorpusSource[];
}

const DEFAULT_CONFIG = "corpus.config.json";

/**
 * Loads the corpus config. Resolution order:
 * explicit path argument > CORPUS_CONFIG env var > corpus.config.json.
 * Swapping the corpus is a config change only — no pipeline code changes.
 */
export function loadCorpusConfig(configPath?: string): CorpusConfig {
  const file = configPath ?? process.env.CORPUS_CONFIG ?? DEFAULT_CONFIG;
  const resolved = path.resolve(process.cwd(), file);
  const raw = fs.readFileSync(resolved, "utf-8");
  const config = JSON.parse(raw) as CorpusConfig;

  if (!config.corpus || !Array.isArray(config.sources)) {
    throw new Error(`Invalid corpus config at ${resolved}: expected { corpus, sources[] }`);
  }
  for (const source of config.sources) {
    if (source.type === "file" && !source.path) {
      throw new Error(`Invalid source in ${resolved}: file sources need a "path"`);
    }
    if (source.type === "url" && !source.url) {
      throw new Error(`Invalid source in ${resolved}: url sources need a "url"`);
    }
  }
  return config;
}

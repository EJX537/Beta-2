import OpenAI from "openai";

export const DEFAULT_GMI_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

export interface GmiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export function normalizeGmiBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Read GMI MaaS configuration from environment variables.
 * Returns `null` if any required var is missing.
 */
export function readGmiConfig(): GmiConfig | null {
  const rawBaseURL = process.env["GMI_MAAS_BASE_URL"];
  const apiKey = process.env["GMI_MAAS_API_KEY"];
  const model = process.env["GMI_MODELS"] ?? DEFAULT_GMI_MODEL;

  if (!rawBaseURL || !apiKey) {
    const missing: string[] = [];
    if (!rawBaseURL) missing.push("GMI_MAAS_BASE_URL");
    if (!apiKey) missing.push("GMI_MAAS_API_KEY");
    console.warn("[gmi] missing env vars: %s", missing.join(", "));
    return null;
  }

  const baseURL = normalizeGmiBaseURL(rawBaseURL);

  console.info(
    "[gmi] GMI MaaS configured — baseURL=%s model=%s",
    baseURL,
    model,
  );
  return { baseURL, apiKey, model };
}

/**
 * Build an OpenAI-compatible client pointed at GMI MaaS.
 */
export function createGmiClient(config: GmiConfig): OpenAI {
  return new OpenAI({
    baseURL: normalizeGmiBaseURL(config.baseURL),
    apiKey: config.apiKey,
  });
}

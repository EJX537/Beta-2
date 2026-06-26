import OpenAI from "openai";

interface GmiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * Read GMI MaaS configuration from environment variables.
 * Returns `null` if any required var is missing.
 */
export function readGmiConfig(): GmiConfig | null {
  const baseURL = process.env["GMI_MAAS_BASE_URL"];
  const apiKey = process.env["GMI_MAAS_API_KEY"];
  const model = process.env["GMI_MODELS"];

  if (!baseURL || !apiKey || !model) {
    const missing: string[] = [];
    if (!baseURL) missing.push("GMI_MAAS_BASE_URL");
    if (!apiKey) missing.push("GMI_MAAS_API_KEY");
    if (!model) missing.push("GMI_MODELS");
    console.warn("[gmi] missing env vars: %s", missing.join(", "));
    return null;
  }

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
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
}

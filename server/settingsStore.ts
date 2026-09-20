// Server-side settings store — mirrors docStudio user_settings semantics.
// Keys: 'provider_all' = JSON(AppSettings); legacy 'provider_{id}' rows are
// still written (docStudio writes both) and read as fallback. Backed by a
// local JSON file (PRD F4-6: local demo may use a local JSON store); writes
// are atomic via tmp + rename. Raw apiKeys live here, like docStudio.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function settingsFile(): string {
  const override = process.env["HWT_SETTINGS_FILE"];
  if (override) return resolve(override);
  return resolve(process.cwd(), "server-data", "settings.json");
}

function readAll(file = settingsFile()): Record<string, unknown> {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or corrupt file reads as empty (docStudio: no rows).
  }
  return {};
}

function writeAll(settings: Record<string, unknown>, file = settingsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, file);
}

export function getSettings(): Record<string, unknown> {
  return readAll();
}

export function getSetting(key: string): unknown {
  return readAll()[key] ?? null;
}

export function putSetting(key: string, value: unknown): void {
  const all = readAll();
  all[key] = value;
  writeAll(all);
}

export function deleteSetting(key: string): void {
  const all = readAll();
  delete all[key];
  writeAll(all);
}

/** Bulk upsert mirroring POST /api/settings/providers (provider_all + legacy rows). */
export function putProviderBundle(
  providers: Array<Record<string, unknown>>,
  extra: { enableProviderFallback?: boolean } = {},
): Record<string, unknown> {
  const appSettings: Record<string, unknown> = {
    providers: providers.map((p) => ({
      providerId: p["providerId"],
      apiKeyRef: (p["apiKeyRef"] as string | undefined) ?? (p["apiKey"] as string | undefined) ?? "",
      modelIds: (p["modelIds"] as string[] | undefined) ?? [],
      defaultModelId: (p["defaultModelId"] as string | undefined) ?? "",
      modelFallbacks: (p["modelFallbacks"] as string[] | undefined) ?? [],
      enabled: (p["enabled"] as boolean | undefined) ?? true,
      enableModelFallback: (p["enableModelFallback"] as boolean | undefined) ?? false,
      baseUrl: p["baseUrl"],
    })),
    enableProviderFallback: extra.enableProviderFallback ?? true,
  };
  const all = readAll();
  all["provider_all"] = appSettings;
  for (const p of providers) {
    all[`provider_${p["providerId"]}`] = p;
  }
  writeAll(all);
  return appSettings;
}

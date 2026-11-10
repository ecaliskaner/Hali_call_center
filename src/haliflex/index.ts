import { config } from "../config.js";
import { HttpHaliflex } from "./http.js";
import { MockHaliflex } from "./mock.js";
import type { HaliflexClient } from "./types.js";

export * from "./types.js";

export function createHaliflex(): HaliflexClient {
  if (config.haliflex.mode === "http") return new HttpHaliflex(config.haliflex.baseUrl, config.haliflex.apiKey);
  return new MockHaliflex(config.haliflex.mockFile);
}

import { config } from "../config.js";
import { HttpHalipratik } from "./http.js";
import { MockHalipratik } from "./mock.js";
import type { HalipratikClient } from "./types.js";

export * from "./types.js";

export function createHalipratik(): HalipratikClient {
  if (config.halipratik.mode === "http") return new HttpHalipratik(config.halipratik.baseUrl, config.halipratik.apiKey);
  return new MockHalipratik(config.halipratik.mockFile);
}

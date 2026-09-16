import type { RegistryEntry } from "../../shared.ts";

/**
 * Local-only bridge contract. It intentionally advertises a single generic
 * route instead of claiming support for any ChatGPT product model or feature.
 * A paired Companion may later report a more specific inventory, but no model
 * discovery or third-party credential is performed by OmniRoute.
 */
export const chatgpt_web_companionProvider: RegistryEntry = {
  id: "chatgpt-web-companion",
  format: "openai",
  executor: "chatgpt-web-companion",
  baseUrl: "companion://local-bridge",
  authType: "none",
  authHeader: "none",
  models: [
    {
      id: "companion",
      name: "Paired Local Companion",
      toolCalling: false,
      supportsReasoning: false,
      supportsVision: false,
    },
  ],
};

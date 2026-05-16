// ==========================================
// Aikata - OpenCode Go プロバイダー設定
// ==========================================

import { createOpenAICompatibleProvider } from "./base";
import { getProviderConfig } from "../utils/config";

export function createOpenCodeProvider() {
  const config = getProviderConfig();
  if (config.type !== "opencode") {
    throw new Error("現在の LLM_PROVIDER 設定は opencode ではありません");
  }
  return createOpenAICompatibleProvider(config);
}

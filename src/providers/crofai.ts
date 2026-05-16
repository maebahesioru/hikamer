// ==========================================
// Aikata - CrofAI プロバイダー設定
// ==========================================

import { createOpenAICompatibleProvider } from "./base";
import { getProviderConfig } from "../utils/config";

export function createCrofAIProvider() {
  const config = getProviderConfig();
  if (config.type !== "crofai") {
    throw new Error("現在の LLM_PROVIDER 設定は crofai ではありません");
  }
  return createOpenAICompatibleProvider(config);
}

// ==========================================
// Aikata - ModelRegistry (open-notebook pattern)
// Credential-Model 分離: 認証情報とモデル定義を独立管理
// ==========================================

import { getProvider, getApiKey, getProviders } from "./utils/config";
import { logger } from "./utils/logger";

// ==================== 型定義 ====================

export type ModelType = "language" | "embedding" | "tts" | "stt";

export interface CredentialRecord {
  /** 一意識別子（例: "opencode", "crofai"） */
  id: string;
  /** 表示名 */
  name: string;
  /** プロバイダー識別子（providers.json のキーと一致） */
  provider: string;
  /** このクレデンシャルで使えるモダリティ */
  modalities: ModelType[];
  /** APIキー */
  apiKey: string;
  /** ベースURL */
  baseUrl: string;
  /** エンドポイントパス（省略時はデフォルト） */
  endpoint?: string;
  /** モデル名マッピング（論理名 → API実名） */
  modelMap?: Record<string, string>;
}

export interface ModelRecord {
  /** 一意識別子 */
  id: string;
  /** 表示名 */
  name: string;
  /** プロバイダー識別子 */
  provider: string;
  /** モデル種別 */
  type: ModelType;
  /** 参照するクレデンシャルID */
  credentialId: string;
}

export interface ModelResolved {
  provider: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  credentialId: string;
  type: ModelType;
}

/** トークン推計用（簡易: 文字数 × 0.75 ≒ トークン数） */
const LARGE_CONTEXT_THRESHOLD = 105_000;

/** 大規模コンテキスト用モデルのサフィックス */
const LARGE_CONTEXT_SUFFIX = "_large_context";

// ==================== レジストリ ====================

class ModelRegistry {
  private credentials = new Map<string, CredentialRecord>();
  private models = new Map<string, ModelRecord>();

  // ==================== 登録 ====================

  /** クレデンシャルを登録 */
  registerCredential(cred: CredentialRecord): void {
    this.credentials.set(cred.id, cred);
    logger.info(`[ModelRegistry] クレデンシャル登録: ${cred.id} (${cred.name})`);
  }

  /** モデルを登録 */
  registerModel(model: ModelRecord): void {
    this.models.set(model.id, model);
    logger.info(`[ModelRegistry] モデル登録: ${model.id} (${model.type})`);
  }

  /** クレデンシャルを一括登録 */
  registerCredentials(creds: CredentialRecord[]): void {
    for (let i = 0; i < creds.length; i++) this.registerCredential(creds[i]!);
  }

  /** モデルを一括登録 */
  registerModels(models: ModelRecord[]): void {
    for (let i = 0; i < models.length; i++) this.registerModel(models[i]!);
  }

  /** クレデンシャルを削除 */
  unregisterCredential(id: string): boolean {
    return this.credentials.delete(id);
  }

  /** モデルを削除 */
  unregisterModel(id: string): boolean {
    return this.models.delete(id);
  }

  // ==================== 解決 ====================

  /**
   * モデル名と種別から接続情報を解決
   * 解決順序:
   *   1. ModelRecord.id と一致
   *   2. ModelRecord.name と一致（前方一致も許容）
   *   3. クレデンシャルの modelMap で変換試行
   *   4. そのまま modelName として使用（最初の type 一致クレデンシャル）
   */
  resolveModel(modelName: string, type?: ModelType): ModelResolved | null {
    // 1. IDでモデルを直接検索
    let model = this.models.get(modelName);

    // 2. name で検索
    if (!model) {
      const modelsArr = Array.from(this.models.values());
      for (let i = 0; i < modelsArr.length; i++) {
        const m = modelsArr[i]!;
        if (m.name === modelName || modelName.startsWith(m.name + "/")) {
          model = m;
          break;
        }
      }
    }

    // 3. type フィルタ（指定されたtypeと異なるモデルなら再検索）
    if (type && model && model.type !== type) {
      const typed = this.findModelByType(modelName, type);
      if (typed) model = typed;
    }

    if (model) {
      const cred = this.credentials.get(model.credentialId);
      if (cred) {
        const resolvedName = cred.modelMap?.[model.name] ?? model.name;
        return {
          provider: model.provider,
          apiKey: cred.apiKey,
          baseUrl: cred.baseUrl,
          modelName: resolvedName,
          credentialId: cred.id,
          type: model.type,
        };
      }
    }

    // 4. クレデンシャルの modelMap を全探索
    const credsArr = Array.from(this.credentials.values());
    for (let i = 0; i < credsArr.length; i++) {
      const cred = credsArr[i]!;
      if (cred.modelMap) {
        const keys = Object.keys(cred.modelMap);
        for (let j = 0; j < keys.length; j++) {
          const logical = keys[j]!;
          if (logical === modelName || modelName.startsWith(logical + "/")) {
            const mType = type ?? "language";
            return {
              provider: cred.provider,
              apiKey: cred.apiKey,
              baseUrl: cred.baseUrl,
              modelName: cred.modelMap[logical]!,
              credentialId: cred.id,
              type: mType,
            };
          }
        }
      }
    }

    // 5. フォールバック: 最初の type 一致クレデンシャル
    const firstCred = this.findCredentialForType(type ?? "language");
    if (firstCred) {
      return {
        provider: firstCred.provider,
        apiKey: firstCred.apiKey,
        baseUrl: firstCred.baseUrl,
        modelName,
        credentialId: firstCred.id,
        type: type ?? "language",
      };
    }

    return null;
  }

  /** 種別に合うモデルを検索 */
  private findModelByType(nameHint: string, type: ModelType): ModelRecord | null {
    const arr = Array.from(this.models.values());
    // 完全一致
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i]!;
      if (m.name === nameHint && m.type === type) return m;
    }
    // 部分一致
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i]!;
      if (m.type === type && (m.name.includes(nameHint) || nameHint.includes(m.name))) return m;
    }
    // 種別一致のみ
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i]!;
      if (m.type === type) return m;
    }
    return null;
  }

  /** 種別に合うクレデンシャルを検索 */
  private findCredentialForType(type: ModelType): CredentialRecord | null {
    const arr = Array.from(this.credentials.values());
    for (let i = 0; i < arr.length; i++) {
      const cred = arr[i]!;
      if (cred.modalities.includes(type)) return cred;
    }
    return arr[0] ?? null;
  }

  // ==================== プロビジョニング ====================

  /**
   * コンテンツを分析して最適なモデルを動的に選択
   *
   * @param content - プロンプト/コンテキスト文字列
   * @param modelId - 明示的なモデルID（省略時は自動選択）
   * @param defaultType - デフォルトのモデル種別
   * @returns 解決済みモデル情報
   */
  async provisionModel(
    content: string,
    modelId?: string,
    defaultType?: ModelType,
  ): Promise<ModelResolved> {
    const type = defaultType ?? "language";

    // モデルIDが明示された場合
    if (modelId) {
      const effectiveModelId = this.upgradeForLargeContext(content, modelId);
      const resolved = this.resolveModel(effectiveModelId, type);
      if (resolved) return resolved;
      logger.warn(`[ModelRegistry] モデル '${modelId}' 未登録 → フォールバック`);
    }

    // 自動選択: 環境変数 → デフォルトモデル → 最初の登録モデル
    const autoModelId = this.getEnvModel() ?? this.getDefaultModel(type);
    const autoResolved = this.resolveModel(autoModelId, type);
    if (autoResolved) {
      return this.upgradeResolvedForLargeContext(content, autoResolved);
    }

    // 最終フォールバック: env → providers.json → ハードコード
    return this.fallbackResolve(type);
  }

  /**
   * 大規模コンテキスト（>105k tokens）を検出し、
   * 対応モデルがあればアップグレード
   */
  private upgradeForLargeContext(content: string, modelId: string): string {
    const estimatedTokens = Math.ceil(content.length * 0.75);
    if (estimatedTokens <= LARGE_CONTEXT_THRESHOLD) return modelId;

    // 既に large_context サフィックスが付いている場合はそのまま
    if (modelId.endsWith(LARGE_CONTEXT_SUFFIX)) return modelId;

    const largeModelId = `${modelId}${LARGE_CONTEXT_SUFFIX}`;

    // 登録済みモデルに large_context バリアントがあるか
    if (this.models.has(largeModelId)) {
      logger.info(`[ModelRegistry] 大規模コンテキスト検出 → ${largeModelId}`);
      return largeModelId;
    }

    // modelMap で large_context バリアントを検索
    const credsArr = Array.from(this.credentials.values());
    for (let i = 0; i < credsArr.length; i++) {
      const cred = credsArr[i]!;
      if (cred.modelMap?.[largeModelId]) {
        logger.info(`[ModelRegistry] 大規模コンテキスト検出 → ${largeModelId}`);
        return largeModelId;
      }
    }

    return modelId;
  }

  /** 解決済みモデルを大規模コンテキスト用にアップグレード */
  private upgradeResolvedForLargeContext(
    content: string,
    resolved: ModelResolved,
  ): ModelResolved {
    const estimatedTokens = Math.ceil(content.length * 0.75);
    if (estimatedTokens <= LARGE_CONTEXT_THRESHOLD) return resolved;

    const largeModelId = `${resolved.modelName}${LARGE_CONTEXT_SUFFIX}`;
    const upgraded = this.resolveModel(largeModelId, resolved.type);
    if (upgraded) {
      logger.info(`[ModelRegistry] 大規模コンテキスト → ${upgraded.modelName}`);
      return upgraded;
    }
    return resolved;
  }

  // ==================== フォールバック ====================

  /**
   * 環境変数 → providers.json → ハードコード の順で解決
   * open-notebook の env→credential chain パターン
   */
  private fallbackResolve(type: ModelType): ModelResolved {
    // 1. AGENT_MODEL 環境変数
    const envModel = process.env.AGENT_MODEL;
    if (envModel) {
      const slashIdx = envModel.indexOf("/");
      const provider = slashIdx !== -1 ? envModel.slice(0, slashIdx) : "opencode";
      const modelName = slashIdx !== -1 ? envModel.slice(slashIdx + 1) : envModel;
      const entry = getProvider(provider);
      if (entry) {
        const apiKey = getApiKey(provider);
        return {
          provider,
          apiKey,
          baseUrl: entry.baseUrl,
          modelName,
          credentialId: `env:${provider}`,
          type,
        };
      }
    }

    // 2. providers.json の最初のプロバイダー
    const providers = getProviders();
    const firstKey = Object.keys(providers.providers)[0];
    if (firstKey) {
      const entry = providers.providers[firstKey]!;
      const apiKey = getApiKey(firstKey);
      return {
        provider: firstKey,
        apiKey,
        baseUrl: entry.baseUrl,
        modelName: "deepseek/deepseek-v4-pro",
        credentialId: `fallback:${firstKey}`,
        type,
      };
    }

    // 3. 絶対フォールバック
    return {
      provider: "opencode",
      apiKey: process.env.OPENCODE_API_KEY || "sk-dummy",
      baseUrl: "https://opencode.ai/zen/go",
      modelName: "deepseek/deepseek-v4-pro",
      credentialId: "fallback:hardcoded",
      type,
    };
  }

  // ==================== ヘルパー ====================

  /** 環境変数からデフォルトモデルを取得 */
  private getEnvModel(): string | null {
    return process.env.AGENT_MODEL ?? null;
  }

  /** 種別に対応するデフォルトモデルを取得 */
  private getDefaultModel(type: ModelType): string {
    const defaults: Record<ModelType, string> = {
      language: "deepseek/deepseek-v4-pro",
      embedding: "text-embedding-3-small",
      tts: "tts-1",
      stt: "whisper-1",
    };
    // 登録済みモデルから最初のtype一致を優先
    const arr = Array.from(this.models.values());
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i]!;
      if (m.type === type) return m.id;
    }
    return defaults[type];
  }

  /** クレデンシャル一覧を取得 */
  listCredentials(): CredentialRecord[] {
    return Array.from(this.credentials.values());
  }

  /** モデル一覧を取得 */
  listModels(): ModelRecord[] {
    return Array.from(this.models.values());
  }

  /** クレデンシャルを取得 */
  getCredential(id: string): CredentialRecord | undefined {
    return this.credentials.get(id);
  }

  /** モデルを取得 */
  getModel(id: string): ModelRecord | undefined {
    return this.models.get(id);
  }

  /** 登録数を取得 */
  get credentialCount(): number {
    return this.credentials.size;
  }

  get modelCount(): number {
    return this.models.size;
  }
}

// ==================== シングルトン ====================

export const modelRegistry = new ModelRegistry();

// ==================== デフォルト設定 ====================

// 既存の providers.json から自動登録
(function bootstrapDefaults(): void {
  try {
    const providers = getProviders();

    for (const [key, entry] of Object.entries(providers.providers)) {
      const apiKey = getApiKey(key);
      modelRegistry.registerCredential({
        id: key,
        name: entry.name,
        provider: key,
        modalities: ["language", "embedding"],
        apiKey,
        baseUrl: entry.baseUrl,
        modelMap: {
          "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro",
          "deepseek/deepseek-v4-flash": "deepseek/deepseek-v4-flash",
          "gpt-4o": "gpt-4o",
        },
      });
    }

    // デフォルトモデル登録
    modelRegistry.registerModel({
      id: "deepseek-v4-pro",
      name: "deepseek-v4-pro",
      provider: "opencode",
      type: "language",
      credentialId: "opencode",
    });
    modelRegistry.registerModel({
      id: "deepseek-v4-flash",
      name: "deepseek-v4-flash",
      provider: "opencode",
      type: "language",
      credentialId: "opencode",
    });
    modelRegistry.registerModel({
      id: "gpt-4o",
      name: "gpt-4o",
      provider: "opencode",
      type: "language",
      credentialId: "opencode",
    });

    logger.info(
      `[ModelRegistry] 初期化完了: ${modelRegistry.credentialCount} クレデンシャル, ${modelRegistry.modelCount} モデル`,
    );
  } catch (e) {
    logger.warn(`[ModelRegistry] ブートストラップ失敗: ${e}`);
  }
})();

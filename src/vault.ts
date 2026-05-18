// ==========================================
// Aikata - Vault（OpenHuman vault/ 由来）
// 暗号化ファイルストレージ + ファイル同期
// ==========================================

import { logger } from "./utils/logger";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ==================== 型定義 ====================

export interface Vault {
  id: string;
  name: string;
  rootPath: string;
  namespace: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  createdAt: number;
  lastSyncedAt: number | null;
  fileCount: number;
  encrypted: boolean;
}

export interface VaultFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  modifiedAt: number;
  hash: string;
  indexed: boolean;
}

export interface VaultSyncReport {
  scanned: number;
  ingested: number;
  unchanged: number;
  removed: number;
  failed: number;
  skippedUnsupported: number;
  durationMs: number;
}

// ==================== Vaultマネージャー ====================

class VaultManager {
  private vaults: Map<string, Vault> = new Map();
  private files: Map<string, VaultFile[]> = new Map();
  private dataDir: string;
  private encryptionKey?: Buffer;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? process.env.AIKATA_VAULT_DIR || "./vaults";
    this.loadEncryptionKey();
  }

  /** 初期化 */
  init(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.loadVaults();
    logger.info(`[Vault] initialized with ${this.vaults.size} vaults`);
  }

  /** Vaultを作成 */
  createVault(
    name: string,
    rootPath: string,
    includeGlobs?: string[],
    excludeGlobs?: string[],
    encrypted?: boolean
  ): Vault {
    // バリデーション
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Vault name required");
    const resolvedRoot = path.resolve(rootPath);
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error(`Root path does not exist: ${resolvedRoot}`);
    }
    if (!fs.statSync(resolvedRoot).isDirectory()) {
      throw new Error(`Root path is not a directory: ${resolvedRoot}`);
    }
    if (this.listVaults().some((v) => v.name === trimmedName)) {
      throw new Error(`Vault "${trimmedName}" already exists`);
    }

    const id = `vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const vault: Vault = {
      id,
      name: trimmedName,
      rootPath: resolvedRoot,
      namespace: `vault:${id}`,
      includeGlobs: includeGlobs ?? ["**/*"],
      excludeGlobs: excludeGlobs ?? [
        "node_modules/**",
        ".git/**",
        "*.log",
        ".DS_Store",
      ],
      createdAt: Date.now(),
      lastSyncedAt: null,
      fileCount: 0,
      encrypted: encrypted ?? false,
    };

    this.vaults.set(id, vault);
    this.saveVaults();
    logger.info(`[Vault] created: ${trimmedName} (${resolvedRoot})`);
    return vault;
  }

  /** Vault一覧 */
  listVaults(): Vault[] {
    return [...this.vaults.values()];
  }

  /** Vaultを取得 */
  getVault(id: string): Vault | undefined {
    return this.vaults.get(id);
  }

  /** Vaultを名前で検索 */
  findVaultByName(name: string): Vault | undefined {
    return this.listVaults().find((v) => v.name === name);
  }

  /** Vaultを削除 */
  removeVault(id: string, purgeFiles?: boolean): boolean {
    const vault = this.vaults.get(id);
    if (!vault) return false;

    this.vaults.delete(id);
    this.files.delete(id);
    this.saveVaults();

    if (purgeFiles) {
      // ファイルインデックスを削除
      const indexPath = path.join(this.dataDir, `index-${id}.json`);
      if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
    }

    logger.info(`[Vault] removed: ${vault.name}`);
    return true;
  }

  /** ファイル一覧を取得 */
  listFiles(vaultId: string): VaultFile[] {
    return this.files.get(vaultId) ?? [];
  }

  /** Vaultを同期（ファイルシステムをスキャン） */
  async syncVault(vaultId: string): Promise<VaultSyncReport> {
    const start = Date.now();
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error(`Vault not found: ${vaultId}`);

    const report: VaultSyncReport = {
      scanned: 0,
      ingested: 0,
      unchanged: 0,
      removed: 0,
      failed: 0,
      skippedUnsupported: 0,
      durationMs: 0,
    };

    try {
      const files = this.scanDirectory(vault);
      report.scanned = files.length;

      // 既存のインデックスと比較
      const existing = this.files.get(vaultId) ?? [];
      const existingMap = new Map(existing.map((f) => [f.relativePath, f]));
      const currentMap = new Map(files.map((f) => [f.relativePath, f]));

      for (const [relPath, file] of currentMap) {
        const prev = existingMap.get(relPath);
        if (prev && prev.hash === file.hash && prev.size === file.size) {
          report.unchanged++;
          // 既存のインデックス状態を維持
          file.indexed = prev.indexed;
        } else {
          report.ingested++;
          file.indexed = true;
        }
      }

      // 削除されたファイルを検出
      for (const [relPath] of existingMap) {
        if (!currentMap.has(relPath)) {
          report.removed++;
        }
      }

      this.files.set(vaultId, files);
      this.saveFileIndex(vaultId, files);

      // Vaultのメタデータを更新
      vault.fileCount = files.length;
      vault.lastSyncedAt = Date.now();
      this.saveVaults();

      report.durationMs = Date.now() - start;
      logger.info(
        `[Vault] synced ${vault.name}: ${report.ingested}新規, ${report.unchanged}変更なし, ${report.removed}削除, ${report.durationMs}ms`
      );
    } catch (err) {
      report.failed = 1;
      logger.error(`[Vault] sync failed for ${vault.name}:`, err);
    }

    return report;
  }

  /** 全Vaultを同期 */
  async syncAll(): Promise<Record<string, VaultSyncReport>> {
    const results: Record<string, VaultSyncReport> = {};
    for (const vault of this.vaults.values()) {
      results[vault.name] = await this.syncVault(vault.id);
    }
    return results;
  }

  /** 暗号化してファイルを保存 */
  encryptAndStore(vaultId: string, relativePath: string, data: string): void {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("Vault not found");
    if (!vault.encrypted) throw new Error("Vault is not encrypted");
    if (!this.encryptionKey) throw new Error("Encryption key not configured");

    const absolutePath = path.join(vault.rootPath, relativePath);
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(data, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // IV + authTag + encrypted を保存
    const output = Buffer.concat([iv, authTag, encrypted]);
    fs.writeFileSync(absolutePath, output);
  }

  /** 暗号化ファイルを読み込み */
  decryptRead(vaultId: string, relativePath: string): string {
    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error("Vault not found");
    if (!this.encryptionKey) throw new Error("Encryption key not configured");

    const absolutePath = path.join(vault.rootPath, relativePath);
    const data = fs.readFileSync(absolutePath);

    const iv = data.subarray(0, 16);
    const authTag = data.subarray(16, 32);
    const encrypted = data.subarray(32);

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final("utf-8");
  }

  /** ファイル内容を取得 */
  readFile(vaultId: string, relativePath: string): string | null {
    const vault = this.vaults.get(vaultId);
    if (!vault) return null;

    if (vault.encrypted) {
      return this.decryptRead(vaultId, relativePath);
    }

    const absolutePath = path.join(vault.rootPath, relativePath);
    if (!fs.existsSync(absolutePath)) return null;
    return fs.readFileSync(absolutePath, "utf-8");
  }

  // ---- 内部実装 ----

  private scanDirectory(vault: Vault): VaultFile[] {
    const files: VaultFile[] = [];

    const walkDir = (dirPath: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return; // 権限エラーなどはスキップ
      }

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(vault.rootPath, fullPath);

        // 除外パターン
        if (this.matchesAny(relativePath, vault.excludeGlobs)) continue;

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          // 包含パターン
          if (!this.matchesAny(relativePath, vault.includeGlobs)) continue;

          try {
            const stat = fs.statSync(fullPath);
            // サポート外のファイルタイプをスキップ（バイナリ等）
            const ext = path.extname(relativePath).toLowerCase();
            const unsupportedExts = [
              ".exe", ".dll", ".so", ".dylib", ".bin",
              ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".ico",
              ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
              ".zip", ".tar", ".gz", ".rar", ".7z",
            ];
            if (unsupportedExts.includes(ext)) {
              continue;
            }

            const hash = this.computeHash(fullPath);
            files.push({
              relativePath,
              absolutePath: fullPath,
              size: stat.size,
              modifiedAt: stat.mtimeMs,
              hash,
              indexed: false,
            });
          } catch {
            continue;
          }
        }
      }
    };

    walkDir(vault.rootPath);
    return files;
  }

  private matchesAny(text: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (this.globMatch(text, pattern)) return true;
    }
    return false;
  }

  /** 簡易globマッチング（*と**対応） */
  private globMatch(text: string, pattern: string): boolean {
    // ** → すべてのパスセグメント
    // * → 単一セグメント内の任意の文字列
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "___DOUBLESTAR___")
      .replace(/\*/g, "[^/]*")
      .replace(/___DOUBLESTAR___/g, ".*");

    try {
      return new RegExp(`^${regexStr}$`).test(text);
    } catch {
      return false;
    }
  }

  private computeHash(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  private loadEncryptionKey(): void {
    const keyEnv = process.env.AIKATA_VAULT_KEY;
    if (keyEnv) {
      this.encryptionKey = crypto.scryptSync(keyEnv, "aikata-vault-salt", 32);
    }
  }

  private loadVaults(): void {
    const dbPath = path.join(this.dataDir, "vaults.json");
    if (!fs.existsSync(dbPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(dbPath, "utf-8")) as Vault[];
      for (const vault of data) {
        this.vaults.set(vault.id, vault);
        // ファイルインデックスを復元
        this.loadFileIndex(vault.id);
      }
    } catch (err) {
      logger.warn("[Vault] failed to load vaults:", err);
    }
  }

  private saveVaults(): void {
    const dbPath = path.join(this.dataDir, "vaults.json");
    try {
      fs.writeFileSync(
        dbPath,
        JSON.stringify([...this.vaults.values()], null, 2)
      );
    } catch (err) {
      logger.error("[Vault] failed to save vaults:", err);
    }
  }

  private loadFileIndex(vaultId: string): void {
    const indexPath = path.join(this.dataDir, `index-${vaultId}.json`);
    if (!fs.existsSync(indexPath)) return;
    try {
      const files = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as VaultFile[];
      this.files.set(vaultId, files);
    } catch {
      // インデックスが壊れている場合は再スキャンが必要
    }
  }

  private saveFileIndex(vaultId: string, files: VaultFile[]): void {
    const indexPath = path.join(this.dataDir, `index-${vaultId}.json`);
    try {
      fs.writeFileSync(indexPath, JSON.stringify(files, null, 2));
    } catch (err) {
      logger.error(`[Vault] failed to save file index for ${vaultId}:`, err);
    }
  }

  /** Vaultの状態をフォーマット */
  formatVault(vault: Vault): string {
    const lastSync = vault.lastSyncedAt
      ? new Date(vault.lastSyncedAt).toLocaleString("ja-JP")
      : "未同期";
    return (
      `📁 **${vault.name}**\n` +
      `ID: \`${vault.id}\`\n` +
      `ルート: ${vault.rootPath}\n` +
      `ファイル数: ${vault.fileCount}\n` +
      `暗号化: ${vault.encrypted ? "✅" : "❌"}\n` +
      `最終同期: ${lastSync}\n` +
      `インクルード: ${vault.includeGlobs.join(", ")}\n` +
      `エクスクルード: ${vault.excludeGlobs.join(", ")}`
    );
  }
}

// ==================== シングルトン ====================

export const vaultManager = new VaultManager();

// ==================== システムコマンド ====================

export function getVaultCommands(): Record<
  string,
  (args: string[]) => string | Promise<string>
> {
  return {
    "/vault": async (args: string[]) => {
      const sub = args[0]?.toLowerCase();

      switch (sub) {
        case "list":
        case "ls": {
          const vaults = vaultManager.listVaults();
          if (vaults.length === 0) return "📭 Vaultがありません";
          return (
            `📁 **Vault一覧 (${vaults.length})**\n\n` +
            vaults
              .map(
                (v, i) =>
                  `${i + 1}. **${v.name}** — ${v.fileCount}ファイル` +
                  ` ${v.encrypted ? "🔒" : "📄"}` +
                  ` (${v.rootPath})`
              )
              .join("\n")
          );
        }

        case "create": {
          const name = args[1];
          const rootPath = args[2];
          if (!name || !rootPath) return "⚠️ 名前とルートパスが必要です";
          try {
            const vault = vaultManager.createVault(name, rootPath);
            return `✅ Vault「${vault.name}」を作成しました\n${vaultManager.formatVault(vault)}`;
          } catch (err) {
            return `❌ ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        case "get": {
          const id = args[1];
          if (!id) return "⚠️ Vault IDが必要です";
          const vault = vaultManager.getVault(id) ?? vaultManager.findVaultByName(id);
          if (!vault) return "❌ Vaultが見つかりません";
          return vaultManager.formatVault(vault);
        }

        case "sync": {
          const id = args[1];
          if (!id) {
            const results = await vaultManager.syncAll();
            return (
              `🔄 **全Vault同期完了**\n\n` +
              Object.entries(results)
                .map(
                  ([name, r]) =>
                    `- **${name}**: ${r.ingested}新規, ${r.unchanged}変更なし, ${r.durationMs}ms`
                )
                .join("\n")
            );
          }
          const vault = vaultManager.getVault(id) ?? vaultManager.findVaultByName(id);
          if (!vault) return "❌ Vaultが見つかりません";
          const report = await vaultManager.syncVault(vault.id);
          return (
            `🔄 **${vault.name} 同期完了**\n` +
            `スキャン: ${report.scanned}\n` +
            `新規: ${report.ingested}\n` +
            `変更なし: ${report.unchanged}\n` +
            `削除: ${report.removed}\n` +
            `所要時間: ${report.durationMs}ms`
          );
        }

        case "files": {
          const id = args[1];
          if (!id) return "⚠️ Vault IDが必要です";
          const vault = vaultManager.getVault(id) ?? vaultManager.findVaultByName(id);
          if (!vault) return "❌ Vaultが見つかりません";
          const files = vaultManager.listFiles(vault.id);
          if (files.length === 0) return "📭 ファイルがありません（`/vault sync`で同期してください）";
          const limit = parseInt(args[2] ?? "20", 10);
          return (
            `📄 **${vault.name} のファイル (${files.length})**\n\n` +
            files
              .slice(0, limit)
              .map(
                (f, i) =>
                  `${i + 1}. ${f.relativePath} (${(f.size / 1024).toFixed(1)}KB)` +
                  ` ${f.indexed ? "✅" : "⏳"}`
              )
              .join("\n") +
            (files.length > limit ? `\n... 他${files.length - limit}ファイル` : "")
          );
        }

        case "remove":
        case "rm": {
          const id = args[1];
          if (!id) return "⚠️ Vault IDが必要です";
          const vault = vaultManager.getVault(id) ?? vaultManager.findVaultByName(id);
          if (!vault) return "❌ Vaultが見つかりません";
          vaultManager.removeVault(vault.id);
          return `🗑️ Vault「${vault.name}」を削除しました`;
        }

        default:
          return (
            `📁 **Vaultコマンド**\n` +
            `/vault list — Vault一覧\n` +
            `/vault create <name> <path> — 新規作成\n` +
            `/vault get <id|name> — 詳細表示\n` +
            `/vault sync [id] — 同期（指定なしで全同期）\n` +
            `/vault files <id> [limit] — ファイル一覧\n` +
            `/vault rm <id> — Vault削除`
          );
      }
    },
  };
}

export default VaultManager;

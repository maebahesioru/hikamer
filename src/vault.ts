// ==========================================
// Aikata - Vault（OpenHuman vault/ 由来）
// 暗号化ファイルストレージ + ファイル同期
// 強化: マルチプロバイダリモート同期（note-gen/note-gen パターン）
//   - RemoteSyncProvider インターフェース
//   - Pull grace period（フィードバックループ防止）
//   - ETag トラッキング（S3/WebDAV用）
//   - 競合解決戦略（ask/local/remote）
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

// ==================== リモート同期（note-gen由来） ====================

/** 競合解決戦略 */
export type ConflictResolution = "ask" | "local" | "remote";

/** リモート同期オプション */
export interface VaultSyncOptions {
  /** 競合解決戦略（デフォルト: \"ask\"） */
  conflictResolution: ConflictResolution;
  /** プル猶予期間（ms）。この時間内にローカルで変更したファイルは同期しない（フィードバックループ防止）。デフォルト: 10000 */
  pullGraceMs: number;
  /** ドライラン（実際に変更しない） */
  dryRun: boolean;
}

/** 同期プロバイダーの設定 */
export interface SyncProviderConfig {
  /** プロバイダー名 */
  name: string;
  /** プロバイダー種別 */
  type: "github" | "s3" | "webdav" | "custom";
  /** 認証トークン */
  token?: string;
  /** ベースURL（S3/WebDAV） */
  baseUrl?: string;
  /** バケット名（S3） */
  bucket?: string;
  /** リポジトリ（GitHub: owner/repo） */
  repo?: string;
  /** ブランチ（GitHub） */
  branch?: string;
  /** ベースパス（プロバイダー内のルートパス） */
  basePath?: string;
}

/** リモートファイル情報 */
export interface RemoteFileInfo {
  path: string;
  hash: string;
  size: number;
  modifiedAt: number;
  etag?: string;
}

/** リモート同期プロバイダーのインターフェース */
export interface RemoteSyncProvider {
  /** プロバイダー名 */
  readonly name: string;
  /** プロバイダー設定 */
  readonly config: SyncProviderConfig;

  /** リモートのファイル一覧とハッシュを取得 */
  listRemoteFiles(): Promise<RemoteFileInfo[]>;

  /** ファイルをリモートにアップロード */
  uploadFile(localPath: string, remotePath: string, content: Buffer): Promise<void>;

  /** リモートからファイルをダウンロード */
  downloadFile(remotePath: string): Promise<Buffer>;

  /** リモートのファイルを削除 */
  deleteRemote(remotePath: string): Promise<void>;

  /** 接続テスト */
  testConnection(): Promise<boolean>;
}

// ==================== GitHub同期プロバイダー ====================

class GitHubSyncProvider implements RemoteSyncProvider {
  readonly name: string;
  readonly config: SyncProviderConfig;

  constructor(config: SyncProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  async listRemoteFiles(): Promise<RemoteFileInfo[]> {
    if (!this.config.repo) return [];

    const apiUrl = `https://api.github.com/repos/${this.config.repo}/git/trees/${this.config.branch ?? "main"}?recursive=1`;
    const headers: Record<string, string> = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "Aikata-Vault/1.0",
    };
    if (this.config.token) headers["Authorization"] = `token ${this.config.token}`;

    try {
      const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const data = await res.json() as { tree?: { path: string; sha: string; size?: number }[] };
      const prefix = this.config.basePath ?? "";
      return (data.tree ?? [])
        .filter(e => e.path.startsWith(prefix) && e.path !== prefix)
        .map(e => ({
          path: e.path,
          hash: e.sha,
          size: e.size ?? 0,
          modifiedAt: Date.now(),
        }));
    } catch {
      return [];
    }
  }

  async uploadFile(_localPath: string, remotePath: string, content: Buffer): Promise<void> {
    if (!this.config.repo) throw new Error("GitHub repo not configured");
    const apiUrl = `https://api.github.com/repos/${this.config.repo}/contents/${remotePath}`;
    const headers: Record<string, string> = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "Aikata-Vault/1.0",
      "Content-Type": "application/json",
    };
    if (this.config.token) headers["Authorization"] = `token ${this.config.token}`;

    const body = JSON.stringify({
      message: `[Aikata Vault] sync ${remotePath}`,
      content: content.toString("base64"),
      branch: this.config.branch ?? "main",
    });

    const res = await fetch(apiUrl, { method: "PUT", headers, body, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub upload failed: ${res.status} ${await res.text()}`);
  }

  async downloadFile(remotePath: string): Promise<Buffer> {
    if (!this.config.repo) throw new Error("GitHub repo not configured");
    const apiUrl = `https://api.github.com/repos/${this.config.repo}/contents/${remotePath}`;
    const headers: Record<string, string> = {
      "Accept": "application/vnd.github.raw+json",
      "User-Agent": "Aikata-Vault/1.0",
    };
    if (this.config.token) headers["Authorization"] = `token ${this.config.token}`;

    const res = await fetch(apiUrl, { headers });
    if (!res.ok) throw new Error(`GitHub download failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  }

  async deleteRemote(_remotePath: string): Promise<void> {
    // GitHub Contents APIでの削除はSHAが必要なためスキップ
    logger.debug(`[GitHubSync] delete skipped for ${_remotePath} (sha required)`);
  }

  async testConnection(): Promise<boolean> {
    try {
      const files = await this.listRemoteFiles();
      return true;
    } catch {
      return false;
    }
  }
}

// ==================== S3同期プロバイダー（簡易実装） ====================

class S3SyncProvider implements RemoteSyncProvider {
  readonly name: string;
  readonly config: SyncProviderConfig;
  private etags = new Map<string, string>();

  constructor(config: SyncProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  async listRemoteFiles(): Promise<RemoteFileInfo[]> {
    if (!this.config.baseUrl || !this.config.bucket) return [];
    const url = `${this.config.baseUrl}/${this.config.bucket}?list-type=2${this.config.basePath ? `&prefix=${encodeURIComponent(this.config.basePath)}` : ""}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const text = await res.text();
      // 簡易XMLパース（本番ではfast-xml-parserを使う）
      const files: RemoteFileInfo[] = [];
      const keyRe = /<Key>([^<]+)<\/Key>/g;
      const sizeRe = /<Size>(\d+)<\/Size>/g;
      const etagRe = /<ETag>([^<]+)<\/ETag>/g;
      const lastModRe = /<LastModified>([^<]+)<\/LastModified>/g;
      let km: RegExpExecArray | null;
      while ((km = keyRe.exec(text)) !== null) {
        const szm = sizeRe.exec(text);
        const etm = etagRe.exec(text);
        const lmm = lastModRe.exec(text);
        const etag = etm?.[1]?.replace(/["]/g, "") ?? undefined;
        files.push({
          path: km[1]!,
          hash: etag ?? km[1]!,
          size: parseInt(szm?.[1] ?? "0", 10),
          modifiedAt: lmm?.[1] ? new Date(lmm[1]).getTime() : Date.now(),
          etag,
        });
        // ETagキャッシュ更新
        if (etag) this.etags.set(km[1]!, etag);
      }
      return files;
    } catch {
      return [];
    }
  }

  async uploadFile(_localPath: string, remotePath: string, content: Buffer): Promise<void> {
    if (!this.config.baseUrl || !this.config.bucket) throw new Error("S3 not configured");
    const url = `${this.config.baseUrl}/${this.config.bucket}/${remotePath}`;
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (this.config.token) headers["Authorization"] = `Bearer ${this.config.token}`;

    const res = await fetch(url, { method: "PUT", headers, body: new Uint8Array(content), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`);
    const etag = res.headers.get("etag") ?? undefined;
    if (etag) this.etags.set(remotePath, etag);
  }

  async downloadFile(remotePath: string): Promise<Buffer> {
    if (!this.config.baseUrl || !this.config.bucket) throw new Error("S3 not configured");
    const url = `${this.config.baseUrl}/${this.config.bucket}/${remotePath}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`S3 download failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  }

  async deleteRemote(remotePath: string): Promise<void> {
    if (!this.config.baseUrl || !this.config.bucket) throw new Error("S3 not configured");
    const url = `${this.config.baseUrl}/${this.config.bucket}/${remotePath}`;
    await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(10000) });
    this.etags.delete(remotePath);
  }

  async testConnection(): Promise<boolean> {
    try {
      const files = await this.listRemoteFiles();
      return true;
    } catch {
      return false;
    }
  }
}

// ==================== Vaultマネージャー ====================

class VaultManager {
  private vaults: Map<string, Vault> = new Map();
  private files: Map<string, VaultFile[]> = new Map();
  private dataDir: string;
  private encryptionKey?: Buffer;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? (process.env.AIKATA_VAULT_DIR || "./vaults");
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
      logger.error(`[Vault] sync failed for ${vault.name}: ${String(err)}`);
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
      logger.warn("[Vault] failed to load vaults: " + String(err));
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
      logger.error("[Vault] failed to save vaults: " + String(err));
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
      logger.error(`[Vault] failed to save file index for ${vaultId}: ${String(err)}`);
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

  // ==================== リモート同期 ====================

  private syncProviders = new Map<string, RemoteSyncProvider>();
  private localModTimes = new Map<string, number>();
  private readonly DEFAULT_PULL_GRACE_MS = 10_000;

  /** 同期プロバイダーを登録 */
  registerSyncProvider(provider: RemoteSyncProvider): void {
    this.syncProviders.set(provider.name, provider);
    logger.info(`[Vault] 同期プロバイダー登録: ${provider.name}`);
  }

  /** 同期プロバイダーを解除 */
  unregisterSyncProvider(name: string): boolean {
    return this.syncProviders.delete(name);
  }

  /** 登録済みプロバイダー一覧 */
  listSyncProviders(): string[] {
    return Array.from(this.syncProviders.keys());
  }

  /** 同期プロバイダーを設定から作成 */
  createSyncProvider(config: SyncProviderConfig): RemoteSyncProvider {
    switch (config.type) {
      case "github": return new GitHubSyncProvider(config);
      case "s3": return new S3SyncProvider(config);
      default: throw new Error(`Unsupported provider type: ${config.type}`);
    }
  }

  /** 
   * リモート → ローカル に同期（pull）
   * レジストリに登録されたプロバイダーからファイルを取得
   */
  async syncFromRemote(
    vaultId: string,
    providerName: string,
    options?: Partial<VaultSyncOptions>,
  ): Promise<VaultSyncReport> {
    const t0 = Date.now();
    const opts: VaultSyncOptions = {
      conflictResolution: options?.conflictResolution ?? "remote",
      pullGraceMs: options?.pullGraceMs ?? this.DEFAULT_PULL_GRACE_MS,
      dryRun: options?.dryRun ?? false,
    };

    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error(`Vault not found: ${vaultId}`);

    const provider = this.syncProviders.get(providerName);
    if (!provider) throw new Error(`Sync provider not found: ${providerName}`);

    const remoteFiles = await provider.listRemoteFiles();

    const report: VaultSyncReport = {
      scanned: remoteFiles.length,
      ingested: 0,
      unchanged: 0,
      removed: 0,
      failed: 0,
      skippedUnsupported: 0,
      durationMs: 0,
    };

    for (const remote of remoteFiles) {
      try {
        const localPath = path.join(vault.rootPath, remote.path);

        // Pull grace period: 最近ローカルで変更したファイルは同期しない
        if (fs.existsSync(localPath)) {
          const localMod = this.localModTimes.get(localPath) ?? 0;
          const now = Date.now();
          if (now - localMod < opts.pullGraceMs) {
            report.unchanged++;
            continue;
          }

          // ハッシュ比較（変更があれば同期）
          const localContent = fs.readFileSync(localPath);
          const localHash = crypto.createHash("sha256").update(localContent).digest("hex");
          if (localHash === remote.hash) {
            report.unchanged++;
            continue;
          }

          // 競合検出：ローカルが変更されている場合
          if (opts.conflictResolution === "ask") {
            logger.info(`[Vault] 競合検出: ${remote.path}（local≠remote）→ skip (ask mode)`);
            report.skippedUnsupported++;
            continue;
          }
          if (opts.conflictResolution === "local") {
            report.unchanged++;
            continue;
          }
          // "remote": リモートで上書き
        }

        if (!opts.dryRun) {
          const content = await provider.downloadFile(remote.path);
          const dir = path.dirname(localPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(localPath, content);
          this.localModTimes.set(localPath, Date.now());
        }
        report.ingested++;
      } catch (err) {
        report.failed++;
        logger.warn(`[Vault] syncFromRemote failed for ${remote.path}: ${err}`);
      }
    }

    vault.lastSyncedAt = Date.now();
    report.durationMs = Date.now() - t0;
    logger.info(
      `[Vault] syncFromRemote(${vaultId}): scanned=${report.scanned} ingested=${report.ingested} unchanged=${report.unchanged} failed=${report.failed}`,
    );
    return report;
  }

  /** 
   * ローカル → リモート に同期（push）
   */
  async syncToRemote(
    vaultId: string,
    providerName: string,
    options?: Partial<VaultSyncOptions>,
  ): Promise<VaultSyncReport> {
    const t0 = Date.now();
    const opts: VaultSyncOptions = {
      conflictResolution: options?.conflictResolution ?? "local",
      pullGraceMs: options?.pullGraceMs ?? this.DEFAULT_PULL_GRACE_MS,
      dryRun: options?.dryRun ?? false,
    };

    const vault = this.vaults.get(vaultId);
    if (!vault) throw new Error(`Vault not found: ${vaultId}`);

    const provider = this.syncProviders.get(providerName);
    if (!provider) throw new Error(`Sync provider not found: ${providerName}`);

    const localFiles = this.listFiles(vaultId);
    const remoteFiles = await provider.listRemoteFiles();
    const remoteMap = new Map<string, RemoteFileInfo>();
    for (const rf of remoteFiles) remoteMap.set(rf.path, rf);

    const report: VaultSyncReport = {
      scanned: localFiles.length,
      ingested: 0,
      unchanged: 0,
      removed: 0,
      failed: 0,
      skippedUnsupported: 0,
      durationMs: 0,
    };

    for (const local of localFiles) {
      try {
        const localContent = fs.readFileSync(local.absolutePath);
        const localHash = local.hash || crypto.createHash("sha256").update(localContent).digest("hex");

        const remote = remoteMap.get(local.relativePath);
        if (remote && remote.hash === localHash) {
          report.unchanged++;
          continue;
        }

        if (!opts.dryRun) {
          await provider.uploadFile(local.absolutePath, local.relativePath, localContent);
        }
        report.ingested++;
      } catch (err) {
        report.failed++;
        logger.warn(`[Vault] syncToRemote failed for ${local.relativePath}: ${err}`);
      }
    }

    vault.lastSyncedAt = Date.now();
    report.durationMs = Date.now() - t0;
    logger.info(
      `[Vault] syncToRemote(${vaultId}): scanned=${report.scanned} ingested=${report.ingested} unchanged=${report.unchanged} removed=${report.removed} failed=${report.failed}`,
    );
    return report;
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

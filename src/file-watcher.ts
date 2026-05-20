// ==========================================
// Hikamer - ファイル監視（OpenHuman file_watcher由来）
// ファイル/ディレクトリの変更をリアルタイム検知
// ==========================================

import { watch, FSWatcher } from "fs";
import { resolve, relative } from "path";
import { logger } from "./utils/logger";
import { eventBus, createEvent } from "./event-bus";

// ==================== 型定義 ====================

export interface WatchEntry {
  path: string;
  recursive: boolean;
  extensions?: string[];
  ignorePatterns?: RegExp[];
  onChange: (event: "change" | "rename", filePath: string) => void;
}

interface ActiveWatch {
  entry: WatchEntry;
  watcher: FSWatcher;
  startedAt: number;
}

// ==================== ウォッチャー管理 ====================

const activeWatches = new Map<string, ActiveWatch>();
const _changeBuffer = new Map<string, number>(); // debounce

function getWatchKey(path: string): string {
  return resolve(path);
}

// デバウンス（同一ファイル変更が100ms以内なら1回にまとめる）
const DEBOUNCE_MS = 100;

function debouncedNotify(key: string, fn: () => void): void {
  const existing = _changeBuffer.get(key);
  if (existing) clearTimeout(existing);
  _changeBuffer.set(key, setTimeout(() => {
    _changeBuffer.delete(key);
    fn();
  }, DEBOUNCE_MS) as unknown as number);
}

// ==================== 公開API ====================

/**
 * ファイル監視を開始
 * @returns 一意のウォッチID（停止に使用）
 */
export function startWatch(
  path: string,
  options?: {
    recursive?: boolean;
    extensions?: string[];
    ignore?: RegExp[];
    onChange?: (event: "change" | "rename", filePath: string) => void;
    name?: string;
  },
): string {
  const watchPath = resolve(path);
  const watchKey = getWatchKey(watchPath);

  // 既存があればstop
  if (activeWatches.has(watchKey)) {
    stopWatch(watchKey);
  }

  const entry: WatchEntry = {
    path: watchPath,
    recursive: options?.recursive ?? true,
    extensions: options?.extensions,
    ignorePatterns: options?.ignore,
    onChange: options?.onChange || ((event, filePath) => {
      const relPath = relative(watchPath, filePath);
      logger.info(`[FileWatch] ${event}: ${relPath}`);
      eventBus.publish(createEvent("system", "fileChanged", {
        watchPath,
        filePath,
        relPath,
        event,
      }));
    }),
  };

  try {
    const watcher = watch(watchPath, {
      recursive: entry.recursive,
    }, (event, filename) => {
      if (!filename) return;

      const filePath = resolve(watchPath, filename.toString());
      const relPath = relative(watchPath, filePath);

      // 拡張子フィルタ
      if (entry.extensions && entry.extensions.length > 0) {
        const ext = "." + filePath.split(".").pop()?.toLowerCase();
        if (!entry.extensions.includes(ext)) return;
      }

      // ignoreパターン
      if (entry.ignorePatterns) {
        for (const p of entry.ignorePatterns) {
          if (p.test(relPath) || p.test(filePath)) return;
        }
      }

      // デバウンスして通知
      debouncedNotify(filePath, () => {
        try {
          entry.onChange(event as "change" | "rename", filePath);
        } catch (e: any) {
          logger.error(`[FileWatch] ハンドラエラー: ${e.message}`);
        }
      });
    });

    const active: ActiveWatch = { entry, watcher, startedAt: Date.now() };
    activeWatches.set(watchKey, active);

    logger.info(`[FileWatch] 開始: ${watchPath} (recursive=${entry.recursive})`);
    eventBus.publish(createEvent("system", "watchStarted", {
      path: watchPath,
      recursive: entry.recursive,
    }));

    return watchKey;
  } catch (e: any) {
    logger.error(`[FileWatch] 開始失敗: ${watchPath} — ${e.message}`);
    throw e;
  }
}

/** ウォッチ停止 */
export function stopWatch(watchKey: string): boolean {
  const active = activeWatches.get(watchKey);
  if (!active) return false;

  try {
    active.watcher.close();
  } catch {}
  activeWatches.delete(watchKey);
  logger.info(`[FileWatch] 停止: ${watchKey}`);
  eventBus.publish(createEvent("system", "watchStopped", { path: watchKey }));
  return true;
}

/** 全部停止 */
export function stopAllWatches(): void {
  for (const key of Array.from(activeWatches.keys())) {
    stopWatch(key);
  }
}

/** アクティブなウォッチ一覧 */
export function listWatches(): Array<{
  key: string;
  path: string;
  recursive: boolean;
  extensions?: string[];
  startedAt: number;
  uptime: number;
}> {
  return Array.from(activeWatches.entries()).map(([key, active]) => ({
    key,
    path: active.entry.path,
    recursive: active.entry.recursive,
    extensions: active.entry.extensions,
    startedAt: active.startedAt,
    uptime: Date.now() - active.startedAt,
  }));
}

/** 構成ファイル自動リロード（config.yaml等） */
export function watchConfig(
  configPath: string,
  onReload: () => void,
): string {
  return startWatch(configPath, {
    recursive: false,
    onChange: (event) => {
      if (event === "change") {
        logger.info(`[FileWatch] 設定変更検出: ${configPath}`);
        try {
          onReload();
          logger.info(`[FileWatch] 設定再読み込み完了`);
          eventBus.publish(createEvent("system", "configReloaded", { path: configPath }));
        } catch (e: any) {
          logger.error(`[FileWatch] 設定再読込失敗: ${e.message}`);
        }
      }
    },
    name: "config-watch",
  });
}

// プロセス終了時クリーンアップ
process.on("exit", () => stopAllWatches());
process.on("SIGINT", () => { stopAllWatches(); });
process.on("SIGTERM", () => { stopAllWatches(); });

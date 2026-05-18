// ==========================================
// Aikata - ユーティリティ（OpenHuman 残り小モジュール 由来）
// JavaScript・開発パス・HTTPホスト・WebView API/通知
// ==========================================

import { logger } from "./utils/logger";
import * as fs from "fs";
import * as path from "path";

// ==================== JavaScript実行 ====================

export function executeJavaScript(code: string): { result: string; error?: string } {
  try {
    // 簡易eval（Node VMは後日）
    const fn = new Function(`"use strict"; return (${code})`);
    const result = fn();
    return { result: String(result) };
  } catch (err) {
    return { result: "", error: err instanceof Error ? err.message : String(err) };
  }
}

// ==================== 開発パス ====================

export interface DevPath {
  name: string;
  path: string;
  type: "project" | "config" | "data" | "temp";
}

export function getDevPaths(): DevPath[] {
  const home = process.env.HOME || "/root";
  const cwd = process.cwd();

  return [
    { name: "cwd", path: cwd, type: "project" },
    { name: "home", path: home, type: "project" },
    { name: "data", path: process.env.DATA_DIR || "./data", type: "data" },
    { name: "vault", path: process.env.AIKATA_VAULT_DIR || "./vaults", type: "data" },
    { name: "temp", path: "/tmp", type: "temp" },
    { name: "config", path: process.env.HOME ? path.join(process.env.HOME, ".config", "aikata") : "./config", type: "config" },
  ];
}

// ==================== HTTPホスト ====================

export interface HttpHostConfig {
  host: string;
  port: number;
  protocol: "http" | "https";
  basePath: string;
}

export function getHttpHostConfig(): HttpHostConfig {
  return {
    host: process.env.HTTP_HOST || "127.0.0.1",
    port: parseInt(process.env.HTTP_PORT || "9721", 10),
    protocol: (process.env.HTTP_PROTOCOL as "http" | "https") || "http",
    basePath: process.env.HTTP_BASE_PATH || "/",
  };
}

// ==================== WebView API ====================

export interface WebViewBridge {
  apiName: string;
  endpoint: string;
  methods: string[];
}

export function getWebViewBridges(): WebViewBridge[] {
  return [
    { apiName: "filesystem", endpoint: "/api/fs", methods: ["read", "write", "list"] },
    { apiName: "terminal", endpoint: "/api/term", methods: ["exec"] },
    { apiName: "search", endpoint: "/api/search", methods: ["query"] },
    { apiName: "memory", endpoint: "/api/memory", methods: ["get", "set", "delete"] },
  ];
}

// ==================== WebView通知 ====================

export interface WebViewNotification {
  id: string;
  title: string;
  body: string;
  type: "info" | "success" | "warning" | "error";
  timestamp: number;
  source: string;
  read: boolean;
}

class WebViewNotificationManager {
  private notifications: WebViewNotification[] = [];
  private maxNotifications = 50;

  send(title: string, body: string, type?: WebViewNotification["type"], source?: string): WebViewNotification {
    const notification: WebViewNotification = {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      body,
      type: type ?? "info",
      timestamp: Date.now(),
      source: source ?? "system",
      read: false,
    };
    this.notifications.push(notification);
    if (this.notifications.length > this.maxNotifications) {
      this.notifications.shift();
    }
    return notification;
  }

  list(limit = 20): WebViewNotification[] {
    return this.notifications.slice(-limit).reverse();
  }

  markRead(id: string): boolean {
    const n = this.notifications.find((n) => n.id === id);
    if (!n) return false;
    n.read = true;
    return true;
  }

  markAllRead(): number {
    let count = 0;
    for (const n of this.notifications) {
      if (!n.read) { n.read = true; count++; }
    }
    return count;
  }

  formatStatus(): string {
    const unread = this.notifications.filter((n) => !n.read).length;
    return (
      `🔔 **WebView通知**\n` +
      `総通知: ${this.notifications.length}\n` +
      `未読: ${unread}\n` +
      (unread > 0
        ? `\n**最新通知**\n` +
          this.list(5)
            .map((n) => `${n.read ? "✅" : "🔵"} [${n.type}] ${n.title}: ${n.body.slice(0, 50)}`)
            .join("\n")
        : "")
    );
  }
}

export const webViewNotifications = new WebViewNotificationManager();

// ==================== 統合フォーマット ====================

export function formatMiscStatus(): string {
  const paths = getDevPaths();
  const http = getHttpHostConfig();
  const bridges = getWebViewBridges();
  const notifs = webViewNotifications.list(5);

  return (
    `🔧 **ユーティリティ**\n\n` +
    `**開発パス**\n${paths.map((p) => `- ${p.name}: ${p.path}`).join("\n")}\n\n` +
    `**HTTPホスト**\n${http.protocol}://${http.host}:${http.port}${http.basePath}\n\n` +
    `**WebView API**\n${bridges.map((b) => `- ${b.apiName}: ${b.endpoint}`).join("\n")}\n\n` +
    `**通知**\n${notifs.length > 0 ? notifs.map((n) => `- [${n.type}] ${n.title}`).join("\n") : "通知なし"}`
  );
}

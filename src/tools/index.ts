// ==========================================
// Aikata - 全ツール読み込み
// 各ツールファイルをimportするだけで自動登録される
// ==========================================

import "./terminal";
import "./web";
import "./file";
import "./code";
import "./browser";
import "./schedule";
import "./sqlite";
import "./memory";
import "./delegate";
import "./search";
import "./export";

export { toolRegistry } from "./registry";

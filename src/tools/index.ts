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

export { toolRegistry } from "./registry";

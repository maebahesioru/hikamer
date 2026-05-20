// ==========================================
// Hikamer - CLIテストモード (v1.2 - コマンド統合)
// ==========================================

import { createInterface } from "readline";
import "./tools/index"; // 自己登録
import { agentLoop } from "./agent";
import { buildSystemPrompt } from "./system-prompt";
import { logger } from "./utils/logger";
import { resetConversation } from "./repo";
import {
  getProviders, addProvider, removeProvider,
  setActiveProvider, setActiveModelOnly, getActiveModel,
  getRuntimeConfig, setMaxIterations,
  type ProviderType,
} from "./utils/config";
import { createActiveProvider, fetchModels } from "./providers/base";
import "./db";

let provider = createActiveProvider();

function printHelp() {
  console.log(`
/provider list               一覧
/provider set <name>         切替
/provider add <key> <type> <url> <key>  追加 (type: openai/anthropic/gemini)
/provider del <key>          削除
/model <name>                モデル切替
/models                      モデル一覧
/maxiter <n>                 最大反復 (200)
/info                        設定
/reset                       リセット
/exit                        終了`);
}

logger.info("Hikamer CLI v1.2");
logger.info(`${getActiveModel().provider}/${getActiveModel().model}`);
printHelp();

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "💬> " });
const cid = "cli-session";
let running = false;

rl.prompt();

rl.on("line", async (line) => {
  const input = line.trim();
  if (!input) { rl.prompt(); return; }

  if (input.startsWith("/")) {
    const parts = input.split(/\s+/);
    const cmd = parts[0];

    try {
      switch (cmd) {
        case "/exit": logger.info("またな！"); rl.close(); process.exit(0);
        case "/reset": resetConversation(cid); logger.info("リセット。"); break;
        case "/info": {
          const a = getActiveModel(); const r = getRuntimeConfig();
          console.log(`provider=${a.provider} model=${a.model} maxIter=${r.maxIterations}`);
          break;
        }
        case "/provider": {
          const sub = parts[1];
          if (!sub || sub === "list") {
            const providers = getProviders();
            const active = getActiveModel();
            for (const [k, v] of Object.entries(providers.providers)) {
              console.log(`${k === active.provider ? "▶" : " "} ${k} (${v.type}) → ${v.baseUrl}`);
            }
            if (!Object.keys(providers.providers).length) console.log("(登録なし)");
          } else if (sub === "set") {
            const name = parts[2]; if (!name) { console.log("使い方: /provider set <name>"); break; }
            setActiveProvider(name); provider = createActiveProvider(); console.log(`→ ${name}`);
          } else if (sub === "add") {
            const [,, key, type, baseUrl, apiKey] = parts;
            if (!key || !type || !baseUrl) { console.log("使い方: /provider add <key> <openai|anthropic|gemini> <baseUrl>"); break; }
            addProvider(key, { name: key, type: type as ProviderType, baseUrl });
            console.log(`追加: ${key} (${type})`);
          } else if (sub === "del") {
            const key = parts[2]; if (!key) { console.log("使い方: /provider del <key>"); break; }
            removeProvider(key); console.log(`削除: ${key}`);
          } else { console.log(`不明なサブコマンド: ${sub}`); }
          break;
        }
        case "/model": {
          setActiveModelOnly(parts[1] || ""); provider = createActiveProvider(); console.log(`→ ${parts[1]}`);
          break;
        }
        case "/models": {
          const models = await fetchModels(getActiveModel().provider);
          console.log(models.slice(0, 30).join("\n"));
          break;
        }
        case "/maxiter": {
          setMaxIterations(parseInt(parts[1]) || 200); console.log(`最大反復 → ${parts[1]}`);
          break;
        }
        default: console.log(`不明: ${cmd}`); printHelp();
      }
    } catch (e: any) { console.log(`エラー: ${e.message}`); }
    rl.prompt();
    return;
  }

  if (running) { logger.warn("処理中。"); rl.prompt(); return; }
  running = true;
  try {
    const result = await agentLoop(provider, await buildSystemPrompt(), input, cid, "cli");
    console.log(`\n🤖 Hikamer:\n${result.response}`);
    console.log(`\n(${result.iterations}反復, ${result.toolLogs.length}ツール)`);
  } catch (e: any) { logger.error(`エラー: ${e.message}`); }
  finally { running = false; rl.prompt(); }
});

rl.on("close", () => process.exit(0));

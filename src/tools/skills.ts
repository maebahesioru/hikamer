// ==========================================
// Aikata - スキル管理ツール（Hermes Agent + OpenHuman由来）
// スキルの一覧/表示
// ==========================================

import type { ToolDescriptor } from "../types";
import { toolRegistry } from "./registry";
import { skillLoader } from "../skills";

const listTool: ToolDescriptor = {
  name: "list_skills",
  emoji: "📚",
  owner: "core",
  description: "インストールされているスキル一覧を表示します。スキルは data/skills/<name>/SKILL.md で管理。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute() {
    const skills = skillLoader.listInvokable();
    if (skills.length === 0) {
      return "📚 スキルはまだインストールされていません。\n`data/skills/<name>/SKILL.md` にファイルを作成すると自動認識されます。";
    }

    const lines = skills.map(s =>
      `• **${s.meta.name}**${s.meta.version ? ` v${s.meta.version}` : ""}` +
      (s.meta.description ? ` — ${s.meta.description}` : "") +
      (s.meta.tags?.length ? ` [${s.meta.tags.join(", ")}]` : "") +
      `\n  使い方: 会話中に \`@${s.meta.name}\` と書くと自動展開`
    );

    return `📚 **利用可能なスキル** (${skills.length}件)\n\n${lines.join("\n")}`;
  },
};

const viewTool: ToolDescriptor = {
  name: "view_skill",
  emoji: "📖",
  owner: "core",
  description: "スキルの詳細内容を表示します。",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "スキル名",
      },
    },
    required: ["name"],
  },
  async execute(args) {
    const name = args.name as string;
    if (!name) return "[エラー] name が必要です";

    const skill = skillLoader.get(name);
    if (!skill) return `📖 スキル \`${name}\` は見つかりません。`;

    return `📖 **${skill.meta.name}**${skill.meta.version ? ` v${skill.meta.version}` : ""}\n` +
      (skill.meta.author ? `作者: ${skill.meta.author}\n` : "") +
      (skill.meta.description ? `説明: ${skill.meta.description}\n` : "") +
      `\n---\n${skill.body.slice(0, 4000)}`;
  },
};

toolRegistry.register(listTool);
toolRegistry.register(viewTool);

export { listTool, viewTool };

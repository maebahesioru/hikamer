// ==========================================
// Aikata - サンドボックス実行（OpenHuman security/sandbox由来）
// 隔離環境でのコマンド実行・Landlock/Bubblewrap対応
// ==========================================

import { execSync, spawn, ChildProcess } from "child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import { logger } from "./utils/logger";
import { stripAnsi } from "./ansi-strip";

// ==================== 型定義 ====================

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sandboxType: "none" | "bubblewrap" | "firejail" | "docker" | "tempdir";
}

export interface SandboxOptions {
  timeout?: number;
  memoryLimit?: string;  // "512M", "1G"
  network?: boolean;
  readOnlyPaths?: string[];
  writablePaths?: string[];
  env?: Record<string, string>;
  workdir?: string;
}

// ==================== サンドボックス検出 ====================

function detectSandbox(): "bubblewrap" | "firejail" | "docker" | "tempdir" | "none" {
  try {
    if (execSync("which bwrap 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) return "bubblewrap";
    if (execSync("which firejail 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) return "firejail";
    if (execSync("which docker 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) return "docker";
  } catch {}
  return process.platform === "win32" ? "none" : "tempdir";
}

// ==================== サンドボックス実行 ====================

export async function runSandboxed(
  command: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const sandboxType = process.env.SANDBOX_TYPE as any || detectSandbox();
  const timeout = options.timeout || 30000;
  const workdir = options.workdir || process.cwd();
  const start = Date.now();

  // 危険コマンド追加チェック
  if (isDangerousCommand(command) && sandboxType === "none") {
    return {
      stdout: "",
      stderr: "[Sandbox] 危険コマンドはサンドボックスなしでは実行できません。SANDBOX_TYPE を設定してください。",
      exitCode: -1,
      durationMs: 0,
      sandboxType: "none",
    };
  }

  let result: SandboxResult;

  switch (sandboxType) {
    case "bubblewrap":
      result = runBubblewrap(command, timeout, workdir, options);
      break;
    case "firejail":
      result = runFirejail(command, timeout, workdir, options);
      break;
    case "docker":
      result = await runDocker(command, timeout, workdir, options);
      break;
    case "tempdir":
      result = runTempdir(command, timeout, workdir, options);
      break;
    default:
      result = runDirect(command, timeout, workdir);
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ==================== 実装 ====================

/** Bubblewrap（Linux namespace isolation） */
function runBubblewrap(command: string, timeout: number, workdir: string, options: SandboxOptions): SandboxResult {
  const args = [
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/etc", "/etc",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];

  if (!options.network) args.push("--unshare-net");

  if (options.readOnlyPaths) {
    for (const p of options.readOnlyPaths) args.push("--ro-bind", p, p);
  }
  if (options.writablePaths) {
    for (const p of options.writablePaths) args.push("--bind", p, p);
  }

  args.push("--bind", workdir, workdir);
  args.push("--chdir", workdir);
  args.push("/bin/bash", "-c", command);

  try {
    const result = execSync(`bwrap ${args.join(" ")}`, {
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stripAnsi(result.toString().trim()), stderr: "", exitCode: 0, durationMs: 0, sandboxType: "bubblewrap" };
  } catch (e: any) {
    return {
      stdout: stripAnsi(e.stdout?.toString() || "").trim(),
      stderr: stripAnsi(e.stderr?.toString() || e.message).trim(),
      exitCode: e.status || -1,
      durationMs: 0,
      sandboxType: "bubblewrap",
    };
  }
}

/** Firejail */
function runFirejail(command: string, timeout: number, workdir: string, options: SandboxOptions): SandboxResult {
  const args = ["--quiet", "--private", `--chdir=${workdir}`];
  if (!options.network) args.push("--net=none");
  if (options.memoryLimit) args.push(`--rlimit-as=${options.memoryLimit}`);

  try {
    const result = execSync(`firejail ${args.join(" ")} /bin/bash -c "${command.replace(/"/g, '\\"')}"`, {
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stripAnsi(result.toString().trim()), stderr: "", exitCode: 0, durationMs: 0, sandboxType: "firejail" };
  } catch (e: any) {
    return {
      stdout: stripAnsi(e.stdout?.toString() || "").trim(),
      stderr: stripAnsi(e.stderr?.toString() || e.message).trim(),
      exitCode: e.status || -1,
      durationMs: 0,
      sandboxType: "firejail",
    };
  }
}

/** Docker */
async function runDocker(command: string, timeout: number, workdir: string, options: SandboxOptions): Promise<SandboxResult> {
  const image = process.env.SANDBOX_DOCKER_IMAGE || "ubuntu:22.04";
  const containerName = `aikata-sandbox-${Date.now()}`;

  const dockerArgs = [
    "run", "--rm",
    "--name", containerName,
    "--network", options.network ? "bridge" : "none",
    "--memory", options.memoryLimit || "512m",
    "--read-only",
    "-w", workdir,
    "-v", `${workdir}:${workdir}`,
    image,
    "/bin/bash", "-c", command,
  ];

  try {
    const result = execSync(`docker ${dockerArgs.join(" ")}`, {
      timeout,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stripAnsi(result.toString().trim()), stderr: "", exitCode: 0, durationMs: 0, sandboxType: "docker" };
  } catch (e: any) {
    return {
      stdout: stripAnsi(e.stdout?.toString() || "").trim(),
      stderr: stripAnsi(e.stderr?.toString() || e.message).trim(),
      exitCode: e.status || -1,
      durationMs: 0,
      sandboxType: "docker",
    };
  }
}

/** Tempdir隔離（シンボリックリンク対策） */
function runTempdir(command: string, timeout: number, workdir: string, options: SandboxOptions): SandboxResult {
  const tmpDir = resolve(tmpdir(), `aikata-sandbox-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // 危険なシンボリックリンクチェック
    const script = `
set -e
cd "${tmpDir}"
cp -r "${workdir}/." "${tmpDir}/" 2>/dev/null || true
${command}
`;
    const result = execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stripAnsi(result.toString().trim()), stderr: "", exitCode: 0, durationMs: 0, sandboxType: "tempdir" };
  } catch (e: any) {
    return {
      stdout: stripAnsi(e.stdout?.toString() || "").trim(),
      stderr: stripAnsi(e.stderr?.toString() || e.message).trim(),
      exitCode: e.status || -1,
      durationMs: 0,
      sandboxType: "tempdir",
    };
  } finally {
    try { execSync(`rm -rf "${tmpDir}"`, { timeout: 5000 }); } catch {}
  }
}

/** 直接実行（サンドボックスなし） */
function runDirect(command: string, timeout: number, workdir: string): SandboxResult {
  try {
    const result = execSync(command, {
      cwd: workdir,
      timeout,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stripAnsi(result.toString().trim()), stderr: "", exitCode: 0, durationMs: 0, sandboxType: "none" };
  } catch (e: any) {
    return {
      stdout: stripAnsi(e.stdout?.toString() || "").trim(),
      stderr: stripAnsi(e.stderr?.toString() || e.message).trim(),
      exitCode: e.status || -1,
      durationMs: 0,
      sandboxType: "none",
    };
  }
}

// ==================== 危険コマンド検出 ====================

const DANGEROUS_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+\//,
  /mkfs|fdisk|dd\s+because/,
  /chmod\s+-R\s+0{3,4}/,
  />\s*\/dev\/(sda|nvme|vda)/,
  /:\(\)\s*\{/,
];

function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(cmd));
}

// ==================== サンドボックス能力 ====================

export function getSandboxCapabilities(): string[] {
  const caps: string[] = [];
  try { if (execSync("which bwrap 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) caps.push("bubblewrap"); } catch {}
  try { if (execSync("which firejail 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) caps.push("firejail"); } catch {}
  try { if (execSync("which docker 2>/dev/null || echo ''", { timeout: 2000 }).toString().trim()) caps.push("docker"); } catch {}
  return caps;
}

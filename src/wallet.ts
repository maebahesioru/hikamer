// ==========================================
// Aikata - 暗号資産ウォレット（OpenHuman wallet/ 由来）
// EVM互換チェーン対応・トランザクション管理
// ==========================================

import { logger } from "./utils/logger";
import * as crypto from "crypto";

// ==================== 型定義 ====================

export interface Wallet {
  address: string;
  chainId: number;
  balance: string;
  label: string;
  createdAt: number;
  lastUsed: number;
}

export interface Transaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  chainId: number;
  status: "pending" | "confirmed" | "failed";
  timestamp: number;
  gasUsed?: string;
  gasPrice?: string;
}

export interface TokenBalance {
  symbol: string;
  name: string;
  balance: string;
  decimals: number;
  contractAddress?: string;
}

export interface ChainConfig {
  id: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: string;
}

// ==================== チェーン設定 ====================

const SUPPORTED_CHAINS: Record<number, ChainConfig> = {
  1: { id: 1, name: "Ethereum Mainnet", rpcUrl: "https://eth.llamarpc.com", explorerUrl: "https://etherscan.io", nativeCurrency: "ETH" },
  137: { id: 137, name: "Polygon", rpcUrl: "https://polygon.llamarpc.com", explorerUrl: "https://polygonscan.com", nativeCurrency: "MATIC" },
  42161: { id: 42161, name: "Arbitrum", rpcUrl: "https://arbitrum.llamarpc.com", explorerUrl: "https://arbiscan.io", nativeCurrency: "ETH" },
  10: { id: 10, name: "Optimism", rpcUrl: "https://optimism.llamarpc.com", explorerUrl: "https://optimistic.etherscan.io", nativeCurrency: "ETH" },
  8453: { id: 8453, name: "Base", rpcUrl: "https://base.llamarpc.com", explorerUrl: "https://basescan.org", nativeCurrency: "ETH" },
};

// ==================== ウォレットマネージャー ====================

class WalletManager {
  private wallets: Map<string, Wallet> = new Map();
  private transactions: Transaction[] = [];
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("[Wallet] initialized");
  }

  /** アドレスを登録 */
  registerAddress(
    address: string,
    chainId?: number,
    label?: string
  ): Wallet {
    const key = `${chainId ?? 1}:${address}`;
    const wallet: Wallet = {
      address,
      chainId: chainId ?? 1,
      balance: "0",
      label: label ?? `Wallet ${this.wallets.size + 1}`,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
    this.wallets.set(key, wallet);
    return wallet;
  }

  /** 残高を取得 */
  async getBalance(address: string, chainId?: number): Promise<string | null> {
    const chain = SUPPORTED_CHAINS[chainId ?? 1];
    if (!chain) return null;

    try {
      const res = await fetch(chain.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getBalance",
          params: [address, "latest"],
          id: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) return null;
      const data = (await res.json()) as { result?: string };
      if (!data.result) return null;

      // Wei → ETH
      const balanceWei = BigInt(data.result);
      const balanceEth = Number(balanceWei) / 1e18;
      return balanceEth.toFixed(6);
    } catch {
      return null;
    }
  }

  /** トランザクション履歴を追加 */
  addTransaction(tx: Transaction): void {
    this.transactions.push(tx);
    if (this.transactions.length > 100) {
      this.transactions = this.transactions.slice(-100);
    }
  }

  /** トランザクション一覧 */
  getTransactions(limit = 20): Transaction[] {
    return this.transactions.slice(-limit).reverse();
  }

  /** アドレス一覧 */
  listAddresses(): Wallet[] {
    return Array.from(this.wallets.values());
  }

  /** 秘密鍵からアドレスを生成（EVM用・簡易版） */
  generateAddress(): { privateKey: string; address: string } {
    const privateKey = crypto.randomBytes(32).toString("hex");
    // 実際のアドレス生成はethers.jsが必要
    const address = `0x${crypto.createHash("sha256").update(privateKey).digest("hex").slice(0, 40)}`;
    return { privateKey: `0x${privateKey}`, address };
  }

  /** チェーン情報を取得 */
  getChainInfo(chainId: number): ChainConfig | undefined {
    return SUPPORTED_CHAINS[chainId];
  }

  /** 対応チェーン一覧 */
  listChains(): ChainConfig[] {
    return Object.values(SUPPORTED_CHAINS);
  }

  formatAddress(wallet: Wallet): string {
    const chain = SUPPORTED_CHAINS[wallet.chainId];
    return (
      `💰 **${wallet.label}**\n` +
      `アドレス: \`${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}\`\n` +
      `残高: ${wallet.balance} ${chain?.nativeCurrency ?? "ETH"}\n` +
      `チェーン: ${chain?.name ?? `Chain ${wallet.chainId}`}\n` +
      `作成: ${new Date(wallet.createdAt).toLocaleString("ja-JP")}`
    );
  }

  formatTx(tx: Transaction): string {
    const icon =
      tx.status === "confirmed"
        ? "✅"
        : tx.status === "pending"
          ? "⏳"
          : "❌";
    return (
      `${icon} **トランザクション**\n` +
      `Hash: \`${tx.hash.slice(0, 10)}...${tx.hash.slice(-6)}\`\n` +
      `From: ${tx.from.slice(0, 10)}... → To: ${tx.to.slice(0, 10)}...\n` +
      `Value: ${tx.value} ETH\n` +
      `Status: ${tx.status}${tx.gasUsed ? ` | Gas: ${tx.gasUsed}` : ""}` +
      `\n${new Date(tx.timestamp).toLocaleString("ja-JP")}`
    );
  }
}

// ==================== シングルトン ====================

export const walletManager = new WalletManager();

export default WalletManager;

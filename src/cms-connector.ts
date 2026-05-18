// ==========================================
// Aikata - CMS Connector（toprank seo/seo-analysis/scripts/ 由来）
// WordPress/Strapi/Contentful/Ghostのコンテンツ取得＋SSRF対策
// ==========================================

import { logger } from "./utils/logger";
import { safeFetch } from "./net-utils";

export type CmsType = "wordpress" | "strapi" | "contentful" | "ghost";

export interface CmsConfig {
  type: CmsType;
  baseUrl: string;
  apiKey?: string;
  username?: string;
  password?: string;
  pageSize?: number;
}

export interface CmsContent {
  id: string;
  title: string;
  url: string;
  content: string;
  excerpt: string;
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  publishedAt: string;
  updatedAt: string;
  status: string;
  author?: string;
  categories?: string[];
  tags?: string[];
}

export class CmsConnector {
  private config: CmsConfig;
  private sslCheckDomain = "169.254.169.254";

  constructor(config: CmsConfig) {
    this.config = config;
  }

  /** CMSから全コンテンツを取得 */
  async fetchAllContent(): Promise<CmsContent[]> {
    switch (this.config.type) {
      case "wordpress": return this.fetchWordPress();
      case "strapi": return this.fetchStrapi();
      case "contentful": return this.fetchContentful();
      case "ghost": return this.fetchGhost();
      default: throw new Error(`Unknown CMS type: ${this.config.type}`);
    }
  }

  /** SEO監査を実行 */
  async auditSeo(): Promise<Array<{ url: string; issues: string[]; score: number }>> {
    const contents = await this.fetchAllContent();
    return contents.map((c) => {
      const issues: string[] = [];
      let score = 100;

      if (!c.metaTitle) { issues.push("メタタイトルなし"); score -= 20; }
      else if (c.metaTitle.length > 60) { issues.push("メタタイトル超過"); score -= 10; }
      else if (c.metaTitle.length < 30) { issues.push("メタタイトル短い"); score -= 5; }

      if (!c.metaDescription) { issues.push("メタディスクリプションなし"); score -= 20; }
      else if (c.metaDescription.length > 160) { issues.push("メタディスクリプション超過"); score -= 10; }

      if (!c.ogImage) { issues.push("OG画像なし"); score -= 10; }
      if (!c.content || c.content.length < 300) { issues.push("コンテンツ不足"); score -= 15; }

      return { url: c.url, issues, score: Math.max(0, score) };
    });
  }

  // ==================== WordPress ====================

  private async fetchWordPress(): Promise<CmsContent[]> {
    const results: CmsContent[] = [];
    let page = 1;
    const pageSize = this.config.pageSize || 100;

    while (true) {
      try {
        const res = await safeFetch(
          `${this.config.baseUrl}/wp/v2/posts?per_page=${pageSize}&page=${page}&_embed=1`,
          {
            headers: this.config.password
              ? { Authorization: "Basic " + Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64") }
              : {},
            timeoutMs: 15000,
          },
        );

        if (!res.ok) break;
        const posts = JSON.parse(res.body);
        if (!Array.isArray(posts) || posts.length === 0) break;

        for (const post of posts) {
          const seo: Record<string, any> = post.yoast_head_json || post.rank_math?.head || {};
          results.push({
            id: String(post.id),
            title: post.title?.rendered || "",
            url: post.link || "",
            content: post.content?.rendered || "",
            excerpt: post.excerpt?.rendered || "",
            metaTitle: seo.title || "",
            metaDescription: seo.description || "",
            ogImage: seo.og_image?.[0]?.url || "",
            publishedAt: post.date || "",
            updatedAt: post.modified || "",
            status: post.status || "",
            author: post._embedded?.author?.[0]?.name || "",
            categories: (post._embedded?.["wp:term"]?.[0] || []).map((c: any) => c.name),
          });
        }

        page++;
      } catch { break; }
    }

    logger.info(`[CMS/WP] ${results.length}件取得 from ${this.config.baseUrl}`);
    return results;
  }

  // ==================== Strapi ====================

  private async fetchStrapi(): Promise<CmsContent[]> {
    const results: CmsContent[] = [];
    const pageSize = this.config.pageSize || 100;
    let start = 0;

    while (true) {
      try {
        const res = await safeFetch(
          `${this.config.baseUrl}/api/articles?pagination[start]=${start}&pagination[limit]=${pageSize}&populate=*`,
          { headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}, timeoutMs: 15000 },
        );

        if (!res.ok) break;
        const data = JSON.parse(res.body);
        const articles = data.data || [];
        if (!Array.isArray(articles) || articles.length === 0) break;

        for (const article of articles) {
          const attrs = article.attributes || article;
          const seo = attrs.seo || {};
          results.push({
            id: article.id?.toString() || "",
            title: attrs.title || "",
            url: attrs.slug ? `${this.config.baseUrl}/${attrs.slug}` : "",
            content: attrs.content || attrs.body || "",
            excerpt: attrs.excerpt || "",
            metaTitle: seo.metaTitle || seo.meta_title || "",
            metaDescription: seo.metaDescription || seo.meta_description || "",
            ogImage: seo.ogImage?.url || seo.shareImage?.url || "",
            publishedAt: attrs.publishedAt || attrs.createdAt || "",
            updatedAt: attrs.updatedAt || "",
            status: attrs.status || attrs.publishedAt ? "published" : "draft",
            categories: (attrs.categories?.data || []).map((c: any) => c.attributes?.name || c.name || ""),
          });
        }

        start += pageSize;
      } catch { break; }
    }

    logger.info(`[CMS/Strapi] ${results.length}件取得`);
    return results;
  }

  // ==================== Contentful ====================

  private async fetchContentful(): Promise<CmsContent[]> {
    const results: CmsContent[] = [];
    const pageSize = this.config.pageSize || 1000;
    let skip = 0;

    while (true) {
      try {
        const url = `${this.config.baseUrl}/entries?access_token=${this.config.apiKey}&content_type=page&limit=${pageSize}&skip=${skip}&include=1`;
        const res = await safeFetch(url, { timeoutMs: 30000 });

        if (!res.ok) break;
        const data = JSON.parse(res.body);
        const items = data.items || [];
        if (!Array.isArray(items) || items.length === 0) break;

        const assets = new Map((data.includes?.Asset || []).map((a: any) => [a.sys.id, a.fields?.file?.url || ""]));

        for (const item of items) {
          const fields = item.fields || {};
          const seoFields = fields.seo?.fields || {};
          results.push({
            id: item.sys?.id || "",
            title: fields.title || fields.pageTitle || "",
            url: fields.slug ? `${this.config.baseUrl}/${fields.slug}` : "",
            content: fields.body || fields.content || "",
            excerpt: fields.description || "",
            metaTitle: seoFields.title || fields.metaTitle || "",
            metaDescription: seoFields.description || fields.metaDescription || "",
            ogImage: assets.get(seoFields.ogImage?.sys?.id) || "",
            publishedAt: item.sys?.createdAt || "",
            updatedAt: item.sys?.updatedAt || "",
            status: item.sys?.publishedAt ? "published" : "draft",
          });
        }

        if (items.length < pageSize) break;
        skip += pageSize;
      } catch { break; }
    }

    logger.info(`[CMS/Contentful] ${results.length}件取得`);
    return results;
  }

  // ==================== Ghost ====================

  private async fetchGhost(): Promise<CmsContent[]> {
    const results: CmsContent[] = [];
    let page = 1;
    const pageSize = this.config.pageSize || 50;

    while (true) {
      try {
        const url = `${this.config.baseUrl}/ghost/api/content/posts/?key=${this.config.apiKey}&limit=${pageSize}&page=${page}&include=tags,authors`;
        const res = await safeFetch(url, {
          headers: { "Accept-Version": "v5.0" },
          timeoutMs: 15000,
        });

        if (!res.ok) break;
        const data = JSON.parse(res.body);
        const posts = data.posts || [];
        if (!Array.isArray(posts) || posts.length === 0) break;

        for (const post of posts) {
          results.push({
            id: post.id || "",
            title: post.title || "",
            url: post.url || "",
            content: post.html || "",
            excerpt: post.excerpt || post.custom_excerpt || "",
            metaTitle: post.meta_title || post.title || "",
            metaDescription: post.meta_description || post.excerpt || "",
            ogImage: post.og_image || post.feature_image || "",
            publishedAt: post.published_at || "",
            updatedAt: post.updated_at || "",
            status: post.status || "",
            author: post.authors?.[0]?.name || "",
            tags: (post.tags || []).map((t: any) => t.name),
          });
        }

        page++;
      } catch { break; }
    }

    logger.info(`[CMS/Ghost] ${results.length}件取得`);
    return results;
  }

  formatStatus(): string {
    return `🔌 **CMS Connector**: ${this.config.type} @ ${this.config.baseUrl}`;
  }
}

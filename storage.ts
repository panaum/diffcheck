import { db } from "./db";
import { comparisons, figmaFrames, webPages, type CreateComparisonInput, type Comparison, type InsertFigmaFrame, type FigmaFrame, type InsertWebPage, type WebPage } from "@shared/schema";
import { desc, eq } from "drizzle-orm";

export interface IStorage {
  createComparison(comparison: CreateComparisonInput): Promise<Comparison>;
  getHistory(): Promise<Comparison[]>;
  saveFrame(frame: InsertFigmaFrame): Promise<FigmaFrame>;
  getFramesByFileKey(fileKey: string): Promise<FigmaFrame[]>;
  deleteFramesByFileKey(fileKey: string): Promise<void>;
  saveWebPage(page: InsertWebPage): Promise<WebPage>;
  getWebPageByUrl(url: string): Promise<WebPage | null>;
  deleteWebPageByUrl(url: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async createComparison(input: CreateComparisonInput): Promise<Comparison> {
    const [comparison] = await db
      .insert(comparisons)
      .values(input)
      .returning();
    return comparison;
  }

  async getHistory(): Promise<Comparison[]> {
    return await db
      .select()
      .from(comparisons)
      .orderBy(desc(comparisons.createdAt));
  }

  async saveFrame(input: InsertFigmaFrame): Promise<FigmaFrame> {
    const [frame] = await db
      .insert(figmaFrames)
      .values(input)
      .returning();
    return frame;
  }

  async getFramesByFileKey(fileKey: string): Promise<FigmaFrame[]> {
    return await db
      .select()
      .from(figmaFrames)
      .where(eq(figmaFrames.fileKey, fileKey))
      .orderBy(figmaFrames.frameName);
  }

  async deleteFramesByFileKey(fileKey: string): Promise<void> {
    await db.delete(figmaFrames).where(eq(figmaFrames.fileKey, fileKey));
  }

  async saveWebPage(input: InsertWebPage): Promise<WebPage> {
    const [page] = await db
      .insert(webPages)
      .values(input)
      .returning();
    return page;
  }

  async getWebPageByUrl(url: string): Promise<WebPage | null> {
    const results = await db
      .select()
      .from(webPages)
      .where(eq(webPages.url, url))
      .orderBy(desc(webPages.createdAt))
      .limit(1);
    return results[0] || null;
  }

  async deleteWebPageByUrl(url: string): Promise<void> {
    await db.delete(webPages).where(eq(webPages.url, url));
  }
}

export const storage = new DatabaseStorage();

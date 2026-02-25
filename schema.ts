import { pgTable, text, serial, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Figma element types
export type FigmaElement = {
  type: "TEXT" | "BOX";
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontColor?: string;
  lineHeight?: number;
  width?: number;
  height?: number;
  borderRadius?: number;
};

// Store extracted Figma frames
export const figmaFrames = pgTable("figma_frames", {
  id: serial("id").primaryKey(),
  fileKey: text("file_key").notNull(),
  frameId: text("frame_id").notNull(),
  frameName: text("frame_name").notNull(),
  width: integer("width"),
  height: integer("height"),
  elements: jsonb("elements").$type<FigmaElement[]>().notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertFigmaFrameSchema = createInsertSchema(figmaFrames).omit({
  id: true,
  createdAt: true,
});

export type FigmaFrame = typeof figmaFrames.$inferSelect;
export type InsertFigmaFrame = {
  fileKey: string;
  frameId: string;
  frameName: string;
  width?: number | null;
  height?: number | null;
  elements: FigmaElement[];
};

// Web element types (matches FigmaElement for comparison)
export type WebElement = {
  type: "TEXT";
  text: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontColor?: string;
  lineHeight?: number;
  letterSpacing?: number;
  tag?: string;
  parentTag?: string;
  isInlineOverride?: boolean;
};

// Store scraped webpage data
export const webPages = pgTable("web_pages", {
  id: serial("id").primaryKey(),
  url: text("url").notNull(),
  elements: jsonb("elements").$type<WebElement[]>().notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type WebPage = typeof webPages.$inferSelect;
export type InsertWebPage = {
  url: string;
  elements: WebElement[];
};

export const comparisons = pgTable("comparisons", {
  id: serial("id").primaryKey(),
  imageUrl: text("image_url"), // Optional: if we store the uploaded image
  webUrl: text("web_url").notNull(),
  imageText: text("image_text").notNull(),
  webText: text("web_text").notNull(),
  diffResult: jsonb("diff_result").notNull(), // Store the structured diff
  imageFonts: jsonb("image_fonts").$type<string[]>(), // Fonts detected from image
  webFonts: jsonb("web_fonts").$type<string[]>(), // Fonts extracted from webpage
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertComparisonSchema = createInsertSchema(comparisons).omit({ 
  id: true, 
  createdAt: true,
});

export type Comparison = typeof comparisons.$inferSelect;
export type InsertComparison = z.infer<typeof insertComparisonSchema>;

// Type for creating comparisons (used by storage layer)
export type CreateComparisonInput = {
  webUrl: string;
  imageUrl?: string | null;
  imageText: string;
  webText: string;
  diffResult: unknown;
  imageFonts?: string[] | null;
  webFonts?: string[] | null;
};

// API Types
export type CompareRequest = {
  url: string;
  // File handled via multipart/form-data
};

export type DiffPart = {
  value: string;
  added?: boolean;
  removed?: boolean;
};

export type FontComparison = {
  imageFonts: string[];
  webFonts: string[];
  matching: string[];
  onlyInImage: string[];
  onlyInWeb: string[];
};

export type CompareResponse = Comparison & {
  formattedDiff: DiffPart[];
  fontComparison: FontComparison;
};

import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { createWorker, PSM, OEM } from "tesseract.js";
import { convert } from "html-to-text";
import * as Diff from "diff";
import puppeteer from "puppeteer";
import sharp from "sharp";

// Parse Figma URL to extract file key and node ID
function parseFigmaUrl(url: string): { fileKey: string; nodeId?: string } | null {
  try {
    const urlObj = new URL(url);
    
    // Support various Figma URL formats:
    // https://www.figma.com/design/FILE_KEY/...
    // https://www.figma.com/file/FILE_KEY/...
    // https://www.figma.com/proto/FILE_KEY/...
    const pathMatch = urlObj.pathname.match(/\/(design|file|proto)\/([^\/]+)/);
    if (!pathMatch) return null;
    
    const fileKey = pathMatch[2];
    const nodeId = urlObj.searchParams.get('node-id') || undefined;
    
    return { fileKey, nodeId };
  } catch {
    return null;
  }
}

// Fetch rendered image from Figma API
async function fetchFigmaImage(fileKey: string, nodeId: string | undefined, token: string): Promise<Buffer> {
  console.log('[FIGMA DEBUG] Fetching image for file:', fileKey, 'node:', nodeId);
  
  // If no node ID, get the first page/frame from the file
  let targetNodeId = nodeId;
  
  if (!targetNodeId) {
    // Get file structure to find the first frame
    const fileRes = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=2`, {
      headers: { 'X-Figma-Token': token }
    });
    
    if (!fileRes.ok) {
      const error = await fileRes.text();
      console.error('[FIGMA DEBUG] Failed to fetch file:', error);
      throw new Error(`Failed to fetch Figma file: ${fileRes.status} ${fileRes.statusText}`);
    }
    
    const fileData = await fileRes.json();
    
    // Find the first canvas (page) and get its first child (frame)
    const firstPage = fileData.document?.children?.[0];
    if (firstPage?.children?.[0]) {
      targetNodeId = firstPage.children[0].id;
      console.log('[FIGMA DEBUG] Using first frame:', targetNodeId);
    } else {
      throw new Error('No frames found in Figma file');
    }
  }
  
  // Request rendered image from Figma
  const imageUrl = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(targetNodeId as string)}&format=png&scale=2`;
  console.log('[FIGMA DEBUG] Requesting image from:', imageUrl);
  
  const imageRes = await fetch(imageUrl, {
    headers: { 'X-Figma-Token': token }
  });
  
  if (!imageRes.ok) {
    const error = await imageRes.text();
    console.error('[FIGMA DEBUG] Failed to fetch image:', error);
    throw new Error(`Failed to fetch Figma image: ${imageRes.status} ${imageRes.statusText}`);
  }
  
  const imageData = await imageRes.json();
  console.log('[FIGMA DEBUG] Image API response:', JSON.stringify(imageData));
  
  if (imageData.err) {
    throw new Error(`Figma API error: ${imageData.err}`);
  }
  
  // Get the image URL from the response
  const renderedUrl = Object.values(imageData.images)[0] as string;
  if (!renderedUrl) {
    throw new Error('No image URL returned from Figma API. The node might be invisible or have 0% opacity.');
  }
  
  console.log('[FIGMA DEBUG] Downloading rendered image from:', renderedUrl);
  
  // Download the actual image
  const downloadRes = await fetch(renderedUrl);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download Figma image: ${downloadRes.status}`);
  }
  
  const arrayBuffer = await downloadRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log('[FIGMA DEBUG] Downloaded image, size:', buffer.length);
  
  return buffer;
}

async function preprocessImageForOCR(imageBuffer: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(imageBuffer).metadata();
    const width = metadata.width || 1000;
    const height = metadata.height || 1000;
    
    const targetWidth = Math.max(width, 2000);
    const scaleFactor = targetWidth / width;
    const targetHeight = Math.round(height * scaleFactor);
    
    const processedBuffer = await sharp(imageBuffer)
      .resize(targetWidth, targetHeight, { 
        fit: 'inside',
        withoutEnlargement: false 
      })
      .grayscale()
      .normalize()
      .sharpen({ sigma: 1.5 })
      .modulate({ brightness: 1.1 })
      .png()
      .toBuffer();
    
    return processedBuffer;
  } catch (error) {
    console.error('Image preprocessing error:', error);
    return imageBuffer;
  }
}

async function extractWebFonts(url: string): Promise<string[]> {
  console.log('[FONT DEBUG] extractWebFonts called for URL:', url);
  
  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log('[FONT DEBUG] Browser launched successfully');
    
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[FONT DEBUG] Page loaded');
    
    const fonts = await page.evaluate(() => {
      const fontSet = new Set<string>();
      const elements = document.querySelectorAll('*');
      
      elements.forEach(el => {
        const computedStyle = window.getComputedStyle(el);
        const fontFamily = computedStyle.fontFamily;
        
        if (fontFamily) {
          // Parse font-family string and extract individual fonts
          const fonts = fontFamily.split(',').map(f => 
            f.trim().replace(/['"]/g, '').trim()
          );
          fonts.forEach(font => {
            if (font && !font.includes('inherit') && !font.includes('initial')) {
              fontSet.add(font);
            }
          });
        }
      });
      
      return Array.from(fontSet);
    });
    
    console.log('[FONT DEBUG] extractWebFonts result:', fonts);
    return fonts;
  } catch (error) {
    console.error('[FONT DEBUG] extractWebFonts error:', error);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function detectImageFonts(imageBuffer: Buffer): Promise<string[]> {
  console.log('[FONT DEBUG] detectImageFonts called, buffer size:', imageBuffer.length);
  const apiKey = process.env.WHATFONTIS_API_KEY;
  
  console.log('[FONT DEBUG] WhatFontIs API key configured:', apiKey ? 'Yes (length: ' + apiKey.length + ')' : 'No');
  
  if (!apiKey) {
    console.log('[FONT DEBUG] No WHATFONTIS_API_KEY configured, skipping image font detection');
    return [];
  }
  
  try {
    // Preprocess image for better font detection (similar to OCR preprocessing)
    console.log('[FONT DEBUG] Preprocessing image for font detection...');
    const metadata = await sharp(imageBuffer).metadata();
    console.log('[FONT DEBUG] Original image dimensions:', metadata.width, 'x', metadata.height);
    
    // Resize if too large (API may have size limits) but keep quality high
    let processedBuffer = imageBuffer;
    if (metadata.width && metadata.width > 2000) {
      processedBuffer = await sharp(imageBuffer)
        .resize({ width: 2000, withoutEnlargement: true })
        .sharpen({ sigma: 1.0 })
        .png()
        .toBuffer();
      console.log('[FONT DEBUG] Image resized to width 2000');
    } else {
      // Just enhance the image for better detection
      processedBuffer = await sharp(imageBuffer)
        .sharpen({ sigma: 1.0 })
        .png()
        .toBuffer();
      console.log('[FONT DEBUG] Image enhanced with sharpening');
    }
    
    const base64Image = processedBuffer.toString('base64');
    console.log('[FONT DEBUG] Image base64 length:', base64Image.length);
    
    console.log('[FONT DEBUG] Calling WhatFontIs API...');
    
    // Build URL-encoded form data (not JSON - as per official PHP example)
    const formData = new URLSearchParams();
    formData.append('API_KEY', apiKey);
    formData.append('IMAGEBASE64', '1');
    formData.append('NOTTEXTBOXSDETECTION', '0');
    formData.append('urlimage', '');
    formData.append('urlimagebase64', base64Image);
    formData.append('limit', '10');
    
    const response = await fetch('https://www.whatfontis.com/api2/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    
    console.log('[FONT DEBUG] WhatFontIs API response status:', response.status, response.statusText);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[FONT DEBUG] WhatFontIs API error:', response.statusText, errorText);
      return [];
    }
    
    const responseText = await response.text();
    console.log('[FONT DEBUG] WhatFontIs API raw response (first 2000 chars):', responseText.substring(0, 2000));
    
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      console.error('[FONT DEBUG] Failed to parse WhatFontIs response as JSON:', parseError);
      console.log('[FONT DEBUG] Raw response was:', responseText);
      return [];
    }
    
    console.log('[FONT DEBUG] WhatFontIs parsed data type:', typeof data, Array.isArray(data) ? 'isArray' : 'notArray');
    console.log('[FONT DEBUG] Parsed data length/keys:', Array.isArray(data) ? data.length : Object.keys(data));
    
    if (Array.isArray(data)) {
      if (data.length === 0) {
        console.log('[FONT DEBUG] WhatFontIs returned empty array - no fonts detected in image');
        return [];
      }
      
      // Log first item structure to understand the response format
      console.log('[FONT DEBUG] First item structure:', JSON.stringify(data[0], null, 2).substring(0, 500));
      
      // Extract unique font names from results
      const fontNames = data
        .map((item: any) => item.title || item.name || item.font)
        .filter((name: any): name is string => typeof name === 'string' && name.length > 0);
      console.log('[FONT DEBUG] Detected image fonts:', fontNames);
      return Array.from(new Set(fontNames));
    }
    
    // Check if response is an object with fonts inside
    if (data && typeof data === 'object') {
      console.log('[FONT DEBUG] Data keys:', Object.keys(data));
      if (data.fonts && Array.isArray(data.fonts)) {
        const fontNames = data.fonts
          .map((item: any) => item.title || item.name || item.font)
          .filter((name: any): name is string => typeof name === 'string' && name.length > 0);
        console.log('[FONT DEBUG] Detected image fonts from data.fonts:', fontNames);
        return Array.from(new Set(fontNames));
      }
    }
    
    return [];
  } catch (error) {
    console.error('[FONT DEBUG] Font detection error:', error);
    return [];
  }
}

function compareFonts(imageFonts: string[], webFonts: string[]): {
  matching: string[];
  onlyInImage: string[];
  onlyInWeb: string[];
} {
  const normalize = (font: string) => font.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  const normalizedImageFonts = imageFonts.map(f => ({ original: f, normalized: normalize(f) }));
  const normalizedWebFonts = webFonts.map(f => ({ original: f, normalized: normalize(f) }));
  
  const matching: string[] = [];
  const matchedWebIndices = new Set<number>();
  
  normalizedImageFonts.forEach(imgFont => {
    normalizedWebFonts.forEach((webFont, idx) => {
      if (imgFont.normalized === webFont.normalized || 
          imgFont.normalized.includes(webFont.normalized) ||
          webFont.normalized.includes(imgFont.normalized)) {
        if (!matchedWebIndices.has(idx)) {
          matching.push(webFont.original);
          matchedWebIndices.add(idx);
        }
      }
    });
  });
  
  const onlyInImage = imageFonts.filter(f => 
    !matching.some(m => normalize(m) === normalize(f) || 
                        normalize(m).includes(normalize(f)) ||
                        normalize(f).includes(normalize(m)))
  );
  
  const onlyInWeb = webFonts.filter((_, idx) => !matchedWebIndices.has(idx));
  
  return { matching, onlyInImage, onlyInWeb };
}

// Extract file key from Figma URL (simplified helper)
function extractFigmaFileKey(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Match /design/, /file/, or /proto/ followed by the file key
    const match = urlObj.pathname.match(/\/(design|file|proto)\/([^\/]+)/);
    return match ? match[2] : null;
  } catch {
    return null;
  }
}

// Fetch top-level frames from Figma file
interface FigmaFrameStructure {
  name: string;
  frameCount: number;
  firstFrame: any;
}

async function fetchFigmaFrameStructure(fileKey: string, token: string): Promise<FigmaFrameStructure> {
  // Use higher depth to get more structure details
  const response = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=3`, {
    headers: { 'X-Figma-Token': token }
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 403) {
      throw new Error('Invalid or expired Figma token. Please check your Personal Access Token.');
    }
    if (response.status === 404) {
      throw new Error('Figma file not found. Please check the file URL and your access permissions.');
    }
    throw new Error(`Figma API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  // Find all frames across pages
  const pages = data.document?.children || [];
  let allFrames: any[] = [];
  
  for (const page of pages) {
    if (page.type === 'CANVAS' && page.children) {
      for (const child of page.children) {
        if (child.type === 'FRAME') {
          allFrames.push(child);
        }
      }
    }
  }

  return {
    name: data.name || 'Untitled',
    frameCount: allFrames.length,
    firstFrame: allFrames[0] || null
  };
}

// Collect ALL frames from the Figma document tree
function collectAllFrames(node: any, frames: any[] = []): any[] {
  // Check if this node is a FRAME (top-level frames from pages)
  if (node.type === 'FRAME') {
    frames.push(node);
  }
  
  // Recursively search children (but don't go into frames, just find them)
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      // Only continue searching in CANVAS (pages) or DOCUMENT level
      if (node.type === 'DOCUMENT' || node.type === 'CANVAS') {
        collectAllFrames(child, frames);
      }
    }
  }
  
  return frames;
}

// Recursively find a FRAME by exact name in the Figma document tree
function findFrameByName(node: any, targetName: string): any | null {
  // Check if this node is a FRAME with matching name
  if (node.type === 'FRAME' && node.name === targetName) {
    return node;
  }
  
  // Recursively search children
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findFrameByName(child, targetName);
      if (found) return found;
    }
  }
  
  return null;
}

// Extract TEXT and RECTANGLE elements from a frame
function extractElements(node: any): any[] {
  const elements: any[] = [];
  
  if (!node.children) return elements;
  
  for (const child of node.children) {
    if (child.type === 'TEXT') {
      // Extract font color from fills array
      let fontColor = null;
      const fill = child.fills?.[0];
      if (fill?.type === 'SOLID' && fill.color) {
        const r = Math.round((fill.color.r || 0) * 255);
        const g = Math.round((fill.color.g || 0) * 255);
        const b = Math.round((fill.color.b || 0) * 255);
        const a = fill.color.a !== undefined ? fill.color.a : 1;
        fontColor = a < 1 
          ? `rgba(${r}, ${g}, ${b}, ${parseFloat(a.toFixed(2))})`
          : `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      }
      elements.push({
        type: 'TEXT',
        text: child.characters || '',
        fontFamily: child.style?.fontFamily || null,
        fontSize: child.style?.fontSize || null,
        fontWeight: child.style?.fontWeight || null,
        fontColor,
        lineHeight: child.style?.lineHeightPx || child.style?.lineHeightPercentFontSize || null
      });
    } else if (child.type === 'RECTANGLE') {
      // Extract RECTANGLE element data (as BOX in output)
      elements.push({
        type: 'BOX',
        width: child.absoluteBoundingBox?.width || 0,
        height: child.absoluteBoundingBox?.height || 0,
        borderRadius: child.cornerRadius || 0
      });
    }
    
    // Recursively extract from nested children
    if (child.children) {
      elements.push(...extractElements(child));
    }
  }
  
  return elements;
}

// Fetch a specific section from Figma by frame name
interface FigmaSectionResult {
  name: string;
  width: number;
  height: number;
  elements: any[];
}

async function fetchFigmaSection(fileKey: string, token: string, sectionName: string): Promise<FigmaSectionResult> {
  // Fetch the full file with deep nesting to find all frames
  const response = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=10`, {
    headers: { 'X-Figma-Token': token }
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 403) {
      throw new Error('Invalid or expired Figma token. Please check your Personal Access Token.');
    }
    if (response.status === 404) {
      throw new Error('Figma file not found. Please check the file URL and your access permissions.');
    }
    throw new Error(`Figma API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  // Find the frame by exact name match
  const frame = findFrameByName(data.document, sectionName);
  
  if (!frame) {
    throw new Error(`Frame "${sectionName}" not found in the Figma file. Please check the exact frame name.`);
  }
  
  // Extract elements from the frame
  const elements = extractElements(frame);
  
  return {
    name: frame.name,
    width: frame.absoluteBoundingBox?.width || 0,
    height: frame.absoluteBoundingBox?.height || 0,
    elements
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // POST /api/figma-section - Extract a specific section by frame name
  app.post('/api/figma-section', async (req, res) => {
    try {
      const { figmaUrl, token, sectionName } = req.body;

      // Validate inputs
      if (!figmaUrl) {
        return res.status(400).json({ message: 'No Figma URL provided' });
      }
      if (!token) {
        return res.status(400).json({ message: 'No Figma token provided' });
      }
      if (!sectionName) {
        return res.status(400).json({ message: 'No section name provided' });
      }

      // Extract file key from URL
      const fileKey = extractFigmaFileKey(figmaUrl);
      if (!fileKey) {
        return res.status(400).json({ message: 'Invalid Figma URL format. Expected format: https://www.figma.com/file/FILE_KEY/...' });
      }

      console.log('[FIGMA SECTION] Extracting section:', sectionName, 'from file:', fileKey);
      const sectionData = await fetchFigmaSection(fileKey, token, sectionName);
      console.log('[FIGMA SECTION] Found section with', sectionData.elements.length, 'elements');

      return res.json(sectionData);
    } catch (error: any) {
      console.error('[FIGMA SECTION] Error:', error.message);
      return res.status(500).json({ message: error.message || 'Failed to extract Figma section' });
    }
  });

  // POST /api/figma/extract-all - Extract ALL frames from Figma file and store in database
  app.post('/api/figma/extract-all', async (req, res) => {
    try {
      const { figmaUrl, token } = req.body;

      if (!figmaUrl) {
        return res.status(400).json({ message: 'No Figma URL provided' });
      }
      if (!token) {
        return res.status(400).json({ message: 'No Figma token provided' });
      }

      const fileKey = extractFigmaFileKey(figmaUrl);
      if (!fileKey) {
        return res.status(400).json({ message: 'Invalid Figma URL format. Expected format: https://www.figma.com/file/FILE_KEY/...' });
      }

      console.log('[FIGMA EXTRACT ALL] Fetching all frames from file:', fileKey);

      // Fetch the full file with deep nesting
      const response = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=10`, {
        headers: { 'X-Figma-Token': token }
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 403) {
          throw new Error('Invalid or expired Figma token. Please check your Personal Access Token.');
        }
        if (response.status === 404) {
          throw new Error('Figma file not found. Please check the file URL and your access permissions.');
        }
        throw new Error(`Figma API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      // Collect all top-level frames
      const allFrames = collectAllFrames(data.document);
      console.log('[FIGMA EXTRACT ALL] Found', allFrames.length, 'frames');

      // Delete existing frames for this file to avoid duplicates
      await storage.deleteFramesByFileKey(fileKey);

      // Save each frame to database
      const savedFrames = [];
      for (const frame of allFrames) {
        const elements = extractElements(frame);
        const savedFrame = await storage.saveFrame({
          fileKey,
          frameId: frame.id,
          frameName: frame.name,
          width: frame.absoluteBoundingBox?.width || null,
          height: frame.absoluteBoundingBox?.height || null,
          elements
        });
        savedFrames.push(savedFrame);
        console.log('[FIGMA EXTRACT ALL] Saved frame:', frame.name, 'with', elements.length, 'elements');
      }

      return res.json({
        fileKey,
        frameCount: savedFrames.length,
        frames: savedFrames
      });
    } catch (error: any) {
      console.error('[FIGMA EXTRACT ALL] Error:', error.message);
      return res.status(500).json({ message: error.message || 'Failed to extract Figma frames' });
    }
  });

  // GET /api/figma/stored-frames/:fileKey - Get stored frames for a file
  app.get('/api/figma/stored-frames/:fileKey', async (req, res) => {
    try {
      const { fileKey } = req.params;
      const frames = await storage.getFramesByFileKey(fileKey);
      return res.json({ fileKey, frames });
    } catch (error: any) {
      console.error('[FIGMA STORED] Error:', error.message);
      return res.status(500).json({ message: error.message || 'Failed to get stored frames' });
    }
  });

  // POST /api/figma/frames - Fetch top-level frames from a Figma file
  app.post('/api/figma/frames', async (req, res) => {
    try {
      const { figmaUrl, figmaToken } = req.body;

      if (!figmaUrl) {
        return res.status(400).json({ message: 'No Figma URL provided' });
      }
      if (!figmaToken) {
        return res.status(400).json({ message: 'No Figma token provided' });
      }

      const fileKey = extractFigmaFileKey(figmaUrl);
      if (!fileKey) {
        return res.status(400).json({ message: 'Invalid Figma URL format. Expected format: https://www.figma.com/file/FILE_KEY/...' });
      }

      console.log('[FIGMA FRAMES] Fetching frame structure for file:', fileKey);
      const structure = await fetchFigmaFrameStructure(fileKey, figmaToken);
      console.log('[FIGMA FRAMES] Found', structure.frameCount, 'frames');

      return res.json(structure);
    } catch (error: any) {
      console.error('[FIGMA FRAMES] Error:', error.message);
      return res.status(500).json({ message: error.message || 'Failed to fetch Figma frames' });
    }
  });

  app.post(api.compare.create.path, async (req, res) => {
    try {
      const { figmaUrl, figmaToken, liveUrl } = req.body;
      
      if (!figmaUrl) {
        return res.status(400).json({ message: "No Figma URL provided" });
      }
      if (!figmaToken) {
        return res.status(400).json({ message: "No Figma Personal Access Token provided" });
      }
      if (!liveUrl) {
        return res.status(400).json({ message: "No Live URL provided" });
      }

      // Parse Figma URL
      const figmaParsed = parseFigmaUrl(figmaUrl);
      if (!figmaParsed) {
        return res.status(400).json({ message: "Invalid Figma URL format. Please provide a valid Figma file URL." });
      }

      console.log('[FIGMA DEBUG] Parsed Figma URL:', figmaParsed);

      // Fetch image from Figma API
      const figmaImageBuffer = await fetchFigmaImage(figmaParsed.fileKey, figmaParsed.nodeId, figmaToken);

      // 1. Preprocess image and run OCR
      const processedImage = await preprocessImageForOCR(figmaImageBuffer);
      
      const worker = await createWorker('eng', OEM.LSTM_ONLY, {
        logger: () => {},
      });
      
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,!?\'"-:;()[]{}@#$%&*+=<>/\\ \n',
        preserve_interword_spaces: '1',
      });
      
      const ret = await worker.recognize(processedImage);
      const imageText = ret.data.text;
      await worker.terminate();

      // 2. Extract fonts from webpage using Puppeteer
      console.log('[FONT DEBUG] === Starting web font extraction for URL:', liveUrl);
      let webFonts: string[] = [];
      let webText = '';
      
      try {
        console.log('[FONT DEBUG] Launching Puppeteer browser...');
        const browser = await puppeteer.launch({ 
          headless: true,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        console.log('[FONT DEBUG] Browser launched successfully');
        
        const page = await browser.newPage();
        console.log('[FONT DEBUG] Navigating to URL...');
        await page.goto(liveUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('[FONT DEBUG] Page loaded, extracting fonts...');
        
        // Extract fonts from loaded stylesheets and computed styles
        webFonts = await page.evaluate(() => {
          const fontSet = new Set<string>();
          const debugInfo: string[] = [];
          
          // Method 1: Get fonts from computed styles
          const elements = document.querySelectorAll('body, body *');
          debugInfo.push(`Found ${elements.length} elements`);
          
          elements.forEach(el => {
            const computedStyle = window.getComputedStyle(el);
            const fontFamily = computedStyle.fontFamily;
            
            if (fontFamily) {
              const fonts = fontFamily.split(',').map(f => 
                f.trim().replace(/['"]/g, '').trim()
              );
              fonts.forEach(font => {
                if (font && font.length > 0 && 
                    !font.includes('inherit') && 
                    !font.includes('initial') &&
                    !font.includes('unset')) {
                  fontSet.add(font);
                }
              });
            }
          });
          
          debugInfo.push(`After computed styles: ${fontSet.size} fonts`);
          
          // Method 2: Get fonts from @font-face rules in stylesheets
          try {
            let sheetsProcessed = 0;
            for (const sheet of Array.from(document.styleSheets)) {
              try {
                const rules = sheet.cssRules || sheet.rules;
                if (rules) {
                  sheetsProcessed++;
                  for (const rule of Array.from(rules)) {
                    if (rule instanceof CSSFontFaceRule) {
                      const fontFamily = rule.style.getPropertyValue('font-family');
                      if (fontFamily) {
                        const cleanFont = fontFamily.replace(/['"]/g, '').trim();
                        if (cleanFont) fontSet.add(cleanFont);
                      }
                    }
                  }
                }
              } catch (e) {
                // Cross-origin stylesheets may throw
              }
            }
            debugInfo.push(`Processed ${sheetsProcessed} stylesheets`);
          } catch (e) {
            debugInfo.push(`Stylesheet error: ${e}`);
          }
          
          // Method 3: Try document.fonts API
          try {
            if ((document as any).fonts) {
              (document as any).fonts.forEach((font: any) => {
                if (font.family) {
                  const cleanFont = font.family.replace(/['"]/g, '').trim();
                  if (cleanFont) fontSet.add(cleanFont);
                }
              });
            }
          } catch (e) {
            debugInfo.push(`document.fonts error: ${e}`);
          }
          
          console.log('[Browser] Font extraction debug:', debugInfo.join('; '));
          console.log('[Browser] Extracted fonts:', Array.from(fontSet));
          
          return Array.from(fontSet);
        });
        
        console.log('[FONT DEBUG] Extracted web fonts count:', webFonts.length);
        console.log('[FONT DEBUG] Extracted web fonts:', webFonts);
        
        // Extract text content
        const html = await page.content();
        webText = convert(html, {
          wordwrap: false,
          selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' }
          ]
        });
        
        await browser.close();
        console.log('[FONT DEBUG] Browser closed, web font extraction complete');
      } catch (err) {
        console.error('[FONT DEBUG] Puppeteer error, falling back to fetch:', err);
        // Fallback to simple fetch
        const response = await fetch(liveUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch URL: ${response.statusText}`);
        }
        const html = await response.text();
        webText = convert(html, {
          wordwrap: false,
          selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' }
          ]
        });
      }

      // 3. Detect fonts from image (if API key available)
      console.log('[FONT DEBUG] === Starting image font detection...');
      const imageFonts = await detectImageFonts(figmaImageBuffer);
      console.log('[FONT DEBUG] Image fonts detected:', imageFonts.length, imageFonts);

      // 4. Compare text (case-insensitive to ignore styling differences)
      const normalizedImageText = imageText.toLowerCase();
      const normalizedWebText = webText.toLowerCase();
      const diffResult = Diff.diffWords(normalizedImageText, normalizedWebText);
      
      // 5. Compare fonts
      console.log('[FONT DEBUG] === Final font summary ===');
      console.log('[FONT DEBUG] Web fonts to save:', webFonts);
      console.log('[FONT DEBUG] Image fonts to save:', imageFonts);
      const fontComparison = compareFonts(imageFonts, webFonts);
      console.log('[FONT DEBUG] Font comparison result:', fontComparison);

      // 6. Save to DB
      console.log('[FONT DEBUG] Saving comparison to database...');
      const comparison = await storage.createComparison({
        webUrl: liveUrl,
        imageText: imageText,
        webText: webText,
        diffResult: diffResult,
        imageFonts: imageFonts,
        webFonts: webFonts,
      });
      console.log('[FONT DEBUG] Comparison saved with ID:', comparison.id);

      // 7. Respond
      res.json({
        ...comparison,
        formattedDiff: diffResult,
        fontComparison: {
          imageFonts,
          webFonts,
          ...fontComparison
        }
      });

    } catch (error) {
      console.error('Comparison error:', error);
      res.status(500).json({ message: "Failed to process comparison", error: String(error) });
    }
  });

  // Scrape webpage and extract structured JSON data (text, fonts, colors)
  app.post("/api/scrape-webpage", async (req, res) => {
    try {
      const { url } = req.body;
      
      if (!url) {
        return res.status(400).json({ message: "url is required" });
      }
      
      let browser;
      try {
        browser = await puppeteer.launch({ 
          headless: true,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const extractScript = `
          (() => {
            var results = [];
            var blockTags = ['H1','H2','H3','H4','H5','H6','P','LI','BUTTON','LABEL','TD','TH','CAPTION','FIGCAPTION','BLOCKQUOTE','CITE','DT','DD'];
            var inlineTags = ['STRONG','EM','I','B','SPAN','A','MARK','SMALL','SUB','SUP','U','S','CODE'];
            var processedEls = new Set();
            
            function parseColor(colorStr) {
              if (!colorStr) return null;
              var m = colorStr.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
              if (m) {
                var r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
                var a = m[4] ? parseFloat(m[4]) : 1;
                if (a < 1) return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
                return '#' + [r,g,b].map(function(x){return x.toString(16).padStart(2,'0')}).join('');
              }
              return colorStr;
            }
            
            function getProps(el) {
              var s = window.getComputedStyle(el);
              var fwStr = s.fontWeight;
              var fw = null;
              if (fwStr === 'bold') fw = 700;
              else if (fwStr === 'normal') fw = 400;
              else fw = parseInt(fwStr) || null;
              var lh = parseFloat(s.lineHeight);
              var ls = parseFloat(s.letterSpacing);
              return {
                fontFamily: s.fontFamily ? s.fontFamily.split(',')[0].trim().replace(/['"]/g,'') : null,
                fontSize: parseFloat(s.fontSize) || null,
                fontWeight: fw,
                fontColor: parseColor(s.color),
                lineHeight: isNaN(lh) ? null : lh,
                letterSpacing: isNaN(ls) ? null : ls
              };
            }
            
            function getFullText(el) {
              return (el.textContent || '').trim();
            }
            
            function getDirectText(el) {
              var text = '';
              for (var i = 0; i < el.childNodes.length; i++) {
                if (el.childNodes[i].nodeType === 3) {
                  text += el.childNodes[i].textContent;
                }
              }
              return text.trim();
            }
            
            function hasStyleOverride(parentProps, childProps) {
              if (parentProps.fontSize !== childProps.fontSize) return true;
              if (parentProps.fontWeight !== childProps.fontWeight) return true;
              if (parentProps.fontColor !== childProps.fontColor) return true;
              if (parentProps.fontFamily !== childProps.fontFamily) return true;
              return false;
            }
            
            function findDominantChildProps(el) {
              var fullText = getFullText(el);
              if (!fullText) return null;
              var directText = getDirectText(el);
              if (directText.length >= fullText.length * 0.5) return null;
              
              var inlineKids = el.querySelectorAll(inlineTags.join(','));
              if (inlineKids.length === 0) return null;
              
              var dominant = null;
              var dominantLen = 0;
              for (var i = 0; i < inlineKids.length; i++) {
                var kid = inlineKids[i];
                if (kid.parentElement !== el && !el.contains(kid)) continue;
                var kidText = getFullText(kid);
                if (kidText.length > dominantLen) {
                  dominantLen = kidText.length;
                  dominant = kid;
                }
              }
              
              if (dominant && dominantLen >= fullText.length * 0.8) {
                return getProps(dominant);
              }
              return null;
            }
            
            var blockEls = document.querySelectorAll(blockTags.join(','));
            
            blockEls.forEach(function(el) {
              if (processedEls.has(el)) return;
              var rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return;
              var s = window.getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
              
              var fullText = getFullText(el);
              if (!fullText || fullText.length === 0) return;
              
              processedEls.add(el);
              var ownProps = getProps(el);
              
              var effectiveProps = findDominantChildProps(el) || ownProps;
              
              results.push({
                type: 'TEXT',
                text: fullText,
                fontFamily: effectiveProps.fontFamily,
                fontSize: effectiveProps.fontSize,
                fontWeight: effectiveProps.fontWeight,
                fontColor: effectiveProps.fontColor,
                lineHeight: effectiveProps.lineHeight,
                letterSpacing: effectiveProps.letterSpacing,
                tag: el.tagName
              });
              
              var inlineChildren = el.querySelectorAll(inlineTags.join(','));
              inlineChildren.forEach(function(child) {
                if (processedEls.has(child)) return;
                var childText = getFullText(child);
                if (!childText || childText.length === 0) return;
                
                var childRect = child.getBoundingClientRect();
                if (childRect.width === 0 && childRect.height === 0) return;
                
                var childProps = getProps(child);
                if (hasStyleOverride(effectiveProps, childProps)) {
                  processedEls.add(child);
                  results.push({
                    type: 'TEXT',
                    text: childText,
                    fontFamily: childProps.fontFamily,
                    fontSize: childProps.fontSize,
                    fontWeight: childProps.fontWeight,
                    fontColor: childProps.fontColor,
                    lineHeight: childProps.lineHeight,
                    letterSpacing: childProps.letterSpacing,
                    tag: child.tagName,
                    parentTag: el.tagName,
                    isInlineOverride: true
                  });
                }
              });
            });
            
            var standaloneInline = document.querySelectorAll(inlineTags.join(','));
            standaloneInline.forEach(function(el) {
              if (processedEls.has(el)) return;
              var closestBlock = el.closest(blockTags.join(','));
              if (closestBlock && processedEls.has(closestBlock)) return;
              
              var rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return;
              var s = window.getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return;
              
              var text = getFullText(el);
              if (!text || text.length === 0) return;
              
              processedEls.add(el);
              var props = getProps(el);
              results.push({
                type: 'TEXT',
                text: text,
                fontFamily: props.fontFamily,
                fontSize: props.fontSize,
                fontWeight: props.fontWeight,
                fontColor: props.fontColor,
                lineHeight: props.lineHeight,
                letterSpacing: props.letterSpacing,
                tag: el.tagName
              });
            });
            
            return results;
          })()
        `;
        
        const elements = await page.evaluate(extractScript) as any[];
        
        await browser.close();
        
        // Delete existing data for this URL and save new
        await storage.deleteWebPageByUrl(url);
        const savedPage = await storage.saveWebPage({ url, elements: elements as any });
        
        res.json({
          id: savedPage.id,
          url: savedPage.url,
          elementCount: elements.length,
          elements
        });
        
      } catch (err) {
        if (browser) await browser.close();
        throw err;
      }
      
    } catch (error) {
      console.error('Webpage scrape error:', error);
      res.status(500).json({ message: "Failed to scrape webpage", error: String(error) });
    }
  });

  // Content-only comparison: Figma stored frames vs live webpage text
  app.post("/api/compare-content", async (req, res) => {
    try {
      const { fileKey, liveUrl } = req.body;
      
      if (!fileKey || !liveUrl) {
        return res.status(400).json({ message: "fileKey and liveUrl are required" });
      }
      
      // 1. Get stored frames from database
      const storedFrames = await storage.getFramesByFileKey(fileKey);
      if (storedFrames.length === 0) {
        return res.status(404).json({ message: "No stored frames found for this file. Please extract frames first." });
      }
      
      // 2. Extract text content from stored Figma frames
      const figmaTextParts: string[] = [];
      for (const frame of storedFrames) {
        figmaTextParts.push(`[${frame.frameName}]`);
        const elements = frame.elements as any[];
        for (const el of elements) {
          if (el.type === "TEXT" && el.text) {
            figmaTextParts.push(el.text);
          }
        }
      }
      const figmaText = figmaTextParts.join('\n').trim();
      
      // 3. Scrape text from live webpage
      let webText = '';
      let browser;
      try {
        browser = await puppeteer.launch({ 
          headless: true,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        const page = await browser.newPage();
        await page.goto(liveUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const html = await page.content();
        webText = convert(html, {
          wordwrap: false,
          selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' }
          ]
        });
        
        await browser.close();
      } catch (err) {
        if (browser) await browser.close();
        // Fallback to simple fetch
        const response = await fetch(liveUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch URL: ${response.statusText}`);
        }
        const html = await response.text();
        webText = convert(html, {
          wordwrap: false,
          selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' }
          ]
        });
      }
      
      // 4. Normalize and compare text content
      const normalizedFigma = figmaText.toLowerCase().replace(/\s+/g, ' ').trim();
      const normalizedWeb = webText.toLowerCase().replace(/\s+/g, ' ').trim();
      const diffResult = Diff.diffWords(normalizedFigma, normalizedWeb);
      
      // 5. Calculate stats
      let added = 0, removed = 0, unchanged = 0;
      diffResult.forEach((part: any) => {
        if (part.added) added += part.value.length;
        else if (part.removed) removed += part.value.length;
        else unchanged += part.value.length;
      });
      
      res.json({
        figmaText,
        webText,
        diffResult,
        stats: {
          added,
          removed,
          unchanged,
          similarity: unchanged / (added + removed + unchanged) * 100
        },
        frameCount: storedFrames.length,
        frames: storedFrames.map(f => f.frameName)
      });
      
    } catch (error) {
      console.error('Content comparison error:', error);
      res.status(500).json({ message: "Failed to compare content", error: String(error) });
    }
  });

  app.get(api.compare.list.path, async (req, res) => {
    try {
      const history = await storage.getHistory();
      
      // Add fontComparison and formattedDiff to each history item
      const enrichedHistory = history.map((item) => {
        const imageFonts = item.imageFonts || [];
        const webFonts = item.webFonts || [];
        const fontComparison = compareFonts(imageFonts, webFonts);
        
        return {
          ...item,
          formattedDiff: item.diffResult,
          fontComparison: {
            imageFonts,
            webFonts,
            ...fontComparison
          }
        };
      });
      
      res.json(enrichedHistory);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch history" });
    }
  });

  return httpServer;
}

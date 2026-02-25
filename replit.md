# Overview

This is a Figma-to-web comparison tool that allows users to compare Figma designs with live webpages. Users provide a Figma File URL, a Personal Access Token, and a Live Website URL. The system:
1. Extracts text elements and font properties from Figma via API (fontSize, fontFamily, fontWeight, fontColor, lineHeight, letterSpacing)
2. Scrapes text and computed styles from the live webpage using Puppeteer (1440x900 desktop viewport), using dominant-child style detection to get accurate visual styles even when block elements delegate styling to inner spans
3. Stores both datasets independently so neither overwrites the other
4. Compares matched text elements property-by-property and highlights only mismatches
5. Displays comparison results with filter-by-property, color-coded error cards, and summary stats

The tool identifies discrepancies in text properties (font size, weight, family, color, line height, letter spacing, text content) between design and implementation.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React with TypeScript, using Vite as the build tool
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack React Query for server state and data fetching
- **Styling**: Tailwind CSS with shadcn/ui component library (New York style)
- **Animations**: Framer Motion for layout animations and transitions
- **Component Pattern**: Functional components with hooks, organized in `/client/src/components`

## Backend Architecture
- **Framework**: Express.js with TypeScript
- **File Uploads**: Multer with memory storage for handling multipart form data
- **API Structure**: RESTful endpoints defined in `/shared/routes.ts` with Zod schemas for validation
- **Development**: Hot module replacement via Vite middleware in development mode

## Data Storage
- **Database**: PostgreSQL with Drizzle ORM
- **Schema Location**: `/shared/schema.ts` - single source of truth for database schema
- **Migrations**: Drizzle Kit for schema migrations (`drizzle-kit push`)
- **Storage Pattern**: Repository pattern implemented in `/server/storage.ts`

## Key Design Decisions

### Monorepo Structure
The project uses a shared directory pattern:
- `/client` - React frontend application
- `/server` - Express backend
- `/shared` - Common code (schemas, route definitions, types)

This allows TypeScript types to be shared between frontend and backend, ensuring type safety across the stack.

### API Contract Pattern
Routes are defined in `/shared/routes.ts` with typed path definitions and response schemas. Both frontend and backend import from this file, ensuring API contract consistency.

### Build System
- Development: Vite serves the frontend with HMR, Express runs via tsx
- Production: Frontend built with Vite, backend bundled with esbuild into a single file

# External Dependencies

## Database
- **PostgreSQL**: Primary database, connection via `DATABASE_URL` environment variable
- **Drizzle ORM**: Type-safe database queries and schema management

## OCR Processing
- **Tesseract.js**: JavaScript OCR engine for extracting text from uploaded images
- **Sharp**: Image preprocessing library for improved OCR accuracy
  - Preprocessing pipeline: resize to 2000px+ width, grayscale, normalize, sharpen (sigma 1.5), brightness boost
  - Tesseract config: LSTM-only engine, AUTO page segmentation, character whitelist for common text characters

## Figma API Integration
- **Figma REST API**: Used to fetch rendered design images
  - Parses Figma URLs to extract file key and node ID
  - Supports /design/, /file/, and /proto/ URL formats
  - Calls GET /v1/images/{fileKey} endpoint with X-Figma-Token header
  - Downloads rendered PNG at 2x scale for high-quality OCR

## Web Scraping
- **Puppeteer**: Headless browser for extracting text and fonts from live webpages
- **html-to-text**: Converts HTML to plain text for comparison
- **Native fetch**: Fallback for retrieving web page content

## Text Comparison
- **diff**: Library for computing text differences between OCR output and scraped content

## UI Components
- **shadcn/ui**: Pre-built accessible components based on Radix UI primitives
- **Radix UI**: Headless UI primitives for accessible components
- **Lucide React**: Icon library
- **Framer Motion**: Animation library

## Session/Authentication
- **connect-pg-simple**: PostgreSQL session store (available but not currently used)
- **express-session**: Session middleware infrastructure
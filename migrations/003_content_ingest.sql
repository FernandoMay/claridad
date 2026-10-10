-- Migración v1.0: añadir tabla content_ingest para el pipeline de contenido real.
-- Ejecutar: npx wrangler d1 execute claridad-db --remote --file=./migrations/003_content_ingest.sql

CREATE TABLE IF NOT EXISTS content_ingest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  source_slug TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_category TEXT NOT NULL CHECK (source_category IN ('agencia', 'fact-check', 'primaria', 'contextual')),
  source_rigor INTEGER NOT NULL DEFAULT 90 CHECK (source_rigor BETWEEN 0 AND 100),
  title TEXT NOT NULL,
  summary TEXT,
  link TEXT,
  published_at TEXT,
  raw TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'procesado', 'descartado')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_ingest_source ON content_ingest(source_slug);
CREATE INDEX IF NOT EXISTS idx_content_ingest_status ON content_ingest(status, created_at);

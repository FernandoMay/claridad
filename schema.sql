-- Claridad — esquema de D1 (SQLite)
-- Aplicar con: npm run db:migrate:local  (idempotente; las tablas usan IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('agencia', 'fact-check', 'primaria', 'contextual')),
  description TEXT,
  -- active: 1 activa, 0 pausada (persistido vía PATCH /api/sources/:slug)
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  rigor INTEGER NOT NULL DEFAULT 90 CHECK (rigor BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo', 'atencion', 'novedad', 'fondo', 'anonc')),
  edition TEXT NOT NULL CHECK (edition IN ('matutina', 'cierre')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  dedup_count INTEGER NOT NULL DEFAULT 0 CHECK (dedup_count >= 0),
  sources_count INTEGER NOT NULL DEFAULT 0 CHECK (sources_count >= 0),
  deadline TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Puntos clave verificables de un tema (hechos, discrepancias, acciones)
-- NOTA (limitación declarada, no funcionalidad): verification es texto libre
-- curado a mano en el seed demo; el POC no comprueba primarias reales.
CREATE TABLE IF NOT EXISTS topic_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cambio', 'evidencia', 'accion', 'discrepancia', 'hecho')),
  label TEXT NOT NULL,
  detail TEXT,
  verification TEXT,
  confidence TEXT CHECK (confidence IN ('alta', 'media', 'disputa'))
);

-- Trazabilidad: cada tema cita fuentes concretas
CREATE TABLE IF NOT EXISTS topic_sources (
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  reference TEXT,
  note TEXT,
  PRIMARY KEY (topic_id, source_id)
);

-- Reglas en lenguaje natural (hipótesis E: configuración mínima)
-- Heurístico y no verificado: la respuesta del POST incluye "heuristic": true.
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text TEXT NOT NULL CHECK (length(raw_text) <= 500),
  action TEXT NOT NULL CHECK (action IN ('silenciar', 'enfatizar', 'reprogramar')),
  target TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Registro de sesiones de lectura (métrica: tiempo hasta comprensión equivalente)
CREATE TABLE IF NOT EXISTS reading_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('comprendido', 'guardado', 'terminado')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Modo de foco (hipótesis C: saber cuándo revisar)
CREATE TABLE IF NOT EXISTS focus_settings (
  id INTEGER PRIMARY KEY,
  quiet_start TEXT NOT NULL DEFAULT '20:00' CHECK (quiet_start GLOB '[0-2][0-9]:[0-5][0-9]'),
  quiet_end TEXT NOT NULL DEFAULT '07:00'   CHECK (quiet_end   GLOB '[0-2][0-9]:[0-5][0-9]'),
  urgencia TEXT NOT NULL DEFAULT 'severa' CHECK (urgencia IN ('todas', 'moderada', 'severa')),
  pausa_reflexiva INTEGER NOT NULL DEFAULT 1 CHECK (pausa_reflexiva IN (0, 1)),
  modo_sin_opinion INTEGER NOT NULL DEFAULT 1 CHECK (modo_sin_opinion IN (0, 1))
);

-- ---------- Experimento A/B (landing de demanda, Semana 3) ----------

-- Eventos del embudo: variant_assigned / visit / cta_clicked / form_started / reserve_completed
CREATE TABLE IF NOT EXISTS experiment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('A', 'B')),
  event TEXT NOT NULL CHECK (event IN ('variant_assigned', 'visit', 'cta_clicked', 'form_started', 'reserve_completed', 'variant_assignment_error')),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_experiment_events_visitor ON experiment_events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_experiment_events_variant_event ON experiment_events(variant, event);

-- Reservas de plaza: dato personal mínimo (email + consent), dedupe por email único.
CREATE TABLE IF NOT EXISTS experiment_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  variant TEXT NOT NULL CHECK (variant IN ('A', 'B')),
  visitor_id TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reservations_variant ON experiment_reservations(variant);

-- Rate limit best-effort (POC); en producción real: Cloudflare KV/DO.
CREATE TABLE IF NOT EXISTS rate_limit (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit(window_start);

-- ---------- Pipeline de contenido real (v1.0) ----------
-- Inbox de ingesta: recibe contenido estructurado desde fuera del Worker
-- (CI/curator/scraper) y lo persiste para que el Worker lo procese de forma
-- controlada: deducción por título+fuente, enriquecimiento básico, y asociación
-- a fuentes existentes o creación de fuentes nuevas.
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

-- Modo de foco por defecto (fila única)
INSERT OR IGNORE INTO focus_settings (id) VALUES (1);

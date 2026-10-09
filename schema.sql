-- Claridad — esquema inicial de D1 (SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,            -- 'agencia' | 'fact-check' | 'primaria' | 'contextual'
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1, -- 1 activa, 0 pausada
  rigor INTEGER NOT NULL DEFAULT 90, -- % de rigor declarado por la fuente
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'nuevo', -- 'atencion' | 'novedad' | 'fondo' | 'anonc'
  edition TEXT NOT NULL,                -- 'matutina' | 'cierre'
  priority INTEGER NOT NULL DEFAULT 50, -- 0-100, mayor = más prioritario
  dedup_count INTEGER NOT NULL DEFAULT 0,  -- artículos redundantes condensados
  sources_count INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,                          -- fecha límite accionable (opcional)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Puntos clave verificables de un tema (hechos, discrepancias, acciones)
CREATE TABLE IF NOT EXISTS topic_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- 'cambio' | 'evidencia' | 'accion' | 'discrepancia' | 'hecho'
  label TEXT NOT NULL,
  detail TEXT,
  verification TEXT,           -- "Validado por: Doc. ONU (A/78/L.22), AFP Factual"
  confidence TEXT              -- 'alta' | 'media' | 'disputa'
);

-- Trazabilidad: cada tema cita fuentes concretas
CREATE TABLE IF NOT EXISTS topic_sources (
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  reference TEXT,              -- nº de cable / doc (ej. "F1")
  note TEXT,
  PRIMARY KEY (topic_id, source_id)
);

-- Reglas en lenguaje natural (hipótesis E: configuración mínima)
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text TEXT NOT NULL,       -- "Silencia temas electorales hasta el viernes"
  action TEXT NOT NULL,         -- 'silenciar' | 'enfatizar' | 'reprogramar'
  target TEXT,                  -- tema / dominio objetivo
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Registro de sesiones de lectura (métrica: tiempo hasta comprensión equivalente)
CREATE TABLE IF NOT EXISTS reading_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  action TEXT NOT NULL,         -- 'comprendido' | 'guardado' | 'terminado'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Modo de foco (hipótesis C: saber cuándo revisar)
CREATE TABLE IF NOT EXISTS focus_settings (
  id INTEGER PRIMARY KEY,
  quiet_start TEXT NOT NULL DEFAULT '20:00',
  quiet_end TEXT NOT NULL DEFAULT '07:00',
  urgencia TEXT NOT NULL DEFAULT 'severa',      -- 'todas' | 'moderada' | 'severa'
  pausa_reflexiva INTEGER NOT NULL DEFAULT 1,   -- espera 5s antes de enlaces externos
  modo_sin_opinion INTEGER NOT NULL DEFAULT 1   -- solo hechos corroborados
);

INSERT OR IGNORE INTO focus_settings (id) VALUES (1);

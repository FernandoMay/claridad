-- Migración v1.0: añadir 'nuevo' al enum de topics.status (temas recién ingestados
-- antes de ser curados). SQLite no soporta ALTER TABLE ... ADD CHECK, así que se
-- recrea la tabla copiando los datos.
-- Ejecutar: npx wrangler d1 execute claridad-db --remote --file=./migrations/004_topics_status_enum.sql

CREATE TABLE topics_new (
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
INSERT INTO topics_new (id, slug, title, summary, status, edition, priority, dedup_count, sources_count, deadline, created_at)
  SELECT id, slug, title, summary, status, edition, priority, dedup_count, sources_count, deadline, created_at FROM topics;
DROP TABLE topics;
ALTER TABLE topics_new RENAME TO topics;

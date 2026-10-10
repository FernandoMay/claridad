-- Migración P0: añadir variant_assignment_error al enum de experiment_events.
-- SQLite no soporta ALTER TABLE ... ADD CHECK ni DROP CONSTRAINT, así que se
-- recrea la tabla copiando los datos. Es seguro porque experiment_events es
-- la tabla central del experimento A/B y no tiene FK salientes.
--
-- Ejecutar: npx wrangler d1 execute claridad-db --remote --file=./migrations/002_experiment_events_enum.sql
-- Nota: D1 no acepta BEGIN TRANSACTION en el API de archivo; la migración
-- es atómica por lote de sentencias.

CREATE TABLE experiment_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('A', 'B')),
  event TEXT NOT NULL CHECK (event IN ('variant_assigned', 'visit', 'cta_clicked', 'form_started', 'reserve_completed', 'variant_assignment_error')),
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO experiment_events_new (id, visitor_id, variant, event, metadata, created_at)
  SELECT id, visitor_id, variant, event, metadata, created_at FROM experiment_events;
DROP TABLE experiment_events;
ALTER TABLE experiment_events_new RENAME TO experiment_events;
CREATE INDEX IF NOT EXISTS idx_experiment_events_visitor ON experiment_events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_experiment_events_variant_event ON experiment_events(variant, event);

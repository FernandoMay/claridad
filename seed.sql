-- Datos de demo para la POC (los mismos de los diseños, consultados por API).
-- ⚠️ FICTICIOS: no verifican fuentes primarias reales; el UI los etiqueta como demo.
INSERT OR IGNORE INTO sources (slug, name, category, description, active, rigor) VALUES
  ('reuters', 'Reuters', 'agencia', 'Agencia internacional · 2 novedades hoy', 1, 98),
  ('chequeado', 'Chequeado', 'fact-check', 'Verificación de datos · 1 análisis reciente', 1, 95),
  ('boe', 'Boletines Oficiales', 'primaria', 'Textos legales y decretos vinculantes', 1, 100),
  ('lemonde-elpais', 'Le Monde / El País', 'contextual', 'Periodismo de fondo y crónicas extensas', 0, 88),
  ('afp-factual', 'AFP Factual', 'fact-check', 'Desmentidos y auditoría de titulares', 1, 94),
  ('fad', 'Financial Times', 'contextual', 'Análisis económico y regulatorio', 0, 92);

INSERT OR IGNORE INTO topics (slug, title, summary, status, edition, priority, dedup_count, sources_count, deadline) VALUES
  ('privacidad-digital', 'Nueva normativa de privacidad digital y protección de datos cívicos',
   'El marco unifica los criterios de consentimiento biométrico para servicios públicos y bancarios en el territorio nacional.',
   'atencion', 'matutina', 95, 5, 3, '2026-11-01'),
  ('gobernanza-ia', 'Acuerdo global sobre gobernanza de IA generativa y derechos de autor',
   '14 declaraciones internacionales fueron unificadas bajo un marco común de atribución; desacuerdo UE-Japón en plazos.',
   'novedad', 'matutina', 70, 9, 14, NULL),
  ('banco-central-tasas', 'Ajuste de tasas y proyecciones económicas del banco central',
   'Pausa unánime en el ciclo de subidas; actas cautelares ante costos de energía, inflación subyacente converge hacia 2.2%.',
   'novedad', 'matutina', 60, 6, 5, NULL),
  ('sesgo-algoritmico', '¿Cómo opera el sesgo algorítmico en las recomendaciones de vídeo?',
   'Desglose sereno de las funciones de recompensa que priorizan la retención emocional frente a la relevancia temática.',
   'fondo', 'matutina', 40, 0, 2, NULL);

-- Datos de la ficha principal: hechos y verificación (texto demo curado a mano,
-- NO verificados contra primarias reales; la UI los presenta como demo).
INSERT OR IGNORE INTO topic_facts (topic_id, kind, label, detail, verification, confidence) VALUES
  (1, 'cambio', 'Qué cambió',
   'Se prohíbe la retención de tokens biométricos sin consentimiento activo renovable cada 180 días.', NULL, 'alta'),
  (1, 'evidencia', 'Evidencia disponible',
   'Resolución BOE-2024-1849 y dictamen vinculante de la Agencia de Protección de Datos.', 'Validado por BOE y AEPD (referencia demo, no comprobada)', 'alta'),
  (1, 'accion', 'Acción recomendada',
   'Verificar la casilla de firma delegada en la app de identidad digital antes del 31 de octubre.', 'Entra en vigor: 1 de nov', 'alta');

-- Trazabilidad del tema principal
INSERT OR IGNORE INTO topic_sources (topic_id, source_id, reference, note) VALUES
  (1, 3, 'F1', 'Resolución publicada en el Diario Oficial'),
  (1, 2, 'F2', 'Desmentido de variaciones sobre el borrador de 2021'),
  (1, 1, 'F3', 'Cable de la rueda de prensa oficial');

INSERT OR IGNORE INTO topic_facts (topic_id, kind, label, detail, verification, confidence) VALUES
  (2, 'hecho', 'Hechos confirmados', '14 declaraciones internacionales fueron unificadas bajo un marco común de atribución.', NULL, 'alta'),
  (2, 'discrepancia', 'Delimitación', 'El texto final excluye temporalmente el litigio de patentes para acelerar el consenso.', NULL, 'media'),
  (2, 'discrepancia', 'Discrepancia activa', 'Desacuerdo entre la UE y Japón en los plazos de ejecución técnica (2025 vs 2026).', 'Divergencia de interpretación', 'disputa');

INSERT OR IGNORE INTO topic_sources (topic_id, source_id, reference, note) VALUES
  (2, 1, 'F1', NULL),
  (2, 6, 'F4', 'Entrevista con directores regulatorios'),
  (2, 4, 'F5', 'Corresponsalía en Bruselas');

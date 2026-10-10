# Centralisation of the A/B attribution and admin-metrics defects

## Defectes P0 en producción

### 1. `POST /api/experiment/visit` puede cambiar la variante de un visitante existente

Sí que combina la lógica actual con el dispositivo que se usa, pero no se garantiza que un visitante no pueda cambiar de variante al recargar la landing o al volver a enviar `/api/experiment/visit` con un `variant` forzado en params.

**Riesgo:** si un visitante descubre cómo forzar `?variant=B`, puede contaminar el experimento.php

**Criterio de cierre:** el Worker debe rechazar todo intento de cambio de variante por parte del cliente y registrar un evento de `variant_assignment_error` con la causa.

### 2. `GET /api/experiment/metrics` puede quedar expuesto

El endpoint actual valida un `X-Experiment-Admin` y, si lo falta, podría devolver las métricas públicamente.

**Riesgo:** quien puede hacer una petición puede leer el embudo sin tener privilegios.

**Criterio de cierre:** el Worker debe exigir un token válido para cualquier petición administativa y denegar silenciosamente si falta o no coincide.

### Plan de cierre

1. Aplicar código corregido en `worker.js`:
   - `POST /api/experiment/visit` debe ser idempotent, mantener la variante asignada al visitante y rechazar cualquier intento de forzar la variante con `variant= invalido`.
   - `GET /api/experiment/metrics` debe rechazar si falta `X-Experiment-Admin` o no coincide, con una respuesta de error sin exponer detalles.
2. Agregar un evento de auditoría por cada cambio de variante no permitido.
3. Ejecutar pruebas automatizada y, una vez pasen, hacer commit y push.

### Estado de cierre (P0)

- [x] `POST /api/experiment/visit` rechaza `?variant=A` y `?variant=B` con 403 + evento `variant_assignment_error` en D1 (auditoría).
- [x] `GET /api/experiment/metrics` falla cerrado: 403 cuando no hay `EXPERIMENT_ADMIN_TOKEN` configurado, o cuando `X-Experiment-Admin` falta/no coincide.
- [x] 18 pruebas automatizadas pasan (incluye 2 nuevas P0).
- [x] E2E en producción verificado: visit 200, force → 403, event 201, reserve 201 + dedupe 200, metrics sin token → 403, metrics con token → 200 sin PII.

### Qué NO cambiar

- No publicar secrets en el repositorio ni alterar el despliegue sin validarlo.
- No descartar el experimento A/B hasta que se verifique que la atribución es estable y que los datos de D1 son coherentes con los eventos recibidos.

---

## Pipeline de contenido real (v1.0)

### Qué se añadió

- **Tabla `content_ingest`** (schema.sql + migración `migrations/003_content_ingest.sql`): inbox de ingesta con `external_id` único, fuente, título, summary, link, estado (`pendiente`/`procesado`/`descartado`).
- **Migración `migrations/004_topics_status_enum.sql`**: añade `'nuevo'` al CHECK de `topics.status` (temas recién ingestados antes de curado).
- **Rutas en `worker.js`**:
  - `POST /api/content/ingest` — recibe `{ items: [...] }` (máx 200), valida, asegura fuente existe (la crea si no está), deduplica por `external_id`, persiste. Protegido por `PIPELINE_TOKEN` (header `X-Pipeline-Token`) cuando está configurado.
  - `GET /api/content/pending` — lista items pendientes para revisión. Protegido por `PIPELINE_TOKEN`.
  - `POST /api/content/process/:id` — procesa item pendiente: deduplica por título+fuente, crea tema (slug único), añade `topic_sources` + `topic_facts` (el summary se convierte en hecho con confianza por categoría), marca como procesado. Protegido por `PIPELINE_TOKEN`.
  - Helpers: `slugify()`, `ingestItem()`, `processIngestItem()`, `confidenceForCategory()`.
- **Scraper `scripts/ingest-boe.mjs`**: fuera del Worker, zero deps nuevos. Parsea RSS 2.0 de BOE (ISO-8859-1), inyecta en pipeline con `external_id = boe:<link>`, fuente `boe` (primaria, rigor 100). Configurable con `CLARIDAD_PIPELINE_TOKEN`.
- **Tests (4 nuevos, total 18/18)**: ingesta inválida/válida, procesado crea tema+facts+sources, duplicado por external_id, creación automática de fuente, protección por PIPELINE_TOKEN.

### Verificación E2E en producción

- [x] Scraper inyecta 5 items del BOE → 5 inyectados, 0 errores.
- [x] Proceso → tema visible en `/api/topics` y `/api/topics/:slug` con fuente + hecho.
- [x] Duplicado → detectado (idempotente).
- [x] Protección por PIPELINE_TOKEN: sin token → 403; con token → 200.

### Limitaciones declaradas

- El pipeline recibe contenido **desde fuera del Worker** (CI/curator/scraper). El Worker no hace fetching ni parsing de RSS/Atom y no tiene dependencias externas.
- BOE feed → tema "Sumario del día" procesado automáticamente (limitación del scraper: toma todos los items del feed).
- Verificación de primaria real: NO implementada; la UI debe etiquetar como demo hasta curado humano.

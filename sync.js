// ============================================================
// sync.js — Sync eventi da Base44 → Supabase
// ============================================================
// Esegui in locale:
//   BASE44_APP_ID=... BASE44_API_KEY=... \
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node sync.js
//
// Esegui in TEST MODE (solo 5 eventi):
//   ... SYNC_LIMIT=5 node sync.js
// ============================================================

const B44_APP_ID = process.env.BASE44_APP_ID;
const B44_API_KEY = process.env.BASE44_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SYNC_LIMIT = process.env.SYNC_LIMIT ? parseInt(process.env.SYNC_LIMIT, 10) : null;

if (!B44_APP_ID || !B44_API_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('✗ Missing env vars: BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const t0 = Date.now();

// ─── Helpers ──────────────────────────────────────────────────

function zurichOffset(dateStr) {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const tz = probe.toLocaleString('en-US', { timeZone: 'Europe/Zurich', timeZoneName: 'short' });
  return (tz.includes('CEST') || tz.includes('GMT+2')) ? '+02:00' : '+01:00';
}

function toIso(dateStr, timeStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const t = (timeStr && /^\d{1,2}:\d{2}/.test(timeStr))
    ? timeStr.padStart(5, '0')
    : '00:00';
  return `${dateStr.slice(0, 10)}T${t}:00${zurichOffset(dateStr)}`;
}

const clean = (v) => (v === '' || v === undefined ? null : v);

const num = (v) => {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const bool = (v) => (typeof v === 'boolean' ? v : null);

function mapEvent(b44) {
  return {
    base44_id: b44.id,
    // ─── colonne legacy mantenute popolate ───
    title: clean(b44.nome),
    date: clean(b44.data_inizio?.slice?.(0, 10)),
    location: clean(b44.luogo),
    venue: clean(b44.venue),
    orario: clean(b44.orario_inizio_evento),
    // ─── colonne nuove ───
    descrizione: clean(b44.descrizione),
    categoria: clean(b44.categoria),
    dimensione_evento: clean(b44.dimensione_evento),
    data_inizio_iso: toIso(b44.data_inizio, b44.orario_inizio_evento),
    data_fine_iso: toIso(b44.data_fine, b44.orario_inizio_evento),
    orario_apertura_porte: clean(b44.orario_apertura_porte),
    paese: clean(b44.paese),
    indirizzo_venue: clean(b44.indirizzo_venue),
    geo_lat: num(b44.geo_lat),
    geo_lng: num(b44.geo_lng),
    stato_evento: clean(b44.stato_evento),
    attivo: bool(b44.attivo),
    is_media_partner: bool(b44.is_media_partner) ?? false,
    in_evidenza: bool(b44.in_evidenza) ?? false,
    is_sold_out: bool(b44.is_sold_out) ?? false,
    is_ingresso_libero: bool(b44.is_ingresso_libero) ?? false,
    is_ultimi_biglietti: bool(b44.is_ultimi_biglietti) ?? false,
    ticket_url_esterno1: clean(b44.ticket_url_esterno1),
    ticket_url_esterno2: clean(b44.ticket_url_esterno2),
    ticket_info_altro: clean(b44.ticket_info_altro),
    data_inizio_vendita_biglietti: clean(b44.data_inizio_vendita_biglietti),
    poster_url: clean(b44.poster_url),
    immagine_url: clean(b44.immagine_url),
    immagine_header_upload: clean(b44.immagine_header_upload),
    rating_medio: num(b44.rating_medio),
    numero_voti: num(b44.numero_voti) ?? 0,
    contatore_preferiti: num(b44.contatore_preferiti) ?? 0,
    seo_title: clean(b44.seo_title),
    seo_description: clean(b44.seo_description),
    seo_keywords: Array.isArray(b44.seo_keywords) ? b44.seo_keywords : null,
    sponsor_ids: Array.isArray(b44.sponsor_ids) ? b44.sponsor_ids : null,
    accetta_candidature: bool(b44.accetta_candidature) ?? false,
    accetta_sponsor: bool(b44.accetta_sponsor) ?? false,
    synced_at: new Date().toISOString(),
    deleted_at: null,
  };
}

// ─── Base44 ───────────────────────────────────────────────────

async function fetchBase44() {
  console.log('→ Fetching events from Base44...');
  const url = `https://base44.app/api/apps/${B44_APP_ID}/entities/Evento`;
  const r = await fetch(url, { headers: { api_key: B44_API_KEY } });
  if (!r.ok) throw new Error(`Base44 ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const events = await r.json();
  if (!Array.isArray(events)) throw new Error(`Base44 returned non-array: ${typeof events}`);
  console.log(`  ✓ Fetched ${events.length} events`);
  return events;
}

// ─── Supabase ─────────────────────────────────────────────────

const supaHeaders = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchSupabaseSyncedIds() {
  console.log('→ Fetching existing synced events from Supabase...');
  const r = await fetch(
    `${SUPA_URL}/rest/v1/events?select=base44_id&deleted_at=is.null&base44_id=not.is.null`,
    { headers: supaHeaders }
  );
  if (!r.ok) throw new Error(`Supabase fetch ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  console.log(`  ✓ Found ${rows.length} active synced events`);
  return new Set(rows.map((r) => r.base44_id).filter(Boolean));
}

async function upsertChunk(chunk) {
  const r = await fetch(`${SUPA_URL}/rest/v1/events?on_conflict=base44_id`, {
    method: 'POST',
    headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(chunk),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Upsert ${r.status}: ${body.slice(0, 800)}`);
  }
}

async function softDeleteRemoved(removedIds) {
  if (removedIds.length === 0) {
    console.log('→ No events to soft-delete');
    return;
  }
  console.log(`→ Soft-deleting ${removedIds.length} events removed from Base44...`);
  const list = removedIds.map((id) => `"${id}"`).join(',');
  const url = `${SUPA_URL}/rest/v1/events?base44_id=in.(${encodeURIComponent(list)})`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...supaHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`Soft-delete ${r.status}: ${(await r.text()).slice(0, 500)}`);
  console.log(`  ✓ Soft-deleted ${removedIds.length}`);
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  let b44Events = await fetchBase44();
  if (SYNC_LIMIT) {
    console.log(`  ⚠ TEST MODE: limiting to first ${SYNC_LIMIT} events`);
    b44Events = b44Events.slice(0, SYNC_LIMIT);
  }

  const supaSyncedIds = await fetchSupabaseSyncedIds();

  console.log(`→ Upserting ${b44Events.length} events into Supabase...`);
  const mapped = b44Events.map(mapEvent);
  const CHUNK = 100;
  for (let i = 0; i < mapped.length; i += CHUNK) {
    const chunk = mapped.slice(i, i + CHUNK);
    await upsertChunk(chunk);
    console.log(`  ✓ Upserted ${Math.min(i + CHUNK, mapped.length)}/${mapped.length}`);
  }

  if (!SYNC_LIMIT) {
    const b44Ids = new Set(b44Events.map((e) => e.id));
    const removed = [...supaSyncedIds].filter((id) => !b44Ids.has(id));
    await softDeleteRemoved(removed);
  } else {
    console.log('→ Skipping soft-delete in TEST MODE');
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✓ Sync complete in ${dur}s — ${b44Events.length} events processed`);
}

main().catch((e) => {
  console.error('✗ Sync failed:', e.message);
  process.exit(1);
});

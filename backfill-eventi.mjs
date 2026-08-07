// ============================================================
// backfill-eventi.mjs — Backfill storico degli eventi Tuttoitalia
// ============================================================
// Inserisce su Base44 (entità Evento, source of truth) gli eventi
// storici dell'archivio news.tuttoitalia.ch/eventi/ che non sono
// ancora in calendario, li marca come "Passato" se la data è nel
// passato, e li rispecchia subito su Supabase.
//
// A differenza di monitor-eventi.mjs, QUI le date passate sono ammesse
// (è un archivio). Legge i payload già pronti da ./eventi-backfill.json.
//
// Env: BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Flag: DRY_RUN=1 -> non scrive nulla; LIMIT=n -> processa solo i primi n
// ============================================================
import fs from 'node:fs';
import { fetchT, withRetry } from './fonti.mjs';

const B44_APP_ID = process.env.BASE44_APP_ID;
const B44_API_KEY = process.env.BASE44_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = ['1', 'true'].includes(String(process.env.DRY_RUN));
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;

if (!B44_APP_ID || !B44_API_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('✗ Missing env: BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// ─── Helper (allineati a monitor-eventi.mjs) ──────────────────
const norm = (s) => (s || '').toString().toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (v) => (v === '' || v === undefined ? null : v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && v !== '' && v !== null ? n : null; };
const bool = (v) => (typeof v === 'boolean' ? v : null);
function zurichOffset(dateStr) {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const tz = probe.toLocaleString('en-US', { timeZone: 'Europe/Zurich', timeZoneName: 'short' });
  return (tz.includes('CEST') || tz.includes('GMT+2')) ? '+02:00' : '+01:00';
}
function toIso(dateStr, timeStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const t = (timeStr && /^\d{1,2}:\d{2}/.test(timeStr)) ? timeStr.padStart(5, '0') : '00:00';
  return `${dateStr.slice(0, 10)}T${t}:00${zurichOffset(dateStr)}`;
}

// mapEvent: copiata verbatim da monitor-eventi.mjs / sync.js (mirror Supabase).
function mapEvent(b44) {
  return {
    base44_id: b44.id,
    title: clean(b44.nome), date: clean(b44.data_inizio?.slice?.(0, 10)),
    location: clean(b44.luogo), venue: clean(b44.venue), orario: clean(b44.orario_inizio_evento),
    descrizione: clean(b44.descrizione), categoria: clean(b44.categoria),
    dimensione_evento: clean(b44.dimensione_evento),
    data_inizio_iso: toIso(b44.data_inizio, b44.orario_inizio_evento),
    data_fine_iso: toIso(b44.data_fine, b44.orario_inizio_evento),
    orario_apertura_porte: clean(b44.orario_apertura_porte),
    paese: clean(b44.paese), indirizzo_venue: clean(b44.indirizzo_venue),
    geo_lat: num(b44.geo_lat), geo_lng: num(b44.geo_lng),
    stato_evento: clean(b44.stato_evento), attivo: bool(b44.attivo),
    is_media_partner: bool(b44.is_media_partner) ?? false,
    in_evidenza: bool(b44.in_evidenza) ?? false,
    is_sold_out: bool(b44.is_sold_out) ?? false,
    is_ingresso_libero: bool(b44.is_ingresso_libero) ?? false,
    is_ultimi_biglietti: bool(b44.is_ultimi_biglietti) ?? false,
    ticket_url_esterno1: clean(b44.ticket_url_esterno1),
    ticket_url_esterno2: clean(b44.ticket_url_esterno2),
    ticket_info_altro: clean(b44.ticket_info_altro),
    data_inizio_vendita_biglietti: clean(b44.data_inizio_vendita_biglietti),
    poster_url: clean(b44.poster_url), immagine_url: clean(b44.immagine_url),
    immagine_header_upload: clean(b44.immagine_header_upload),
    rating_medio: num(b44.rating_medio), numero_voti: num(b44.numero_voti) ?? 0,
    contatore_preferiti: num(b44.contatore_preferiti) ?? 0,
    seo_title: clean(b44.seo_title), seo_description: clean(b44.seo_description),
    seo_keywords: Array.isArray(b44.seo_keywords) ? b44.seo_keywords : null,
    sponsor_ids: Array.isArray(b44.sponsor_ids) ? b44.sponsor_ids : null,
    accetta_candidature: bool(b44.accetta_candidature) ?? false,
    accetta_sponsor: bool(b44.accetta_sponsor) ?? false,
    synced_at: new Date().toISOString(), deleted_at: null,
  };
}

const B44_URL = `https://base44.app/api/apps/${B44_APP_ID}/entities/Evento`;
async function base44Eventi() {
  return withRetry(async () => {
    const r = await fetchT(B44_URL, { headers: { api_key: B44_API_KEY } });
    if (!r.ok) throw new Error(`${r.status}`);
    const arr = await r.json();
    return Array.isArray(arr) ? arr : [];
  }, 'Base44 list');
}
async function base44Create(payload) {
  const r = await fetchT(B44_URL, {
    method: 'POST',
    headers: { api_key: B44_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Base44 create ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };
async function supaUpsert(b44obj) {
  return withRetry(async () => {
    const r = await fetchT(`${SUPA_URL}/rest/v1/events?on_conflict=base44_id`, {
      method: 'POST',
      headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([mapEvent(b44obj)]),
    });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  }, 'Supabase upsert');
}

const chiave = (nome, dataIso) => `${norm(nome)}|${(dataIso || '').slice(0, 10)}`;

async function main() {
  const oggi = new Date().toISOString().slice(0, 10);
  const FILE = process.env.BACKFILL_FILE || './eventi-backfill.json';
  const items = JSON.parse(fs.readFileSync(new URL(FILE, import.meta.url), 'utf8'));
  console.log(`▶ Backfill eventi ${DRY_RUN ? '(DRY RUN) ' : ''}— ${items.length} eventi in archivio — ${new Date().toISOString()}`);

  // Dedup contro Base44 SOLO per nome+data esatta.
  // NB: a differenza del monitoraggio, qui NON si usa il dedup nome+anno:
  // in un archivio storico lo stesso artista suona legittimamente più volte
  // nello stesso anno (es. Pippo Pollina 9 date nel 2011, tournée Branduardi).
  // Il dedup nome+anno collasserebbe queste date in una sola.
  const esistenti = await base44Eventi();
  const chiaviEsist = new Set();
  for (const e of esistenti) {
    const d = (e.data_inizio || '').slice(0, 10);
    if (e.nome && d) chiaviEsist.add(chiave(e.nome, d));
  }
  console.log(`  già su Base44: ${esistenti.length}`);

  let creati = 0, saltati = 0, errori = 0, mirrorFail = 0;
  let n = 0;
  for (const ev of items) {
    if (n >= LIMIT) break;
    if (!ev.nome || !ev.data_inizio) { saltati++; continue; }
    const k = chiave(ev.nome, ev.data_inizio);
    if (chiaviEsist.has(k)) { saltati++; continue; }
    n++;

    const passato = ev.data_inizio.slice(0, 10) < oggi;
    // stato: Annullato ha la precedenza (evento cancellato), altrimenti Passato/Confermato dalla data
    const stato = ev.stato_override || (passato ? 'Passato' : 'Confermato');
    const payload = {
      nome: ev.nome,
      data_inizio: ev.data_inizio,
      orario_inizio_evento: ev.orario_inizio_evento || null,
      luogo: ev.luogo || null,
      venue: ev.venue || null,
      paese: ev.paese || 'Svizzera',
      poster_url: ev.poster_url || null,
      immagine_url: ev.immagine_url || ev.poster_url || null,
      descrizione: ev.descrizione || null,
      categoria: ev.categoria || 'Concerto',
      stato_evento: stato,
      attivo: true,
      is_media_partner: true,   // l'archivio è "i concerti che abbiamo promosso": badge Media Partner storicamente corretto
      in_evidenza: false,       // ma mai in evidenza in home (sono passati)
      is_sold_out: !!ev.is_sold_out,
      seo_title: ev.seo_title || ev.nome,
      seo_description: ev.seo_description || [ev.nome, ev.venue, ev.luogo, ev.data_inizio.slice(0, 10)].filter(Boolean).join(' · '),
    };

    if (DRY_RUN) {
      console.log(`  ＋ [DRY] ${ev.data_inizio.slice(0, 10)} | ${(ev.nome || '').slice(0, 26).padEnd(26)} | ${(ev.luogo || '-').padEnd(12)} | ${stato.padEnd(10)} | img:${ev.poster_url ? 'sì' : 'no'}`);
      creati++;
      continue;
    }
    try {
      const risposta = await base44Create(payload);
      const raw = risposta && typeof risposta === 'object' ? risposta : {};
      const body = raw.data && typeof raw.data === 'object' ? raw.data : raw;
      const b44obj = { ...body, ...payload, id: body.id };
      if (!b44obj.id) throw new Error('Base44 non ha restituito un id');
      // aggiorna l'indice di dedup (nome+data) per evitare doppioni nello stesso giro
      chiaviEsist.add(k);
      creati++;
      try { await supaUpsert(b44obj); } catch (e) { mirrorFail++; console.error(`    mirror KO: ${e.message}`); }
      if (creati % 25 === 0) console.log(`  … creati ${creati}`);
    } catch (e) {
      errori++;
      console.error(`  ✗ ${ev.data_inizio?.slice(0, 10)} ${ev.nome}: ${e.message}`);
    }
  }
  console.log(`✓ Fatto — creati:${creati} · saltati(già presenti/incompleti):${saltati} · errori:${errori} · mirror KO:${mirrorFail}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

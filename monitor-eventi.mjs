// ============================================================
// monitor-eventi.mjs — Monitoraggio nuovi eventi dalle agenzie
// ============================================================
// Controlla i siti in SITES, trova gli eventi NON ancora presenti
// sul calendario Tuttoitalia, li crea su Base44 (entità Evento) e
// li rispecchia subito su Supabase (tabella events) riusando la
// stessa mappatura di sync.js — così compaiono in entrambi i
// pannelli (concorsi.tuttoitalia.ch e my.tuttoitalia.ch/admin/eventi).
//
// Nessuna nuova credenziale: usa gli stessi secret di sync.js.
//
// Env: BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Flag: DRY_RUN=1  -> non scrive nulla, stampa solo cosa creerebbe
//
// Test locale (nessuna scrittura):
//   DRY_RUN=1 BASE44_APP_ID=... BASE44_API_KEY=... SUPABASE_URL=... \
//   SUPABASE_SERVICE_ROLE_KEY=... node monitor-eventi.mjs
// ============================================================

const B44_APP_ID = process.env.BASE44_APP_ID;
const B44_API_KEY = process.env.BASE44_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!B44_APP_ID || !B44_API_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('✗ Missing env: BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// ─── Siti da monitorare (ESTENDIBILE: aggiungi qui un oggetto) ──
const SITES = [
  {
    id: 'dema-agency',
    nome: 'Dema Agency',
    listUrl: 'https://www.dema-agency.ch/events/',
    paese: 'Svizzera',
  },
];

// ─── mapEvent & C. — copiati VERBATIM da sync.js (mirror Supabase) ──
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
    title: clean(b44.nome),
    date: clean(b44.data_inizio?.slice?.(0, 10)),
    location: clean(b44.luogo),
    venue: clean(b44.venue),
    orario: clean(b44.orario_inizio_evento),
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

// ─── Helper HTML / rete ───────────────────────────────────────
const stripTags = (h) =>
  h.replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;|&rsquo;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ').trim();
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, ' ')
  .replace(/[^\w\sàèéìòùç']/gi, '').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// fetch con timeout (Node fetch non ne ha di default)
async function fetchT(url, opts = {}, ms = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Riprova le richieste di rete: un singolo "fetch failed" transitorio non deve
// far saltare il giro (successo verificato dopo un fallimento in produzione).
async function withRetry(fn, what, tentativi = 3) {
  let ultimo;
  for (let i = 1; i <= tentativi; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      if (i < tentativi) {
        const attesa = i * 3000;
        console.warn(`  ↻ ${what}: tentativo ${i}/${tentativi} fallito (${e.message}), riprovo tra ${attesa / 1000}s`);
        await sleep(attesa);
      }
    }
  }
  throw ultimo;
}

async function getHtml(url) {
  return withRetry(async () => {
    const r = await fetchT(url, { headers: { 'User-Agent': 'TuttoitaliaEventBot/1.0 (+https://tuttoitalia.ch)' } });
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
    return await r.text();
  }, `GET ${url}`);
}

// Meta dalla riga finale della card: "Locarno 16.12.2026" | "Lugano 20.03.27" | "Europe Tour"
function parseCardMeta(cardText) {
  const tail = cardText.split(/INFO\s*&\s*TICKETS/i).pop().trim().slice(0, 60); // limita: evita footer/JS
  const dm = tail.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  let dataIso = null, luogo = null;
  if (dm) {
    const yy = dm[3].length === 2 ? `20${dm[3]}` : dm[3];
    dataIso = `${yy}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    luogo = tail.slice(0, dm.index).trim() || null;
  }
  return { dataIso, luogo };
}

// Pagina lista -> [{ detailUrl, dataIso, luogo, img }]  (chiave univoca = detailUrl)
// Le locandine lg_copertina sono lazy-load: prendo gli ID /public/eventi/{ID}/ in
// ordine di card e li accoppio per indice agli URL-dettaglio (verificato: allineati).
function parseList(html, siteHost) {
  const urls = [];
  for (const m of html.matchAll(/href="(https?:\/\/[^"]*\/eventi\/[^"]+\/)"/gi)) {
    const u = m[1].split('#')[0];
    try { if (siteHost && new URL(u).host !== siteHost) continue; } catch { continue; }
    if (!urls.includes(u)) urls.push(u);
  }
  const ids = [];
  for (const m of html.matchAll(/\/public\/eventi\/(\d+)[\/_]/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  const pair = urls.length === ids.length; // accoppia per indice solo se allineati
  const metaByUrl = {};
  for (const chunk of html.split(/class="card\b/).slice(1)) {
    const hrefM = chunk.match(/href="(https?:\/\/[^"]*\/eventi\/[^"]+\/)"/i);
    if (!hrefM) continue;
    const u = hrefM[1].split('#')[0];
    if (!(u in metaByUrl)) metaByUrl[u] = parseCardMeta(stripTags(chunk));
  }
  return urls.map((detailUrl, i) => {
    const id = pair ? ids[i] : null;
    const meta = metaByUrl[detailUrl] || {};
    return {
      detailUrl,
      dataIso: meta.dataIso || null,
      luogo: meta.luogo || null,
      img: id ? `https://www.dema-agency.ch/public/eventi/${id}/lg_copertina_${id}.jpg` : null,
    };
  });
}

// Pagina dettaglio -> { nome, venue, ticket, img }
function parseDetail(html, cardCity, fallbackImg) {
  const text = stripTags(html);
  const ogTitle = (html.match(/property="og:title"\s+content="([^"]+)"/i) || [])[1];
  const nome = ogTitle ? ogTitle.replace(/\s+/g, ' ').trim() : null;

  // Venue: ancorata alla città nota, fino a "TICKETS", sanificata
  let venue = null;
  if (cardCity) {
    const m = text.match(new RegExp(escRe(cardCity) + '\\s+(.{3,80}?)\\s+TICKETS', 'i'));
    if (m) {
      const v = m[1].trim();
      if (v && !/copyright|©|privacy|\b\d{4}\b/i.test(v)) venue = v;
    }
  }

  // Biglietti: SOLO domini di ticketing whitelisted. Nessun fallback:
  // meglio nessun link che un link arbitrario pubblicato in automatico.
  const ticket = (html.match(/href="(https?:\/\/(?:www\.)?(?:biglietteria\.ch|ticketmaster\.[a-z.]+|ticketcorner\.ch|eventim\.[a-z.]+|starticket\.ch|vivaticket\.[a-z.]+|petzi\.ch|ticketino\.com)[^"]*)"/i) || [])[1] || null;

  // Immagine: preferisci quella della card; fallback = ID trovato sul dettaglio
  const idM = html.match(/\/public\/eventi\/(\d+)[\/_]/);
  const img = fallbackImg
    || (idM ? `https://www.dema-agency.ch/public/eventi/${idM[1]}/lg_copertina_${idM[1]}.jpg` : null);

  return { nome, venue, ticket, img };
}

// ─── Base44 ───────────────────────────────────────────────────
const B44_URL = `https://base44.app/api/apps/${B44_APP_ID}/entities/Evento`;

async function base44Nomi() {
  return withRetry(async () => {
    const r = await fetchT(B44_URL, { headers: { api_key: B44_API_KEY } });
    if (!r.ok) throw new Error(`Base44 list ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const arr = await r.json();
    return new Set((Array.isArray(arr) ? arr : []).map((e) => norm(e.nome)));
  }, 'Base44 list');
}

// NIENTE retry qui: la POST non è idempotente e un secondo tentativo dopo un
// timeout ambiguo creerebbe un evento doppio sul calendario pubblico.
async function base44Create(payload) {
  const r = await fetchT(B44_URL, {
    method: 'POST',
    headers: { api_key: B44_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Base44 create ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

// ─── Supabase (mirror immediato, come sync.js) ────────────────
const supaHeaders = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json',
};
// Retry sicuro: l'upsert su base44_id è idempotente per costruzione.
async function supaUpsert(b44obj) {
  return withRetry(async () => {
    const r = await fetchT(`${SUPA_URL}/rest/v1/events?on_conflict=base44_id`, {
      method: 'POST',
      headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([mapEvent(b44obj)]),
    });
    if (!r.ok) throw new Error(`Supabase upsert ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }, 'Supabase upsert');
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const oggi = new Date().toISOString().slice(0, 10);
  console.log(`▶ Monitoraggio eventi ${DRY_RUN ? '(DRY RUN)' : ''} — ${new Date().toISOString()}`);
  const esistenti = await base44Nomi();
  console.log(`  Base44: ${esistenti.size} eventi già presenti (dedup per nome)`);

  let nuovi = 0, giaPresenti = 0, senzaData = 0, scartati = 0, errori = 0;

  for (const site of SITES) {
    console.log(`\n— ${site.nome} (${site.listUrl})`);
    const host = new URL(site.listUrl).host;
    let cards;
    try {
      cards = parseList(await getHtml(site.listUrl), host);
    } catch (e) {
      console.error(`  ✗ lista non raggiungibile: ${e.message}`);
      errori++;
      continue;
    }
    console.log(`  ${cards.length} eventi in vetrina`);

    for (const card of cards) {
      try {
        const det = parseDetail(await getHtml(card.detailUrl), card.luogo, card.img);
        const nome = det.nome;
        const dataIso = card.dataIso;   // data dalla card (GG.MM.AAAA), affidabile
        const luogo = card.luogo;
        const { venue, ticket, img } = det;

        // ── Gate di validazione prima di pubblicare in automatico ──
        if (!nome || nome.length < 3 || norm(nome) === norm(site.nome)) {
          console.warn(`  ? nome non valido: ${card.detailUrl}`); continue;
        }
        if (esistenti.has(norm(nome))) { giaPresenti++; continue; }
        if (!dataIso) {
          console.log(`  ⏭  "${nome}" senza data (tour) — riprovo quando avrà una data`);
          senzaData++; continue;
        }
        if (dataIso < oggi) { console.log(`  ⏭  "${nome}" data passata (${dataIso}) — skip`); scartati++; continue; }
        if (!luogo) { console.log(`  ⏭  "${nome}" senza luogo — skip`); scartati++; continue; }

        const payload = {
          nome,
          data_inizio: dataIso,
          luogo,
          venue,
          ticket_url_esterno1: ticket,
          poster_url: img,
          immagine_url: img,
          stato_evento: 'Confermato',
          paese: site.paese,
          attivo: true,
          is_media_partner: false,
          seo_title: nome,
          seo_description: [nome, luogo, dataIso].filter(Boolean).join(' · '),
        };

        if (DRY_RUN) {
          console.log(`  ＋ [DRY] creerei: ${nome} | ${dataIso} | ${luogo} | ${venue || '-'} | ${ticket || 'no ticket'} | ${img ? 'img✓' : 'img✗'}`);
          esistenti.add(norm(nome));
          nuovi++;
          continue;
        }

        // Crea su Base44 (source of truth). Il payload VINCE sui campi noti;
        // dalla risposta prendiamo solo l'id (gestendo eventuale envelope {data:{...}}).
        const created = await base44Create(payload);
        const raw = created && typeof created === 'object' ? created : {};
        const body = raw.data && typeof raw.data === 'object' ? raw.data : raw;
        const b44obj = { ...body, ...payload, id: body.id };
        if (!b44obj.id) throw new Error('Base44 non ha restituito un id');

        esistenti.add(norm(nome)); // dedup subito dopo la create riuscita
        nuovi++;
        console.log(`  ＋ creato: ${nome} (${dataIso}, ${luogo}) — Base44 id ${b44obj.id}`);

        // Mirror Supabase best-effort: se fallisce, l'evento compare col sync notturno.
        try {
          await supaUpsert(b44obj);
        } catch (e) {
          console.warn(`  ⚠ mirror Supabase fallito (comparirà col sync notturno): ${e.message}`);
        }
      } catch (e) {
        console.error(`  ✗ ${card.detailUrl}: ${e.message}`);
        errori++;
      }
    }
  }

  console.log(`\n✓ Fatto — nuovi:${nuovi} · già presenti:${giaPresenti} · senza data:${senzaData} · scartati:${scartati} · errori:${errori}`);
}

main().catch((e) => {
  console.error('✗ Fatale:', e.message);
  process.exit(1);
});

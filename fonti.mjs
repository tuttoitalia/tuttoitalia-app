// ============================================================
// fonti.mjs — Adapter per le sorgenti eventi
// ============================================================
// Ogni fonte restituisce un array di EVENTI NORMALIZZATI:
// {
//   fonte, sourceId, artista, nome, dataIso, ora, citta, paese,
//   venue, ticketUrl, img, descrizione
// }
// Il core (monitor-eventi.mjs) pensa a dedup, filtri e inserimento.
//
// Due strategie, a seconda di com'è fatta la sorgente:
//  - CATALOGO: una sola richiesta scarica tutto (promoter, Live Nation)
//  - WATCHLIST: una richiesta per artista (grandi biglietterie)
// ============================================================

const UA = 'TuttoitaliaEventBot/1.0 (+https://tuttoitalia.ch)';

export async function fetchT(url, opts = {}, ms = 25000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetry(fn, what, tentativi = 3) {
  let ultimo;
  for (let i = 1; i <= tentativi; i++) {
    try { return await fn(); } catch (e) {
      ultimo = e;
      if (i < tentativi) { console.warn(`  ↻ ${what}: tentativo ${i}/${tentativi} (${e.message})`); await sleep(i * 3000); }
    }
  }
  throw ultimo;
}

async function getJson(url, opts) {
  return withRetry(async () => {
    const r = await fetchT(url, opts);
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  }, url.slice(0, 60));
}
async function getText(url, opts) {
  return withRetry(async () => {
    const r = await fetchT(url, opts);
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.text();
  }, url.slice(0, 60));
}

// ─── Geografia ────────────────────────────────────────────────
// Match ESATTO sul nome città: il confronto per sottostringa scambia
// "BERNALDA (MT)" per Berna (errore visto davvero in fase di test).
const CITTA_CH = new Map(Object.entries({
  zurich: 'Zurigo', zurigo: 'Zurigo', zuerich: 'Zurigo', 'zürich': 'Zurigo',
  geneva: 'Ginevra', geneve: 'Ginevra', 'genève': 'Ginevra', ginevra: 'Ginevra', genf: 'Ginevra',
  lausanne: 'Losanna', losanna: 'Losanna', bern: 'Berna', berna: 'Berna', berne: 'Berna',
  basel: 'Basilea', basilea: 'Basilea', bale: 'Basilea', 'bâle': 'Basilea',
  lugano: 'Lugano', locarno: 'Locarno', bellinzona: 'Bellinzona', chiasso: 'Chiasso',
  lucerne: 'Lucerna', luzern: 'Lucerna', lucerna: 'Lucerna', winterthur: 'Winterthur',
  'st. gallen': 'San Gallo', 'sankt gallen': 'San Gallo', 'san gallo': 'San Gallo',
  fribourg: 'Friburgo', friburgo: 'Friburgo', neuchatel: 'Neuchâtel', 'neuchâtel': 'Neuchâtel',
  sion: 'Sion', biel: 'Bienne', bienne: 'Bienne', thun: 'Thun', zug: 'Zugo', chur: 'Coira',
  martigny: 'Martigny', montreux: 'Montreux', vevey: 'Vevey', yverdon: 'Yverdon',
  aarau: 'Aarau', olten: 'Olten', baden: 'Baden', wil: 'Wil', uster: 'Uster',
  duebendorf: 'Dübendorf', 'dübendorf': 'Dübendorf', oerlikon: 'Zurigo', pratteln: 'Pratteln',
  savièse: 'Savièse', saviese: 'Savièse', andermatt: 'Andermatt', verscio: 'Verscio',
}));

const normCitta = (s) => (s || '').toString().trim().toLowerCase()
  .replace(/\s*\(.*?\)\s*/g, '').replace(/\s+/g, ' ').trim();

export function cittaSvizzera(city) {
  return CITTA_CH.get(normCitta(city)) || null;
}

// Codici paese ISO -> nome italiano (per il campo `paese`)
const PAESI = {
  CH: 'Svizzera', IT: 'Italia', DE: 'Germania', FR: 'Francia', AT: 'Austria',
  BE: 'Belgio', NL: 'Paesi Bassi', LU: 'Lussemburgo', GB: 'Regno Unito', UK: 'Regno Unito',
  ES: 'Spagna', PT: 'Portogallo', IE: 'Irlanda', DK: 'Danimarca', SE: 'Svezia',
  NO: 'Norvegia', FI: 'Finlandia', PL: 'Polonia', CZ: 'Repubblica Ceca', SK: 'Slovacchia',
  HU: 'Ungheria', SI: 'Slovenia', HR: 'Croazia', GR: 'Grecia', RO: 'Romania',
  BG: 'Bulgaria', MC: 'Monaco', MT: 'Malta', LI: 'Liechtenstein', SM: 'San Marino',
};
export const EUROPA = new Set(Object.keys(PAESI));
export const paeseDaCodice = (c) => PAESI[(c || '').toUpperCase()] || null;

// Bounding box Svizzera, per le fonti che danno solo coordinate
export function inSvizzera(lat, lon) {
  return lat >= 45.7 && lat <= 47.9 && lon >= 5.8 && lon <= 10.6;
}

const pulisci = (s) => (s || '').toString().replace(/\s+/g, ' ').trim() || null;
const isoDa = (s) => {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
};

// ══════════════════════════════════════════════════════════════
//  FONTI A CATALOGO (una sola richiesta scarica tutto)
// ══════════════════════════════════════════════════════════════

// Live Nation: la stessa API serve CH e IT. CountryIds=213 => Svizzera.
// robots.txt consente /api/ (vieta solo area utente).
export async function liveNation({ countryIds = '213', etichetta = 'livenation-ch' } = {}) {
  const url = `https://www.livenation.ch/api/search/events?CountryIds=${countryIds}&PageSize=500&IncludeCancelled=true&IncludePostponed=true`;
  const j = await getJson(url);
  const out = [];
  for (const d of (j.documents || [])) {
    const dataIso = isoDa(d.eventDate || d.eventDateUtc);
    if (!dataIso) continue;
    const venue = d.venue || {};
    const citta = pulisci(venue.city || d.city);
    const paese = paeseDaCodice(venue.countryCode || d.countryCode) || (cittaSvizzera(citta) ? 'Svizzera' : null);
    const artista = pulisci((d.lineup && d.lineup[0] && (d.lineup[0].name || d.lineup[0])) || d.attractionName || d.name);
    // `url` ed `externalUrl` sono sempre vuoti: il link vero sta in tickets[].ticketUrl
    const tk = (d.tickets || []).find((t) => t.isVisible !== false && t.ticketUrl) || (d.tickets || [])[0];
    out.push({
      fonte: etichetta,
      sourceId: String(d.id ?? d.eventId ?? ''),
      artista,
      nome: pulisci(d.name || d.title || artista),
      dataIso,
      ora: (d.eventDate || '').slice(11, 16) || null,
      citta: cittaSvizzera(citta) || citta,
      paese,
      venue: pulisci(venue.name || d.venueName),
      ticketUrl: pulisci(tk && tk.ticketUrl),
      img: pulisci(d.image || d.imageUrl || (d.images && d.images[0] && d.images[0].url)),
      descrizione: pulisci(d.eventListingText || d.description),
      organizzatore: pulisci(d.promoter) || 'Live Nation',
    });
  }
  return out;
}

// Friends & Partners: /calendario/filter senza parametri = dump completo.
// Nessun robots.txt sul sito.
export async function friendsAndPartners() {
  const j = await getJson('https://www.friendsandpartners.it/calendario/filter');
  const MESI = { gennaio:'01', febbraio:'02', marzo:'03', aprile:'04', maggio:'05', giugno:'06', luglio:'07', agosto:'08', settembre:'09', ottobre:'10', novembre:'11', dicembre:'12' };
  const out = [];
  for (const d of (j.tour_dates || [])) {
    if (d.cancelled) continue;
    // "giovedì 15 ottobre 2026"
    const m = String(d.date || '').match(/(\d{1,2})\s+([a-zà-ù]+)\s+(\d{4})/i);
    if (!m || !MESI[m[2].toLowerCase()]) continue;
    const dataIso = `${m[3]}-${MESI[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
    const citta = pulisci(d.city);
    const ch = cittaSvizzera(citta);
    // link biglietti: estratto dall'HTML del bottone
    let ticketUrl = null;
    for (const t of Object.values(d.tickets || {})) {
      const hm = String(t.render || '').match(/href="([^"]+)"/);
      if (hm) { ticketUrl = hm[1]; break; }
    }
    out.push({
      fonte: 'friendsandpartners',
      sourceId: String(d.id ?? ''),
      artista: pulisci((d.artists || [])[0]),
      nome: pulisci(d.tour_name ? `${(d.artists || [])[0] || ''} - ${d.tour_name}`.replace(/^ - /, '') : (d.artists || [])[0]),
      dataIso,
      ora: pulisci(d.time),
      citta: ch || citta,
      paese: ch ? 'Svizzera' : 'Italia',   // roster italiano: fuori CH è Italia salvo eccezioni
      venue: pulisci(d.place),
      ticketUrl,
      img: pulisci(d.picture),
      descrizione: null,
      soldOut: !!d.soldout,
      rimandato: !!d.postponed,
      organizzatore: 'Friends & Partners',
    });
  }
  return out;
}

// Vivo Concerti: tutto il calendario dentro __NEXT_DATA__ con una richiesta.
// `page` è cumulativo: page=25 restituisce l'intero elenco.
export async function vivoConcerti() {
  const html = await getText('https://www.vivoconcerti.com/calendario?page=25');
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ non trovato (sito cambiato?)');
  const j = JSON.parse(m[1]);
  const ent = j?.props?.pageProps?.entities || [];
  const out = [];
  for (const e of ent) {
    const dataIso = isoDa(e.eventDateTime || e.dateTime);
    if (!dataIso) continue;
    const v = (e.venues || [])[0] || {};
    // La città sta annidata in venues[0].address.city.name (non esiste un campo piatto)
    const citta = pulisci(v.address?.city?.name);
    const ch = cittaSvizzera(citta);
    const artista = pulisci((e.artists || [])[0]?.name);
    const tour = pulisci((e.tours || [])[0]?.name);
    out.push({
      fonte: 'vivoconcerti',
      sourceId: String(e.id ?? e.documentId ?? ''),
      artista,
      nome: pulisci([artista, tour].filter(Boolean).join(' - ')) || pulisci(e.title),
      dataIso,
      ora: (e.eventDateTime || '').slice(11, 16) || null,
      citta: ch || citta,
      paese: ch ? 'Svizzera' : 'Italia',
      venue: pulisci(v.name),
      ticketUrl: pulisci(((e.tickets || [])[0] || {}).link),
      img: null,
      descrizione: null,
      organizzatore: 'Vivo Concerti',
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  FONTI A WATCHLIST (una richiesta per artista)
// ══════════════════════════════════════════════════════════════

// Ticketcorner via API pubblica Eventim: la fonte migliore per la Svizzera.
// ATTENZIONE UA: con uno User-Agent che finge un browser risponde 403;
// con "nome/versione" (come il nostro) risponde 200. Non spacciarsi per browser.
export async function ticketcorner(nome) {
  const url = `https://public-api.eventim.com/websearch/search/api/exploration/v1/products?webId=web__ticketcorner-ch&language=it&search_term=${encodeURIComponent(nome)}`;
  const j = await getJson(url);
  const out = [];
  for (const p of (j.products || [])) {
    const le = p.typeAttributes?.liveEntertainment;
    const dataIso = isoDa(le?.startDate);
    if (!dataIso) continue;
    const loc = le?.location || {};
    const geo = loc.geoLocation || {};
    const ch = cittaSvizzera(loc.city) || (inSvizzera(geo.latitude, geo.longitude) ? pulisci(loc.city) : null);
    out.push({
      fonte: 'ticketcorner',
      sourceId: String(p.productId ?? ''),
      artista: pulisci((p.attractions || [])[0]?.name || nome),
      nome: pulisci(p.name),
      dataIso,
      ora: (le?.startDate || '').slice(11, 16) || null,
      citta: ch || pulisci(loc.city),
      paese: ch ? 'Svizzera' : null,
      venue: pulisci(loc.name),
      ticketUrl: p.url ? `${p.url.domain || 'https://www.ticketcorner.ch'}${p.url.path || ''}` : null,
      img: pulisci(p.imageUrl),
      descrizione: pulisci(p.description),
      prezzoDa: p.price ?? null,
      valuta: p.currency ?? null,
      soldOut: p.inStock === false,
      lat: geo.latitude ?? null,
      lon: geo.longitude ?? null,
    });
  }
  return out;
}

// Ticketino: JSON via header XHR. robots.txt non vieta /Search.
export async function ticketino(nome) {
  const j = await getJson(`https://www.ticketino.com/Search?q=${encodeURIComponent(nome)}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept-Language': 'it-IT,it;q=0.9' },
  });
  const out = [];
  for (const e of (j.Events || [])) {
    // "2.10.2026" oppure "2.10.2026 - 4.10.2026": prendo la prima data
    const m = String(e.StartAndEndDate || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!m) continue;
    const dataIso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const citta = pulisci(e.City);
    const ch = cittaSvizzera(citta);
    out.push({
      fonte: 'ticketino',
      sourceId: String(e.Id ?? ''),
      // Ticketino non espone un campo artista: lasciarlo null è importante,
      // perché riempirlo col nome CERCATO renderebbe cieco il filtro di pertinenza
      // (era così che "Jolly & the Flytrap" passava per Olly).
      artista: null,
      nome: pulisci(e.Name),
      dataIso,
      ora: pulisci(e.StartTime),
      citta: ch || (citta ? citta.charAt(0) + citta.slice(1).toLowerCase() : null),
      paese: ch ? 'Svizzera' : null,
      venue: pulisci(e.Location),
      ticketUrl: e.Url ? `https://www.ticketino.com${e.Url}` : null,
      img: e.ImageUrl ? `https://www.ticketino.com${e.ImageUrl}` : null,
      descrizione: null,
      soldOut: e.BookableStatus === 2,
    });
  }
  return out;
}

// Eventfrog: frammento HTML dei risultati. robots.txt consente /en/ (vieta /it/).
export async function eventfrog(nome) {
  const html = await getText(
    `https://eventfrog.ch/en/event-list.html?searchTerm=${encodeURIComponent(nome)}&shop_recpage=1&perPage=48`,
    { headers: { 'Accept-Language': 'en;q=0.9' } }
  );
  const MESI_EN = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', sept:'09', oct:'10', nov:'11', dec:'12' };
  const out = [];
  const tiles = html.split(/<a\s+href="/).slice(1);
  for (const t of tiles) {
    if (!/event-list__events__tile/.test(t)) continue;
    const href = (t.match(/^([^"]+)"/) || [])[1];
    const titolo = (t.match(/infos__title[^>]*>([^<]+)</) || [])[1];
    const info = (t.match(/infos__time[^>]*>([^<]+)</) || [])[1] || '';
    // "18 September, Friday, 19:30"
    const dm = info.match(/(\d{1,2})\s+([A-Za-z]{3,9})/);
    const anno = (info.match(/\b(20\d{2})\b/) || [])[1];
    if (!dm || !titolo) continue;
    const mm = MESI_EN[dm[2].slice(0, 4).toLowerCase()] || MESI_EN[dm[2].slice(0, 3).toLowerCase()];
    if (!mm) continue;
    const oggi = new Date();
    const y = anno || (Number(mm) < oggi.getMonth() + 1 ? oggi.getFullYear() + 1 : oggi.getFullYear());
    const dataIso = `${y}-${mm}-${dm[1].padStart(2, '0')}`;
    const luogo = (t.match(/infos__location[^>]*>([^<]+)</) || [])[1];
    const citta = pulisci((luogo || '').split(',').pop());
    const ch = cittaSvizzera(citta);
    out.push({
      fonte: 'eventfrog',
      sourceId: (href || '').split('-').pop()?.replace('.html', '') || '',
      artista: nome,
      nome: pulisci(titolo.replace(/&ndash;/g, '-').replace(/&amp;/g, '&')),
      dataIso,
      ora: (info.match(/(\d{1,2}:\d{2})/) || [])[1] || null,
      citta: ch || citta,
      paese: ch ? 'Svizzera' : null,
      venue: pulisci((luogo || '').split(',')[0]),
      ticketUrl: href ? `https://eventfrog.ch${href}` : null,
      img: (t.match(/src="(https:\/\/res\.eventfrog\.net[^"]+)"/) || [])[1] || null,
      descrizione: null,
    });
  }
  return out;
}

// Filtro di pertinenza: la ricerca full-text di alcune piattaforme restituisce
// risultati fuorvianti (cercando "Ligabue" su Eventfrog esce uno spettacolo
// teatrale su Antonio Ligabue, il PITTORE). Teniamo un risultato solo se il
// nome cercato compare davvero nel titolo o nell'artista.
// ATTENZIONE: niente confronti per sottostringa. Cercando "Ultimo" la ricerca
// restituisce "Ricardo Montaner - El Ultimo Regreso", cercando "Olly" restituisce
// "Jolly & the Flytrap". Servono il nome intero o una coincidenza esatta.
export function pertinente(evento, nomeCercato) {
  const n = (s) => (s || '').toString().toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const cercato = n(nomeCercato);
  const artista = n(evento.artista);
  const titolo = n(evento.nome);
  if (!cercato) return false;
  if (artista && artista === cercato) return true;              // artista esatto
  if (cercato.length >= 8 && (titolo.includes(cercato) || artista.includes(cercato))) return true;
  // nome corto (Anna, Olly, Nitro): solo come PAROLA ISOLATA, mai dentro un'altra
  // ("jolly the flytrap" non contiene la parola "olly", quindi viene respinto)
  const parola = new RegExp(`(^| )${cercato.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
  return parola.test(artista) || parola.test(titolo);
}

export const FONTI_CATALOGO = {
  'livenation-ch': () => liveNation({ countryIds: '213', etichetta: 'livenation-ch' }),
  'friendsandpartners': friendsAndPartners,
  'vivoconcerti': vivoConcerti,
};

// Eventfrog ESCLUSO di proposito: la sua ricerca full-text è troppo rumorosa
// (per "Massimo Ranieri" non trova la data del LAC che Ticketcorner vede, e per
// "Ligabue" restituisce teatro tedesco sul pittore). Aggiunge rumore, non copertura.
export const FONTI_WATCHLIST = { ticketcorner, ticketino };

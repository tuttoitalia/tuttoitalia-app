// ============================================================
// monitor-eventi.mjs — Monitoraggio eventi di artisti italiani
// ============================================================
// Ogni ora: interroga le piattaforme di ticketing e i promoter,
// tiene solo gli eventi di ARTISTI ITALIANI che si svolgono FUORI
// DALL'ITALIA (Svizzera in primis, poi Europa e resto del mondo:
// è lì che vive il pubblico di Tuttoitalia).
//
// NON pubblica: deposita quello che trova nella coda `eventi_proposti`, che
// il pannello mostra in "Nuovi eventi da aggiungere". L'evento finisce sul
// calendario solo quando Cirano lo aggiunge da li'. Prima il monitor creava
// tutto da se' su Base44, e ogni errore di riconoscimento diventava una scheda
// pubblica da rincorrere.
//
// Env: BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Flag: DRY_RUN=1     -> non scrive nulla, mostra solo cosa farebbe
//       SOLO_CH=1     -> limita ai soli eventi in Svizzera
//       SLICE=n       -> forza lo scaglione di watchlist (default: ora corrente)
// ============================================================

import fs from 'node:fs';
import {
  FONTI_CATALOGO, FONTI_WATCHLIST, pertinente, cittaSvizzera,
  mononomeIsolato, isPacchetto, fetchT, withRetry,
} from './fonti.mjs';

const B44_APP_ID = process.env.BASE44_APP_ID;
const B44_API_KEY = process.env.BASE44_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = ['1', 'true'].includes(String(process.env.DRY_RUN));
const SOLO_CH = ['1', 'true'].includes(String(process.env.SOLO_CH));

if (!B44_APP_ID || !B44_API_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('✗ Missing env: BASE44_APP_ID, BASE44_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Quanti scaglioni per coprire tutta la watchlist (1 all'ora -> giro completo in 6 ore)
const SCAGLIONI = 6;
const SLICE = process.env.SLICE ? Number(process.env.SLICE) : new Date().getUTCHours() % SCAGLIONI;

// ─── Helper ───────────────────────────────────────────────────
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

// ─── Base44 ───────────────────────────────────────────────────
const B44_URL = `https://base44.app/api/apps/${B44_APP_ID}/entities/Evento`;

async function base44Eventi() {
  return withRetry(async () => {
    const r = await fetchT(B44_URL, { headers: { api_key: B44_API_KEY } });
    if (!r.ok) throw new Error(`${r.status}`);
    const arr = await r.json();
    return Array.isArray(arr) ? arr : [];
  }, 'Base44 list');
}

// Il monitor non crea piu' eventi su Base44 ne' li rispecchia su Supabase:
// deposita proposte e basta. La creazione avviene dal pannello, in
// /api/admin/eventi/proposte, quando la proposta viene aggiunta.

const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };

// ─── Coda delle proposte ──────────────────────────────────────
// Tutto quello che il monitor trova passa da qui. Le proposte gia' presenti
// (in qualunque stato: in attesa, aggiunte, scartate) non si ripropongono,
// altrimenti un evento rifiutato tornerebbe a ogni giro.
const PROPOSTE_URL = `${SUPA_URL}/rest/v1/eventi_proposti`;

async function chiaviProposte() {
  const r = await withRetry(() => fetchT(`${PROPOSTE_URL}?select=chiave,stato`, { headers: supaHeaders }), 'lettura proposte');
  // Tabella non ancora creata: si esce senza pubblicare e senza far fallire il
  // workflow. Fallire ogni ora manderebbe una mail di errore all'ora; pubblicare
  // lo stesso tradirebbe il motivo per cui la coda esiste.
  if (r.status === 404 || r.status === 406) return null;
  if (!r.ok) throw new Error(`lettura proposte ${r.status}`);
  const righe = await r.json();
  const per = { tutte: new Set(), inAttesa: 0 };
  for (const p of righe) {
    per.tutte.add(p.chiave);
    if (p.stato === 'in_attesa') per.inAttesa++;
  }
  return per;
}

async function creaProposte(righe) {
  // ignoreDuplicates: se due giri si accavallano, la chiave UNIQUE regge e la
  // seconda insert non fa danni invece di far fallire tutto il lotto.
  const r = await fetchT(`${PROPOSTE_URL}?on_conflict=chiave`, {
    method: 'POST',
    headers: { ...supaHeaders, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(righe),
  });
  if (!r.ok) throw new Error(`inserimento proposte ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ─── Watchlist ────────────────────────────────────────────────
function caricaWatchlist() {
  const raw = JSON.parse(fs.readFileSync(new URL('./watchlist.json', import.meta.url), 'utf8'));
  const arr = raw.artisti || raw;
  return arr.map((a) => ({
    nome: a.nome, alias: a.alias || [], priorita: a.priorita || 'media',
    chiavi: [a.nome, ...(a.alias || [])].map(norm).filter(Boolean),
  }));
}

// Un evento è "di artista italiano" solo con un riscontro STRETTO.
// Il confronto per sottostringa è inaffidabile e va evitato: in prova aveva
// scambiato "CA7RIEL & Paco Amoroso" per Alessandra Amoroso, "Don Toliver:
// NITROUS" per Nitro, "Jolly & the Flytrap" per Olly e "El Ultimo Regreso"
// di Ricardo Montaner per Ultimo. Nomi brevi come Anna, Olly, Asco, Alfa
// catturano di tutto.
function trovaArtistaItaliano(ev, watchlist) {
  const art = norm(ev.artista);
  const titolo = norm(ev.nome);
  for (const a of watchlist) {
    // 1) il campo artista coincide ESATTAMENTE con il nome o un suo alias
    if (art && a.chiavi.includes(art)) return a.nome;
    // 2) il nome COMPLETO (mai gli alias brevi) compare nel titolo:
    //    prende i tributi ("Eine Hommage an Ludovico Einaudi") senza falsi positivi
    const completo = norm(a.nome);
    if (completo.length >= 8 && (titolo.includes(completo) || art.includes(completo))) return a.nome;
    // 3) mononome corto: solo se resta ISOLATO nel titolo grezzo, altrimenti la
    //    parola che segue è un cognome e l'artista è un omonimo qualsiasi
    //    ("Anna Lipiak", "Blanco White", "Clara Lösel"). Vedi mononomeIsolato.
    if (completo.length < 8 && (mononomeIsolato(a.nome, ev.artista) || mononomeIsolato(a.nome, ev.nome))) return a.nome;
  }
  return null;
}

// ─── Esclusioni permanenti ────────────────────────────────────
// Un evento cancellato a mano dal calendario NON deve tornare al giro dopo.
// Prima mancava del tutto: il dedup guardava solo ciò che era presente su
// Base44, quindi ogni cancellazione veniva annullata entro un'ora. Risultato
// reale: "Anna Lipiak - Klavier" ricreato 4 volte, 22 eventi rimessi online
// dopo che Cirano li aveva tolti.
//
// Due fonti di verità, entrambe consultate prima di creare:
//  a) esclusi.json      — pattern espliciti (artisti omonimi, rassegne indesiderate)
//  b) Supabase deleted_at — ogni evento sparito da Base44 viene soft-deleted dal
//     sync notturno: è il registro automatico di ciò che è stato cancellato.
// L'anno va tolto dal titolo prima di confrontare: la stessa fonte pubblica lo
// stesso concerto ora con l'anno ora senza ("The best of Ennio Morricone" /
// "The best of Ennio Morricone 2027") e senza questa pulizia il doppione passa.
const titoloBase = (nome) => norm(String(nome || '').replace(/\b(19|20)\d{2}\b/g, ''));
const chiaveBlocco = (nome, data) => `${titoloBase(nome)}|${(data || '').slice(0, 10)}`;
const giorniTra = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
// Una rassegna che torna ogni anno (Morricone, i festival) deve poter rientrare
// con la nuova edizione: il blocco per solo titolo vale entro questa finestra,
// oltre la quale si presume una nuova edizione e non una riproposta.
const FINESTRA_BLOCCO_GIORNI = 90;

function caricaEsclusi() {
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('./esclusi.json', import.meta.url), 'utf8'));
    return {
      artisti: (raw.artisti || []).map(norm).filter(Boolean),
      titoli: (raw.titoli || []).map(norm).filter(Boolean),
    };
  } catch {
    return { artisti: [], titoli: [] };
  }
}

// Registra subito le cancellazioni fatte a mano sul calendario.
// Senza questo passaggio la blocklist si accorge di una cancellazione solo dopo
// il sync notturno delle 02:00, e nel frattempo il monitor rimette online
// l'evento appena tolto: era esattamente il ciclo da cui siamo partiti. Qui il
// confronto e' immediato: cio' che risulta attivo su Supabase ma non e' piu' su
// Base44 e' stato cancellato da Cirano, e va marcato prima di decidere cosa creare.
//
// Due freni contro il disastro: se la lista Base44 arriva corta (fetch parziale,
// pagina mancante) sembrerebbero cancellati centinaia di eventi vivi, quindi si
// procede solo con una lista di dimensione plausibile e con poche sparizioni.
// Meglio registrare le cancellazioni un giro piu' tardi che svuotare il calendario.
const MIN_LISTA_SANA = 500;
const MAX_SPARIZIONI = 40;

async function registraCancellazioni(esistenti) {
  if (esistenti.length < MIN_LISTA_SANA) {
    console.warn(`  ⚠ lista Base44 corta (${esistenti.length}): salto il controllo delle cancellazioni`);
    return 0;
  }
  const vivi = new Set(esistenti.map((e) => e.id).filter(Boolean));

  const r = await withRetry(() => fetchT(
    `${SUPA_URL}/rest/v1/events?select=base44_id,title,date&deleted_at=is.null&base44_id=not.is.null`,
    { headers: supaHeaders },
  ), 'Supabase attivi');
  if (!r.ok) throw new Error(`lettura eventi attivi ${r.status}`);
  const attivi = await r.json();

  const spariti = attivi.filter((e) => !vivi.has(e.base44_id));
  if (!spariti.length) return 0;
  if (spariti.length > MAX_SPARIZIONI) {
    console.warn(`  ⚠ ${spariti.length} eventi risultano spariti da Base44: troppi per essere cancellazioni manuali, non registro nulla`);
    return 0;
  }

  for (const e of spariti) console.log(`  − cancellato dal calendario: ${(e.title || '').slice(0, 60)} (${e.date || 's.d.'})`);
  if (DRY_RUN) return spariti.length;

  const ids = spariti.map((e) => `"${e.base44_id}"`).join(',');
  const w = await fetchT(`${SUPA_URL}/rest/v1/events?base44_id=in.(${ids})`, {
    method: 'PATCH', headers: supaHeaders,
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  if (!w.ok) throw new Error(`registrazione cancellazioni ${w.status}: ${(await w.text()).slice(0, 200)}`);
  return spariti.length;
}

async function blocklistSupabase() {
  const chiavi = new Set();
  const perTitolo = new Map();   // titolo senza anno -> date in cui è stato cancellato
  try {
    const r = await withRetry(() => fetchT(
      `${SUPA_URL}/rest/v1/events?select=title,date&deleted_at=not.is.null`,
      { headers: supaHeaders },
    ), 'Supabase blocklist');
    if (!r.ok) throw new Error(`${r.status}`);
    for (const e of await r.json()) {
      if (!e.title) continue;
      chiavi.add(chiaveBlocco(e.title, e.date));
      const t = titoloBase(e.title);
      if (e.date) {
        if (!perTitolo.has(t)) perTitolo.set(t, []);
        perTitolo.get(t).push(e.date.slice(0, 10));
      }
    }
  } catch (e) {
    // Senza blocklist si rischia di resuscitare eventi cancellati: meglio
    // saltare il giro che rifare il danno.
    throw new Error(`blocklist non leggibile, giro annullato: ${e.message}`);
  }
  return { chiavi, perTitolo };
}

// Escluso se la stessa coppia titolo+data è già stata cancellata, oppure se lo
// stesso titolo è stato cancellato per una data vicina: la fonte ripropone lo
// stesso concerto con il nome leggermente diverso ("The best of Ennio Morricone
// 2027") o con la data spostata di qualche giorno. Oltre la finestra si assume
// una nuova edizione — le rassegne annuali devono poter rientrare.
function escluso(ev, artista, blocco, esclusi, titoliVivi) {
  const nome = norm(ev.nome);
  const base = titoloBase(ev.nome);
  if (blocco.chiavi.has(chiaveBlocco(ev.nome, ev.dataIso))) return 'già cancellato (stessa data)';
  // Il blocco largo non vale per una serie che è in calendario di proposito:
  // "The Best Of Ennio Morricone" è un tour di 14 date volute, di cui alcune
  // erano state cancellate solo perché doppie. Lì basta il blocco per data
  // esatta, altrimenti le date nuove del tour non entrerebbero mai più.
  if (!titoliVivi.has(base)) {
    const vicine = blocco.perTitolo.get(base) || [];
    if (vicine.some((d) => giorniTra(d, ev.dataIso) <= FINESTRA_BLOCCO_GIORNI)) return 'già cancellato (stesso titolo, data vicina)';
  }
  if (esclusi.artisti.includes(norm(artista))) return 'artista in esclusi.json';
  if (esclusi.titoli.some((t) => nome.includes(t))) return 'titolo in esclusi.json';
  return null;
}

// ─── Chiavi di deduplicazione ─────────────────────────────────
// Lo stesso concerto compare su più piattaforme con nomi diversi
// ("Ligabue" / "LIGABUE Certe Notti 2026"), e Ticketcorner lo pubblica
// due volte quando esiste un pacchetto VIP. La chiave robusta è
// artista + data + città.
const chiaveEvento = (artista, dataIso, citta) => `${norm(artista)}|${dataIso}|${norm(citta)}`;

// Due testi indicano la stessa cosa anche quando uno e' l'inizio dell'altro:
// la stessa sala figura come "Stadtcasino" e "Stadtcasino Basel", lo stesso
// concerto come "Angelo Branduardi in DUO con Fabio Valdemarin" e "... -
// Confessioni di un Malandrino". La soglia evita che titoli generici e brevi
// ("Carmen") si aggreghino a qualunque cosa cominci allo stesso modo.
function unoInizioDellAltro(a, b, minimo) {
  const x = norm(a), y = norm(b);
  if (!x || !y || x.length < minimo || y.length < minimo) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

function chiaviBase44(eventi) {
  const perNome = new Set();
  const perArtistaDataCitta = new Set();
  const perDataCitta = new Map();   // data|citta -> [{titolo, venue}] gia' in calendario
  const titoliVivi = new Set();     // serie volute in calendario: vedi escluso()
  for (const e of eventi) {
    if (e.nome) { perNome.add(norm(e.nome)); titoliVivi.add(titoloBase(e.nome)); }
    const d = (e.data_inizio || '').slice(0, 10);
    if (d && e.luogo) {
      perArtistaDataCitta.add(chiaveEvento(e.nome, d, e.luogo));
      // il nome Base44 è spesso "Artista - Titolo": indicizzo anche la sola prima parte
      const primo = String(e.nome || '').split(/[-–—:|]/)[0];
      if (primo) perArtistaDataCitta.add(chiaveEvento(primo, d, e.luogo));
      const k = `${d}|${norm(e.luogo)}`;
      if (!perDataCitta.has(k)) perDataCitta.set(k, []);
      perDataCitta.get(k).push({ titolo: titoloBase(e.nome), venue: e.venue || '' });
    }
  }
  return { perNome, perArtistaDataCitta, perDataCitta, titoliVivi };
}

// Stesso giorno, stessa citta' e (stessa sala oppure titolo che comincia allo
// stesso modo) = evento gia' presente. Copre i casi che il confronto sul nome
// esatto lascia passare: il titolo in calendario corretto a mano (i Morricone
// ripuliti da "- Milano Festival Opera / 311") e la fonte che aggiunge il
// sottotitolo dello spettacolo a un evento gia' inserito (i due Branduardi).
function giaInCalendario(ev, perDataCitta) {
  const lista = perDataCitta.get(`${ev.dataIso}|${norm(ev.citta)}`) || [];
  return lista.some((e) => unoInizioDellAltro(e.venue, ev.venue, 4)
    || unoInizioDellAltro(e.titolo, titoloBase(ev.nome), 12));
}

// ─── Raccolta dalle fonti ─────────────────────────────────────
async function raccogli(watchlist) {
  const tutti = [];
  const problemi = [];

  // 1) Fonti a catalogo: una richiesta scarica tutto
  for (const [nome, fn] of Object.entries(FONTI_CATALOGO)) {
    try {
      const ev = await fn();
      console.log(`  · ${nome}: ${ev.length} eventi`);
      tutti.push(...ev);
    } catch (e) {
      console.error(`  ✗ ${nome}: ${e.message}`);
      problemi.push(nome);
    }
  }

  // 2) Fonti a watchlist: uno scaglione per volta (giro completo in SCAGLIONI ore)
  const scaglione = watchlist.filter((_, i) => i % SCAGLIONI === SLICE);
  console.log(`  · scaglione watchlist ${SLICE + 1}/${SCAGLIONI}: ${scaglione.length} artisti`);
  for (const [nome, fn] of Object.entries(FONTI_WATCHLIST)) {
    let trovati = 0;
    for (const art of scaglione) {
      try {
        const ev = await fn(art.nome);
        for (const e of ev) {
          if (!pertinente(e, art.nome)) continue;   // scarta gli omonimi
          e.artistaWatchlist = art.nome;
          tutti.push(e);
          trovati++;
        }
      } catch (e) {
        problemi.push(`${nome}/${art.nome}`);
      }
      await new Promise((r) => setTimeout(r, 350));  // educati con i loro server
    }
    console.log(`  · ${nome}: ${trovati} eventi su ${scaglione.length} artisti`);
  }
  return { tutti, problemi };
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  const oggi = new Date().toISOString().slice(0, 10);
  console.log(`▶ Monitoraggio eventi ${DRY_RUN ? '(DRY RUN) ' : ''}${SOLO_CH ? '[solo CH] ' : ''}— ${new Date().toISOString()}`);

  const watchlist = caricaWatchlist();
  console.log(`  watchlist: ${watchlist.length} artisti italiani`);

  const esistenti = await base44Eventi();
  const { perNome, perArtistaDataCitta, perDataCitta, titoliVivi } = chiaviBase44(esistenti);
  console.log(`  Base44: ${esistenti.length} eventi già in calendario`);

  const esclusi = caricaEsclusi();
  const proposte = await chiaviProposte();
  if (!proposte) {
    console.log('\n⚠ La coda non esiste ancora: manca la tabella eventi_proposti.');
    console.log('  Lanciare schema_eventi_proposti.sql nella console SQL di Supabase.');
    console.log('  Fino ad allora il monitor non pubblica nulla, per scelta.');
    return;
  }
  console.log(`  coda proposte: ${proposte.tutte.size} gia' viste, ${proposte.inAttesa} in attesa di decisione`);
  const tolti = await registraCancellazioni(esistenti);
  if (tolti) console.log(`  registrate ${tolti} cancellazioni fatte a mano dall'ultimo giro`);
  const blocco = await blocklistSupabase();
  console.log(`  esclusioni: ${blocco.chiavi.size} eventi cancellati a mano + ${esclusi.artisti.length} artisti e ${esclusi.titoli.length} titoli in esclusi.json`);

  const { tutti, problemi } = await raccogli(watchlist);
  console.log(`\n  raccolti ${tutti.length} eventi grezzi da ${Object.keys(FONTI_CATALOGO).length + Object.keys(FONTI_WATCHLIST).length} fonti`);

  // ── Filtri: artista italiano, fuori dall'Italia, data futura, dati minimi ──
  const visti = new Set();
  const candidati = [];
  const scarti = { nonItaliano: 0, inItalia: 0, passato: 0, incompleto: 0, giaPresente: 0, doppione: 0, pacchetto: 0, escluso: 0, giaProposto: 0 };
  const bloccati = [];

  for (const ev of tutti) {
    if (!ev.dataIso || !ev.citta || !ev.nome) { scarti.incompleto++; continue; }
    if (ev.dataIso < oggi) { scarti.passato++; continue; }
    // pacchetti VIP/hospitality: sono extra di biglietteria, non eventi
    if (isPacchetto(ev.nome)) { scarti.pacchetto++; continue; }

    const artista = ev.artistaWatchlist || trovaArtistaItaliano(ev, watchlist) || (
      // i promoter italiani hanno un roster tutto italiano: mi fido della fonte
      ['vivoconcerti', 'friendsandpartners'].includes(ev.fonte) ? ev.artista : null
    );
    if (!artista) { scarti.nonItaliano++; continue; }

    // cancellato a mano in passato: non si ripropone
    const motivo = escluso(ev, artista, blocco, esclusi, titoliVivi);
    if (motivo) { scarti.escluso++; bloccati.push(`${ev.nome} (${motivo})`); continue; }

    // Il pubblico di Tuttoitalia vive fuori dall'Italia: le date italiane non servono
    const inCH = !!cittaSvizzera(ev.citta) || ev.paese === 'Svizzera';
    if (ev.paese === 'Italia' && !inCH) { scarti.inItalia++; continue; }
    if (SOLO_CH && !inCH) { scarti.inItalia++; continue; }

    const k = chiaveEvento(artista, ev.dataIso, ev.citta);
    if (visti.has(k)) { scarti.doppione++; continue; }          // doppione fra fonti diverse
    if (perArtistaDataCitta.has(k) || perNome.has(norm(ev.nome))
        || giaInCalendario(ev, perDataCitta)) { scarti.giaPresente++; continue; }
    // gia' proposto in un giro precedente: in attesa, aggiunto o scartato che sia
    if (proposte.tutte.has(k)) { scarti.giaProposto++; continue; }
    visti.add(k);
    candidati.push({ ...ev, artista, inCH });
  }

  candidati.sort((a, b) => (b.inCH - a.inCH) || a.dataIso.localeCompare(b.dataIso));
  console.log(`  candidati NUOVI: ${candidati.length}  (di cui in Svizzera: ${candidati.filter((c) => c.inCH).length})`);
  console.log(`  scartati -> non italiani:${scarti.nonItaliano} in Italia:${scarti.inItalia} passati:${scarti.passato} incompleti:${scarti.incompleto} già in calendario:${scarti.giaPresente} doppioni:${scarti.doppione} pacchetti:${scarti.pacchetto} esclusi:${scarti.escluso} gia' in coda:${scarti.giaProposto}`);
  if (bloccati.length) {
    console.log('  non riproposti perché cancellati a mano:');
    for (const b of [...new Set(bloccati)].slice(0, 25)) console.log(`    · ${b.slice(0, 90)}`);
  }

  // ── Deposito in coda ──
  // Il calendario pubblico non si tocca: qui si scrive solo la proposta.
  // La creazione su Base44 avviene dal pannello, quando Cirano la aggiunge.
  let proposti = 0;
  const errori = problemi.length;
  const perOutreach = [];

  const righe = candidati.map((c) => ({
    chiave: chiaveEvento(c.artista, c.dataIso, c.citta),
    nome: c.nome,
    data_evento: c.dataIso,
    ora: c.ora || null,
    citta: c.citta,
    venue: c.venue || null,
    paese: c.paese || (c.inCH ? 'Svizzera' : null),
    descrizione: c.descrizione || null,
    poster_url: c.img || null,
    ticket_url: c.ticketUrl || null,
    artista: c.artista,
    fonte: c.fonte || null,
    organizzatore: c.organizzatore || null,
    geo_lat: c.lat ?? null,
    geo_lng: c.lon ?? null,
    in_svizzera: !!c.inCH,
    stato: 'in_attesa',
  }));

  for (const c of candidati) {
    console.log(`  ＋${DRY_RUN ? ' [DRY]' : ''} ${c.dataIso} | ${c.artista.slice(0, 24).padEnd(24)} | ${(c.citta || '').padEnd(11)} | ${(c.venue || '-').slice(0, 26).padEnd(26)} | ${c.fonte}${c.organizzatore ? ' / ' + c.organizzatore : ''}`);
    perOutreach.push({ evento: c.nome, data: c.dataIso, citta: c.citta, organizzatore: c.organizzatore || c.fonte });
  }

  if (righe.length && !DRY_RUN) {
    // Un lotto solo: o entrano tutte o nessuna, cosi' non restano proposte
    // a meta' da riconciliare al giro dopo.
    await creaProposte(righe);
  }
  proposti = righe.length;

  // ── Riepilogo per l'outreach commerciale ──
  if (perOutreach.length) {
    const perOrg = {};
    for (const o of perOutreach) (perOrg[o.organizzatore] ||= []).push(o);
    console.log('\n── Da segnalare agli organizzatori ──');
    for (const [org, lista] of Object.entries(perOrg)) {
      console.log(`  ${org}: ${lista.length} eventi (${lista.slice(0, 3).map((l) => l.evento?.slice(0, 30)).join(', ')}${lista.length > 3 ? ', …' : ''})`);
    }
  }

  console.log(`\n✓ Fatto — nuovi:${creati} · errori:${errori}`);
}

main().catch((e) => { console.error('✗ Fatale:', e.message); process.exit(1); });

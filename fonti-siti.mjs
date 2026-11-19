// ============================================================
// fonti-siti.mjs: siti generici controllati una volta al giorno
// ============================================================
// L'elenco vive in Supabase, impostazioni.fonti_eventi, e si modifica dal
// gestionale in /admin/eventi/fonti (19.11.2026). Per i siti senza un adapter
// dedicato (agenzie, sale, biglietterie comunali) non esiste un'API comune:
// si scarica la pagina, se e' vuota (siti Wix e simili, che caricano gli eventi
// in JavaScript) la si apre con un browser headless, e il testo passa a Claude
// Haiku che restituisce gli eventi in forma normalizzata.
//
// Ogni evento torna con il flag `italiano` (artista, compagnia o orchestra
// italiana, oppure tributo eseguito da italiani): il core lo usa al posto della
// watchlist per i siti che non sono di sole proposte italiane.
// ============================================================

import { fetchT, cittaSvizzera } from './fonti.mjs';

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const MODELLO = 'claude-haiku-5-5';
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };

// Fonti iniziali: valgono finche' la riga in impostazioni non esiste.
export const FONTI_PREDEFINITE = [
  { id: 'livenation-ch', nome: 'Live Nation Svizzera', url: 'https://www.livenation.ch', tipo: 'catalogo', attiva: true },
  { id: 'friendsandpartners', nome: 'Friends & Partners', url: 'https://www.friendsandpartners.it/calendario', tipo: 'catalogo', attiva: true },
  { id: 'vivoconcerti', nome: 'Vivo Concerti', url: 'https://www.vivoconcerti.com/calendario', tipo: 'catalogo', attiva: true },
  { id: 'ticketcorner', nome: 'Ticketcorner', url: 'https://www.ticketcorner.ch', tipo: 'watchlist', attiva: true },
  { id: 'ticketino', nome: 'Ticketino', url: 'https://www.ticketino.com', tipo: 'watchlist', attiva: true },
  { id: 'billetterie-geneve', nome: 'Billetterie culturelle Ville de Genève', url: 'https://billetterie-culture.geneve.ch/list/events', tipo: 'sito', attiva: true, tutti_italiani: false },
  { id: 'marbea', nome: 'Marbea Entertainment', url: 'https://www.marbea.ch/eventi', tipo: 'sito', attiva: true, tutti_italiani: true },
  { id: 'dema-agency', nome: 'Dema Agency', url: 'https://www.dema-agency.ch/', tipo: 'sito', attiva: true, tutti_italiani: true },
];

export async function leggiFonti() {
  const r = await fetchT(`${SUPA_URL}/rest/v1/impostazioni?select=valore&chiave=eq.fonti_eventi`, { headers: supaHeaders });
  if (!r.ok) return { fonti: FONTI_PREDEFINITE, salvate: false };
  const righe = await r.json();
  const fonti = righe[0]?.valore?.fonti;
  return Array.isArray(fonti) && fonti.length ? { fonti, salvate: true } : { fonti: FONTI_PREDEFINITE, salvate: false };
}

// Riscrive solo l'esito dei controlli, rileggendo l'elenco appena prima:
// se nel frattempo qualcuno ha modificato le fonti dal gestionale, le sue
// modifiche restano.
export async function salvaEsiti(esiti) {
  const { fonti } = await leggiFonti();
  const aggiornate = fonti.map((f) => (esiti[f.id] ? { ...f, ultimo: esiti[f.id] } : f));
  const r = await fetchT(`${SUPA_URL}/rest/v1/impostazioni?on_conflict=chiave`, {
    method: 'POST',
    headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ chiave: 'fonti_eventi', valore: { fonti: aggiornate } }),
  });
  if (!r.ok) console.error(`  ✗ esiti fonti non salvati: ${r.status}`);
}

// Un sito si controlla una volta al giorno: al primo giro dopo le 5 UTC, oppure
// subito se non e' mai stato controllato o se l'ultimo tentativo e' fallito
// (al massimo un nuovo tentativo ogni 3 ore).
export function daControllare(f, adesso = new Date()) {
  if (f.tipo !== 'sito' || f.attiva === false || !f.url) return false;
  if (process.env.FORZA_SITI === '1') return true;
  const u = f.ultimo;
  if (!u?.data) return true;
  const ore = (adesso - new Date(u.data)) / 3600000;
  if (u.esito === 'errore') return ore >= 3;
  return u.data.slice(0, 10) < adesso.toISOString().slice(0, 10) && adesso.getUTCHours() >= 5;
}

const testoDa = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>/gi, ' [link:$1] ')
  .replace(/<img\s[^>]*src="([^"]+)"[^>]*>/gi, ' [img:$1] ')
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|article|section)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// Il browser si installa solo quando serve (una volta al giorno, per i siti
// Wix): installarlo a ogni giro orario costerebbe minuti di GitHub Actions.
async function caricaPlaywright() {
  try { return await import('playwright'); } catch {}
  if (!process.env.GITHUB_ACTIONS) return null;
  const { execSync } = await import('node:child_process');
  console.log('  · installo il browser headless per i siti in JavaScript');
  execSync('npm i --no-save --no-audit --no-fund playwright@1.48.2 && npx playwright install --with-deps chromium', { stdio: 'inherit', timeout: 240000 });
  return await import('playwright');
}

async function conBrowser(url) {
  const pw = await caricaPlaywright().catch(() => null);
  if (!pw) return null;
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function scaricaTesto(url) {
  const r = await fetchT(url, { headers: { 'Accept-Language': 'it,fr;q=0.8,de;q=0.7,en;q=0.6' } }, 30000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let testo = testoDa(await r.text());
  // pagina quasi vuota: eventi caricati in JavaScript
  if (testo.replace(/\[(link|img):[^\]]*\]/g, '').length < 600) {
    const html = await conBrowser(url);
    if (html) testo = testoDa(html);
    else if (testo.length < 600) throw new Error('pagina caricata in JavaScript, browser non disponibile');
  }
  return testo.slice(0, 60000);
}

const ISTRUZIONI = `Estrai dal testo di una pagina web gli eventi (concerti, spettacoli, teatro, comici, opera, festival) con una data precisa.
Rispondi SOLO con JSON: {"eventi":[{"artista":"...","nome":"titolo completo","data":"AAAA-MM-GG","ora":"HH:MM o null","citta":"...","venue":"sala o null","paese":"nome del paese in italiano o null","ticket_url":"link assoluto o null","img":"link assoluto immagine o null","descrizione":"max 300 caratteri o null","italiano":true/false}]}
Regole:
- Una riga per ogni data: un tour con tre date sono tre eventi.
- Salta gli eventi senza giorno preciso o senza citta.
- Anno mancante: il prossimo in cui la data cade nel futuro rispetto a OGGI.
- "italiano" e' true solo se l'artista principale, la compagnia o l'orchestra e' italiana, oppure se e' un tributo eseguito da artisti italiani. Un'opera di Verdi eseguita da un'orchestra svizzera e' false. Nel dubbio false.
- I link relativi vanno completati con l'indirizzo della pagina.
- Non inventare nulla che non sia nel testo.`;

async function estraiConClaude(testo, url, oggi) {
  if (!ANTHROPIC) throw new Error('ANTHROPIC_API_KEY mancante');
  const r = await fetchT('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODELLO,
      max_tokens: 16000,
      thinking: { type: 'disabled' },
      system: ISTRUZIONI,
      messages: [{ role: 'user', content: `OGGI: ${oggi}\nPAGINA: ${url}\n\n${testo}` }],
    }),
  }, 120000);
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const out = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('risposta senza JSON');
  return JSON.parse(m[0]).eventi || [];
}

const pulisci = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const assoluto = (u, base) => { try { return u ? new URL(u, base).href : null; } catch { return null; } };

export async function leggiSito(f, oggi) {
  const testo = await scaricaTesto(f.url);
  const grezzi = await estraiConClaude(testo, f.url, oggi);
  return grezzi
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.data || ''))
    .map((e) => {
      const ch = cittaSvizzera(e.citta);
      return {
        fonte: f.id,
        sourceId: `${e.data}|${e.nome}`,
        artista: pulisci(e.artista),
        nome: pulisci(e.nome) || pulisci(e.artista),
        dataIso: e.data,
        ora: /^\d{1,2}:\d{2}$/.test(e.ora || '') ? e.ora.padStart(5, '0') : null,
        citta: ch || pulisci(e.citta),
        paese: ch ? 'Svizzera' : pulisci(e.paese),
        venue: pulisci(e.venue),
        ticketUrl: assoluto(e.ticket_url, f.url) || f.url,
        img: assoluto(e.img, f.url),
        descrizione: pulisci(e.descrizione),
        organizzatore: f.nome,
        italiano: e.italiano === true,
        tuttiItaliani: !!f.tutti_italiani,
      };
    });
}

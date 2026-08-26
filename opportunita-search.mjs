// ============================================================
// opportunita-search.mjs — Ricerca opportunità commerciali per Tuttoitalia
// ============================================================
// Ogni giorno: Claude (API Anthropic, tool web_search) cerca lead pubblicitari
// freschi (concerti/cinema/eventi/viaggi/corsi/aperture italiane in CH) e li
// deposita nella tabella `opportunita` del pannello (my.tuttoitalia.ch/admin/opportunita).
// Gira come GitHub Action (egress libero) → scrive DIRETTO su Supabase REST,
// così supera il blocco di rete delle routine cloud.
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Flag: DRY_RUN=1 -> non scrive, mostra solo cosa troverebbe
// ============================================================

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = ['1', 'true'].includes(String(process.env.DRY_RUN));
const MODEL = process.env.OPP_MODEL || 'claude-sonnet-4-5';

if (!ANTHROPIC_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('✗ Missing env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const oggi = new Date().toISOString().slice(0, 10);
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };
const slug = (s) => (s || '').toString().toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const PROMPT = `Sei un ricercatore commerciale per Tuttoitalia GmbH, media company di Zurigo (tuttoitalia.ch, ~95k visitatori/mese) che vende pubblicità (articoli 4 lingue, newsletter ~28k iscritti, banner, social, concorsi) agli inserzionisti che vogliono raggiungere gli italiani in Svizzera. Oggi è ${oggi}.

Cerca sul web opportunità di business FRESCHE (eventi/uscite nei prossimi ~6 mesi, vendite/campagne in corso) nei filoni:
1. concerti/tour di artisti italiani in Svizzera (promoter Gadget abc Entertainment, Dema Agency, Live Nation Switzerland, Good News, All Blues; venue Volkshaus Zurigo, Hallenstadion; biglietterie Ticketcorner/Eventim).
2. film italiani in uscita nei cinema svizzeri (distributori Morandini/MFD, Xenix, Filmcoopi, Outside the Box, Cineworx; listino ProCinema).
3. eventi/festival italiani in CH (Ascona-Locarno, Expovina, IIC Zurigo, MCLI, Casa d'Italia).
4. viaggi verso l'Italia (FFS/Trenitalia EuroCity, ITA Airways, easyJet).
5. corsi di italiano / back-to-school (ECAP/MAECI, Dante Alighieri).
6. nuove aperture ristoranti/gastronomie italiane a Zurigo (GaultMillau, NZZ Bellevue, Falstaff).

Il potenziale CLIENTE è chi vende/organizza (promoter, distributore, azienda), NON l'artista o il film. IMPORTANTE: solo artisti/film/eventi ITALIANI o di forte interesse per il pubblico italiano in Svizzera (scarta artisti internazionali non italiani). Fai diverse ricerche web e verifica le fonti.

Rispondi ESCLUSIVAMENTE con un array JSON (nessun testo prima o dopo, nessun markdown), 5-15 oggetti con questi campi:
{"categoria": "concerti|cinema|eventi|viaggi|ristorazione|aziende|altro", "titolo": "nome cliente + aggancio", "descrizione": "cosa fa e perché rilevante ora", "evento_data": "data evento/uscita testo o null", "contatto": "sito ufficiale o email reale o null", "fonte_url": "link verificato realmente visto (obbligatorio)", "budget_min": intero CHF, "budget_max": intero CHF, "priorita": intero 1-5}
Budget col listino Tuttoitalia: articolo 100, newsletter 400, banner onda 3 settimane ~750, social 150; corporate/big 2000-5000, corsi 300-700. priorita 5 = alto valore e imminente.
Solo dati con fonte reale (niente fonte = scarta). Niente emoji, niente trattino em. Non ripetere lead notissimi già coperti a luglio 2026 (Morandini "Napoli-New York", Dema "D'Angelo/Pupo", Gadget "Pausini", Xenix due film).`;

async function callAnthropic(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
      messages,
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function cercaLead() {
  // Con web_search il modello può fermarsi in "pause_turn" dopo un blocco di
  // ricerche: si riprende rimandando la conversazione finché non chiude (end_turn).
  const messages = [{ role: 'user', content: PROMPT }];
  let data;
  for (let i = 0; i < 8; i++) {
    data = await callAnthropic(messages);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  const testo = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = testo.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`Nessun array JSON nella risposta (stop_reason=${data.stop_reason})`);
  return JSON.parse(m[0]);
}

function normalizza(raw) {
  const out = [];
  const CAT_OK = new Set(['concerti', 'cinema', 'eventi', 'viaggi', 'ristorazione', 'aziende', 'altro']);
  for (const o of raw) {
    const categoria = CAT_OK.has(o.categoria) ? o.categoria : 'altro';
    const titolo = String(o.titolo || '').trim();
    if (!titolo || !o.fonte_url) continue; // senza titolo o fonte non entra
    out.push({
      categoria,
      titolo,
      descrizione: o.descrizione || null,
      evento_data: o.evento_data || null,
      contatto: o.contatto || null,
      fonte_url: o.fonte_url,
      budget_min: Number.isFinite(o.budget_min) ? o.budget_min : null,
      budget_max: Number.isFinite(o.budget_max) ? o.budget_max : null,
      priorita: Number.isFinite(o.priorita) ? Math.min(5, Math.max(1, o.priorita)) : 3,
      stato: 'nuovo',
      dedup_key: `${categoria}-${slug(titolo)}`,
      trovato_il: oggi,
    });
  }
  // dedup interno per dedup_key
  const visti = new Set();
  return out.filter((o) => (visti.has(o.dedup_key) ? false : visti.add(o.dedup_key)));
}

// Chiavi già presenti: dedup_key + fonte_url (normalizzato). Il titolo cambia tra
// i giri → il solo dedup_key non basta; la fonte ufficiale è più stabile.
async function giaPresenti() {
  const r = await fetch(`${SUPA_URL}/rest/v1/opportunita?select=dedup_key,fonte_url`, { headers: supaHeaders });
  if (r.status === 404) return { keys: new Set(), fonti: new Set() }; // tabella non ancora creata
  if (!r.ok) throw new Error(`lettura opportunità ${r.status}`);
  const righe = await r.json();
  const normUrl = (u) => (u || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  return {
    keys: new Set(righe.map((x) => x.dedup_key)),
    fonti: new Set(righe.map((x) => normUrl(x.fonte_url)).filter(Boolean)),
  };
}

async function inserisci(righe) {
  const r = await fetch(`${SUPA_URL}/rest/v1/opportunita?on_conflict=dedup_key`, {
    method: 'POST',
    headers: { ...supaHeaders, Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(righe),
  });
  if (!r.ok) throw new Error(`inserimento opportunità ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const inserite = await r.json();
  return inserite.length;
}

(async () => {
  console.log(`▸ Ricerca opportunità (${oggi}, modello ${MODEL})${DRY_RUN ? ' [DRY_RUN]' : ''}`);
  const raw = await cercaLead();
  const tutte = normalizza(raw);
  // Scarta quelle già in tabella (per dedup_key o per fonte già presente).
  const { keys, fonti } = await giaPresenti();
  const normUrl = (u) => (u || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const righe = tutte.filter((o) => !keys.has(o.dedup_key) && !fonti.has(normUrl(o.fonte_url)));
  console.log(`  trovate ${tutte.length} valide, ${tutte.length - righe.length} già presenti → ${righe.length} nuove:`);
  for (const o of righe) console.log(`   · [${o.categoria}] ${o.titolo} — CHF ${o.budget_min}-${o.budget_max} (p${o.priorita})`);
  if (DRY_RUN) { console.log('  DRY_RUN: niente scritto.'); return; }
  const n = righe.length ? await inserisci(righe) : 0;
  console.log(`✓ Fatto — nuove inserite: ${n}`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });

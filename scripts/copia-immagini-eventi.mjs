// Copia sul nostro Hostpoint (https://media.tuttoitalia.ch/eventi/) le immagini degli eventi
// che stanno ancora su Base44 (si spegne il 25.10.2026) o sul vecchio CDN Webflow, e riscrive
// gli indirizzi nella tabella events. Locandine, foto e foto header: dopo lo spegnimento
// sparirebbero dalle schede evento e dalle anteprime dei link condivisi.
//
// Uso (dal PC, serve la chiave ssh di fd-hostpoint):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/copia-immagini-eventi.mjs            → solo conteggio
//   ... node scripts/copia-immagini-eventi.mjs --scarica                                             → copia i file sul server
//   ... node scripts/copia-immagini-eventi.mjs --scarica --aggiorna                                  → copia e riscrive il DB
// Si puo' rilanciare quante volte si vuole: i file gia' copiati non si riscaricano e le righe
// gia' riscritte non contengono piu' indirizzi da copiare.
//
// Il nome del file sul server e' quello dell'originale (Base44 e Webflow ci mettono gia' un
// codice univoco davanti): sync.js lo usa per capire che la nostra copia e' lo stesso file
// che Base44 continua a mandare. nomeCopia() deve restare identica a quella di sync.js.
import fs from 'fs'
import { spawnSync } from 'child_process'

const SUPA_URL = process.env.SUPABASE_URL
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPA_URL || !SUPA_KEY) { console.error('Mancano SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const H = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'content-type': 'application/json' }
const SCARICA = process.argv.includes('--scarica')
const AGGIORNA = process.argv.includes('--aggiorna')

const CAMPI = ['poster_url', 'immagine_url', 'immagine_header_upload', 'poster_url_2', 'dresscode_foto_url']
const DA_COPIARE = /^https?:\/\/(base44\.app|media\.base44\.com|qtrypzzcjebvfcihiynt\.supabase\.co|cdn\.prod\.website-files\.com|uploads-ssl\.webflow\.com)\//i
const BASE = 'https://media.tuttoitalia.ch/eventi/'
const CARTELLA = '~/www/media.tuttoitalia.ch/eventi'
const SSH = process.env.SSH_HOST || 'fd-hostpoint'

function nomeCopia(url) {
  let nome = ''
  try { nome = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') } catch { return '' }
  return nome.replace(/[^A-Za-z0-9._-]+/g, '-')
}

async function eventi() {
  const righe = []
  for (let da = 0; ; da += 1000) {
    const r = await fetch(`${SUPA_URL}/rest/v1/events?select=id,title,${CAMPI.join(',')}&order=id`, { headers: { ...H, Range: `${da}-${da + 999}` } })
    if (!r.ok) throw new Error(`lettura events: ${r.status} ${await r.text()}`)
    const j = await r.json()
    righe.push(...j)
    if (j.length < 1000) break
  }
  return righe
}

const righe = await eventi()
// nome sul server → indirizzo da cui scaricarlo (lo stesso file puo' comparire con piu' indirizzi:
// base44.app rimanda a media.base44.com, che e' lo stesso file del bucket base44-prod)
const daScaricare = new Map()
const usi = [] // { id, campo, vecchio, nome }
for (const e of righe) {
  for (const c of CAMPI) {
    const u = e[c]
    if (!u || !DA_COPIARE.test(u)) continue
    const nome = nomeCopia(u)
    if (!nome || !/\.(jpe?g|png|webp|gif|avif)$/i.test(nome)) { console.log(`  salto (nome senza estensione d'immagine): ${u}`); continue }
    if (!daScaricare.has(nome)) daScaricare.set(nome, u)
    usi.push({ id: e.id, campo: c, vecchio: u, nome })
  }
}
console.log(`Eventi letti: ${righe.length}. Indirizzi da copiare: ${usi.length} in ${new Set(usi.map(u => u.id)).size} eventi, file distinti: ${daScaricare.size}`)
if (!SCARICA) process.exit(0)

// --- Copia sul server: curl gira su Hostpoint, i file non passano da questo PC ---------------
const lista = [...daScaricare].map(([nome, url]) => `${nome}\t${url}`).join('\n')
const remoto = `set -u
mkdir -p ${CARTELLA} && cd ${CARTELLA} || exit 1
TAB=$(printf '\\t')
while IFS="$TAB" read -r nome url; do
  [ -n "$nome" ] || continue
  if [ -s "./$nome" ]; then echo "GIA $nome"; continue; fi
  if curl -sfL --max-time 90 --retry 2 -A "Mozilla/5.0 (compatible; TuttoItaliaBot/1.0)" -o "./$nome.tmp" "$url"; then
    tipo=$(file -b --mime-type "./$nome.tmp")
    case "$tipo" in
      image/*) mv "./$nome.tmp" "./$nome" && chmod 644 "./$nome" && echo "OK $nome $tipo" ;;
      *) rm -f "./$nome.tmp"; echo "NOIMG $nome $tipo" ;;
    esac
  else
    rm -f "./$nome.tmp"; echo "ERR $nome"
  fi
done <<'LISTA'
${lista}
LISTA
`
const r = spawnSync('ssh', ['-o', 'BatchMode=yes', SSH, 'sh -s'], { input: remoto, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
if (r.status !== 0) { console.error(r.stderr); process.exit(1) }
const esito = new Map()
for (const l of r.stdout.split('\n')) { const [stato, nome, ...resto] = l.split(' '); if (nome) esito.set(nome, { stato, info: resto.join(' ') }) }
const ok = new Set([...esito].filter(([, v]) => v.stato === 'OK' || v.stato === 'GIA').map(([n]) => n))
const conta = s => [...esito.values()].filter(v => v.stato === s).length
console.log(`Copia: ${conta('OK')} nuovi, ${conta('GIA')} gia' presenti, ${conta('ERR')} non scaricabili, ${conta('NOIMG')} non immagini`)
for (const [n, v] of esito) if (v.stato === 'ERR' || v.stato === 'NOIMG') console.log(`  ${v.stato} ${n} ← ${daScaricare.get(n)} ${v.info}`)
fs.writeFileSync('copia-immagini-eventi-esito.json', JSON.stringify(Object.fromEntries(esito), null, 1))
if (!AGGIORNA) process.exit(0)

// --- Riscrittura degli indirizzi nel DB: una PATCH per evento, solo per i file copiati -----
const perEvento = new Map()
for (const u of usi) {
  if (!ok.has(u.nome)) continue
  if (!perEvento.has(u.id)) perEvento.set(u.id, { vecchi: {}, nuovi: {} })
  const p = perEvento.get(u.id)
  p.vecchi[u.campo] = u.vecchio
  p.nuovi[u.campo] = BASE + u.nome
}
const backup = `backup-immagini-eventi-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`
fs.writeFileSync(backup, JSON.stringify(Object.fromEntries([...perEvento].map(([id, p]) => [id, p.vecchi])), null, 1))
console.log(`Valori vecchi salvati in ${backup}`)
let fatti = 0, saltati = 0, errori = 0
for (const [id, p] of perEvento) {
  // la condizione sui valori vecchi evita di sovrascrivere un'immagine cambiata nel frattempo
  const filtro = Object.entries(p.vecchi).map(([c, v]) => `&${c}=eq.${encodeURIComponent(v)}`).join('')
  const res = await fetch(`${SUPA_URL}/rest/v1/events?id=eq.${encodeURIComponent(id)}${filtro}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal, count=exact' }, body: JSON.stringify(p.nuovi),
  })
  const righeToccate = Number((res.headers.get('content-range') || '').split('/')[1] || 0)
  if (res.ok && righeToccate > 0) fatti++
  else if (res.ok) { saltati++; console.log(`  evento ${id}: immagine cambiata nel frattempo, lasciato com'e'`) }
  else { errori++; console.log(`  errore evento ${id}: ${res.status} ${await res.text()}`) }
}
console.log(`DB: ${fatti} eventi aggiornati, ${saltati} cambiati nel frattempo, ${errori} errori`)

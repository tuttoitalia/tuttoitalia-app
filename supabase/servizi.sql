-- ============================================================
-- servizi.sql: struttura comune ai servizi TuttoItalia (piano 2027)
-- ============================================================
-- Un solo modello per tutti gli 8 servizi (tasse, casa, salute, lavoro,
-- primi passi, cassa malati, sapori, previdenza). Un servizio nuovo = una riga
-- in `servizi` con le sue `categorie`, non tabelle o codice nuovi.
--
--   servizi ─┬─ categorie ─┬─ schede ─┬─ recensioni
--            │             │          └─ richieste_contatto
--            │             └─ schede_proposte (coda: la ricerca propone, una persona approva)
--            ├─ guide
--            ├─ scadenze
--            └─ partner_contratti ── partner
--
-- Da eseguire una volta nell'editor SQL di Supabase. Idempotente: si puo'
-- rilanciare senza danni (IF NOT EXISTS, ON CONFLICT DO NOTHING).
-- Lettura pubblica solo di cio' che e' pubblicato; il resto passa dalla
-- service role (pannello admin e script), che salta la RLS.
-- ============================================================

create extension if not exists pgcrypto;

-- ─── Servizi ────────────────────────────────────────────────
create table if not exists servizi (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  nome          text not null,
  descrizione   text,
  ordine        int  not null default 0,
  data_lancio   date,
  stato         text not null default 'bozza'
                check (stato in ('bozza', 'in_preparazione', 'lanciato', 'pausa')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─── Categorie (fiduciari, dentisti, agenzie immobiliari...) ─
create table if not exists categorie (
  id              uuid primary key default gen_random_uuid(),
  servizio_id     uuid not null references servizi(id) on delete cascade,
  slug            text not null,
  nome            text not null,
  -- Indicazione per la ricerca automatica: chi cercare e dove.
  ricerca_hint    text,
  ultima_ricerca  timestamptz,   -- la ricerca ruota partendo dalla meno recente
  ordine          int not null default 0,
  unique (servizio_id, slug)
);

-- ─── Partner commerciali ────────────────────────────────────
create table if not exists partner (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  referente   text,
  email       text,
  telefono    text,
  sito        text,
  stato       text not null default 'contatto'
              check (stato in ('contatto', 'trattativa', 'attivo', 'chiuso')),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists partner_contratti (
  id           uuid primary key default gen_random_uuid(),
  partner_id   uuid not null references partner(id) on delete cascade,
  servizio_id  uuid references servizi(id) on delete set null,
  tipo         text not null
               check (tipo in ('scheda_premium', 'articolo', 'banner', 'newsletter', 'contatti', 'altro')),
  importo_chf  numeric(10,2),
  inizio       date not null,
  fine         date,
  note         text,
  created_at   timestamptz not null default now()
);

-- ─── Schede (professionisti, aziende, negozi, enti) ─────────
create table if not exists schede (
  id             uuid primary key default gen_random_uuid(),
  categoria_id   uuid not null references categorie(id) on delete restrict,
  slug           text not null unique,
  dedup_key      text not null unique,   -- dominio del sito oppure nome+cap
  nome           text not null,
  tipo           text not null default 'professionista'
                 check (tipo in ('professionista', 'azienda', 'negozio', 'ristorante', 'ente', 'associazione')),
  descrizione    text,
  indirizzo      text,
  cap            text,
  citta          text,
  cantone        text check (cantone is null or length(cantone) = 2),   -- sigla: ZH, TI, GE...
  lat            double precision,
  lng            double precision,
  telefono       text,
  email          text,
  sito           text,
  lingue         text[] not null default array['it'],
  -- Verifica umana obbligatoria prima della pubblicazione.
  verificata     boolean not null default false,
  verificata_il  date,
  verificata_da  text,
  pubblicata     boolean not null default false,
  premium        boolean not null default false,
  premium_fino   date,
  partner_id     uuid references partner(id) on delete set null,
  fonte_url      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint pubblicata_solo_se_verificata check (not pubblicata or verificata)
);
create index if not exists schede_categoria_idx on schede (categoria_id) where pubblicata;
create index if not exists schede_cantone_idx   on schede (cantone) where pubblicata;

-- ─── Coda delle schede proposte dalla ricerca automatica ────
create table if not exists schede_proposte (
  id            uuid primary key default gen_random_uuid(),
  categoria_id  uuid not null references categorie(id) on delete cascade,
  dedup_key     text not null unique,
  nome          text not null,
  tipo          text,
  descrizione   text,
  indirizzo     text,
  cap           text,
  citta         text,
  cantone       text,
  telefono      text,
  email         text,
  sito          text,
  lingue        text[],
  fonte_url     text not null,          -- senza fonte verificabile non entra
  motivo        text,                   -- perche' risulta italofono
  stato         text not null default 'in_attesa'
                check (stato in ('in_attesa', 'approvata', 'scartata')),
  scheda_id     uuid references schede(id) on delete set null,
  trovata_il    date not null default current_date,
  created_at    timestamptz not null default now()
);
create index if not exists schede_proposte_stato_idx on schede_proposte (stato);

-- ─── Guide pratiche ─────────────────────────────────────────
create table if not exists guide (
  id               uuid primary key default gen_random_uuid(),
  servizio_id      uuid not null references servizi(id) on delete cascade,
  slug             text not null unique,
  titolo           text not null,
  sommario         text,
  corpo            text,                -- markdown
  cantoni          text[],              -- null = vale per tutta la Svizzera
  fonti            text[] not null default '{}',
  stato            text not null default 'bozza'
                   check (stato in ('bozza', 'in_revisione', 'pubblicata')),
  pubblicata_il    date,
  -- Le regole cambiano ogni anno: ogni guida ha una data di ricontrollo.
  ricontrollo_entro date,
  sponsor_id       uuid references partner(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ─── Scadenze (scadenzario per cantone) ─────────────────────
create table if not exists scadenze (
  id                  uuid primary key default gen_random_uuid(),
  servizio_id         uuid not null references servizi(id) on delete cascade,
  titolo              text not null,
  descrizione         text,
  cantone             text,             -- null = tutta la Svizzera
  data                date not null,
  ricorrente_annuale  boolean not null default true,
  guida_id            uuid references guide(id) on delete set null,
  fonte_url           text,
  created_at          timestamptz not null default now()
);
create index if not exists scadenze_data_idx on scadenze (data);

-- ─── Italiani all'estero: famiglia del servizio e paese ─────
-- "italia" = pratiche verso l'Italia, valgono in qualunque paese (AIRE, passaporto,
-- IMU...); "paese" = vita quotidiana nel paese dove si abita; "entrambe" = misto.
-- Oggi il paese e' sempre la Svizzera: il campo c'e' per crescere senza migrazioni.
alter table servizi  add column if not exists ambito text not null default 'paese'
  check (ambito in ('italia', 'paese', 'entrambe'));
alter table schede   add column if not exists paese text not null default 'CH'
  check (length(paese) = 2);                     -- ISO 3166: CH, DE, FR, IT...
alter table schede_proposte add column if not exists paese text not null default 'CH';
alter table guide    add column if not exists paesi text[];   -- null = vale ovunque
alter table scadenze add column if not exists paese text;     -- null = vale ovunque (scadenze italiane)
create index if not exists schede_paese_idx on schede (paese) where pubblicata;

-- ─── Paesi: dove sono aperti i servizi "vivere nel paese" ────
-- Si apre un paese passando lo stato a 'in_preparazione' (la ricerca automatica
-- comincia a proporre schede) e poi ad 'attivo' (visibile sul sito).
create table if not exists paesi (
  codice          text primary key check (length(codice) = 2),   -- ISO 3166
  nome            text not null,
  ordine          int  not null default 0,
  stato           text not null default 'bozza'
                  check (stato in ('bozza', 'in_preparazione', 'attivo')),
  citta           text[] not null default '{}',   -- citta' prioritarie per la ricerca
  termini_ricerca text,                           -- come si dice "parla italiano" nella lingua locale
  created_at      timestamptz not null default now()
);

insert into paesi (codice, nome, ordine, stato, citta, termini_ricerca) values
  ('CH', 'Svizzera',    1, 'attivo', array['Zurigo','Basilea','Berna','Ginevra','Losanna','San Gallo','Lucerna'], 'italienisch sprechend, parle italien'),
  ('DE', 'Germania',    2, 'bozza',  array['Monaco di Baviera','Stoccarda','Francoforte','Berlino','Colonia','Amburgo'], 'italienisch sprechend, spricht Italienisch'),
  ('FR', 'Francia',     3, 'bozza',  array['Parigi','Lione','Marsiglia','Grenoble','Nizza'], 'parle italien, italophone'),
  ('BE', 'Belgio',      4, 'bozza',  array['Bruxelles','Liegi','Charleroi','Anversa'], 'parle italien, spreekt Italiaans'),
  ('GB', 'Regno Unito', 5, 'bozza',  array['Londra','Manchester','Edimburgo','Birmingham'], 'Italian speaking'),
  ('ES', 'Spagna',      6, 'bozza',  array['Madrid','Barcellona','Valencia','Malaga'], 'habla italiano')
on conflict (codice) do nothing;

-- Categorie valide solo in alcuni paesi (null = in tutti).
alter table categorie add column if not exists paesi text[];

-- Rotazione della ricerca automatica per coppia categoria + paese.
create table if not exists ricerche (
  categoria_id    uuid not null references categorie(id) on delete cascade,
  paese           text not null references paesi(codice) on delete cascade,
  ultima_ricerca  timestamptz not null default now(),
  primary key (categoria_id, paese)
);

-- La regione non e' piu' solo il cantone: Land, regione, contea (2-3 lettere).
alter table schede drop constraint if exists schede_cantone_check;
alter table schede add constraint schede_cantone_check
  check (cantone is null or length(cantone) between 2 and 3);
comment on column schede.cantone is 'Regione del paese: cantone in Svizzera, Land in Germania... (sigla ISO 3166-2 senza prefisso)';

-- ─── Recensioni della comunita' ─────────────────────────────
create table if not exists recensioni (
  id          uuid primary key default gen_random_uuid(),
  scheda_id   uuid not null references schede(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  voto        int not null check (voto between 1 and 5),
  testo       text,
  stato       text not null default 'in_attesa'
              check (stato in ('in_attesa', 'approvata', 'rifiutata')),
  created_at  timestamptz not null default now(),
  unique (scheda_id, user_id)
);

-- ─── Richieste di contatto (i "lead" da girare alle schede) ─
create table if not exists richieste_contatto (
  id          uuid primary key default gen_random_uuid(),
  scheda_id   uuid not null references schede(id) on delete cascade,
  nome        text not null,
  email       text not null,
  telefono    text,
  messaggio   text,
  consenso    boolean not null check (consenso),   -- consenso esplicito a inoltrare i dati
  inoltrata   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ─── updated_at automatico ──────────────────────────────────
create or replace function tocca_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['servizi', 'partner', 'schede', 'guide'] loop
    execute format('drop trigger if exists %I_updated_at on %I', t, t);
    execute format('create trigger %I_updated_at before update on %I for each row execute function tocca_updated_at()', t, t);
  end loop;
end $$;

-- ─── Sicurezza (RLS) ────────────────────────────────────────
alter table servizi            enable row level security;
alter table categorie          enable row level security;
alter table partner            enable row level security;
alter table partner_contratti  enable row level security;
alter table schede             enable row level security;
alter table schede_proposte    enable row level security;
alter table guide              enable row level security;
alter table scadenze           enable row level security;
alter table recensioni         enable row level security;
alter table richieste_contatto enable row level security;
alter table paesi              enable row level security;
alter table ricerche           enable row level security;

-- partner, partner_contratti, schede_proposte, ricerche: nessuna policy = solo service role.

drop policy if exists paesi_lettura on paesi;
create policy paesi_lettura on paesi for select
  using (stato = 'attivo');

drop policy if exists servizi_lettura on servizi;
create policy servizi_lettura on servizi for select
  using (stato = 'lanciato');

drop policy if exists categorie_lettura on categorie;
create policy categorie_lettura on categorie for select
  using (exists (select 1 from servizi s where s.id = servizio_id and s.stato = 'lanciato'));

drop policy if exists schede_lettura on schede;
create policy schede_lettura on schede for select
  using (pubblicata);

drop policy if exists guide_lettura on guide;
create policy guide_lettura on guide for select
  using (stato = 'pubblicata');

drop policy if exists scadenze_lettura on scadenze;
create policy scadenze_lettura on scadenze for select
  using (exists (select 1 from servizi s where s.id = servizio_id and s.stato = 'lanciato'));

drop policy if exists recensioni_lettura on recensioni;
create policy recensioni_lettura on recensioni for select
  using (stato = 'approvata' or user_id = auth.uid());

drop policy if exists recensioni_scrittura on recensioni;
create policy recensioni_scrittura on recensioni for insert to authenticated
  with check (user_id = auth.uid() and stato = 'in_attesa');

drop policy if exists richieste_invio on richieste_contatto;
create policy richieste_invio on richieste_contatto for insert to anon, authenticated
  with check (consenso and not inoltrata
              and exists (select 1 from schede s where s.id = scheda_id and s.pubblicata));

-- ─── Dati iniziali: gli 8 servizi del 2027 con le categorie ─
insert into servizi (slug, nome, ordine, data_lancio, stato, ambito, descrizione) values
  ('tasse-burocrazia', 'Tasse e burocrazia',     1, '2027-01-26', 'in_preparazione', 'paese', 'Dichiarazione d''imposta, permessi, scadenze; fiduciari e patronati che parlano italiano.'),
  ('casa',             'Casa',                   2, '2027-03-09', 'bozza', 'paese', 'Trovare e tenere un alloggio in Svizzera: affitto, contratti, traslochi.'),
  ('salute',           'Salute',                 3, '2027-04-27', 'bozza', 'paese', 'Medici, dentisti e psicologi che parlano italiano; la LAMal spiegata semplice.'),
  ('lavoro',           'Lavoro',                 4, '2027-06-08', 'bozza', 'paese', 'Offerte mirate, riconoscimento dei titoli, candidature in stile svizzero.'),
  ('primi-passi',      'Primi passi in Svizzera',5, '2027-07-20', 'bozza', 'entrambe', 'Tutto quello che serve nei primi tre mesi: permesso, comune, AIRE, conto, telefono.'),
  ('cassa-malati',     'Cassa malati',           6, '2027-08-31', 'bozza', 'paese', 'Capire premi e franchigie, cambiare cassa entro le scadenze.'),
  ('sapori',           'Sapori d''Italia',       7, '2027-10-12', 'bozza', 'paese', 'Negozi, gastronomie e ristoranti italiani verificati dalla comunità.'),
  ('previdenza',       'Previdenza',             8, '2027-11-23', 'bozza', 'entrambe', 'AVS, secondo e terzo pilastro, pensioni italiane, rientro in Italia.'),
  -- 2028: date da fissare a settembre 2027
  ('pratiche-italiane','Pratiche italiane dall''estero', 9, null, 'bozza', 'italia',   'Passaporto, carta d''identità, voto, certificati: il rapporto con l''Italia da lontano.'),
  ('famiglia-scuola',  'Famiglia e scuola',     10, null, 'bozza', 'entrambe', 'Corsi di italiano per i figli, scuole, cittadinanza dei figli.'),
  ('casa-in-italia',   'Casa in Italia',        11, null, 'bozza', 'italia',   'IMU, affitto o vendita, successioni per chi ha una casa in Italia.'),
  ('viaggi-spedizioni','Viaggi e spedizioni',   12, null, 'bozza', 'entrambe', 'Treni, voli, pacchi e traslochi verso l''Italia.'),
  ('documenti',        'Documenti',             13, null, 'bozza', 'entrambe', 'Traduzioni giurate, apostille, conversione della patente.'),
  ('rientro',          'Rientro in Italia',     14, null, 'bozza', 'italia',   'Agevolazioni fiscali, trasloco, iscrizione al servizio sanitario.'),
  ('comunita',         'Comunità',              15, null, 'bozza', 'entrambe', 'Associazioni, volontariato, aiuto reciproco.')
on conflict (slug) do nothing;

insert into categorie (servizio_id, slug, nome, ordine, ricerca_hint)
select s.id, c.slug, c.nome, c.ordine, c.hint
from servizi s
join (values
  ('tasse-burocrazia', 'fiduciari',          'Fiduciari e consulenti fiscali', 1, 'fiduciari, Treuhand, consulenti fiscali che offrono consulenza in italiano'),
  ('tasse-burocrazia', 'patronati',          'Patronati',                      2, 'patronati italiani in Svizzera (INCA, ACLI, ITAL-UIL, INAS) e loro sedi'),
  ('tasse-burocrazia', 'avvocati',           'Avvocati',                       3, 'avvocati iscritti all''albo cantonale che parlano italiano'),
  ('casa',             'agenzie-immobiliari','Agenzie immobiliari',            1, 'agenzie immobiliari e amministrazioni con personale italofono'),
  ('casa',             'traslochi',          'Traslochi',                      2, 'ditte di trasloco, anche Italia-Svizzera, con servizio in italiano'),
  ('casa',             'artigiani',          'Artigiani',                      3, 'idraulici, elettricisti, imbianchini titolari italiani o italofoni'),
  ('salute',           'medici-famiglia',    'Medici di famiglia',             1, 'medici di base (Hausarzt) che visitano in italiano'),
  ('salute',           'dentisti',           'Dentisti',                       2, 'studi dentistici con dentisti o personale italofono'),
  ('salute',           'psicologi',          'Psicologi e psicoterapeuti',     3, 'psicologi e psicoterapeuti riconosciuti che lavorano in italiano'),
  ('salute',           'pediatri',           'Pediatri',                       4, 'pediatri che parlano italiano'),
  ('lavoro',           'agenzie-lavoro',     'Agenzie per il lavoro',          1, 'agenzie di collocamento con consulenti italofoni'),
  ('lavoro',           'formazione',         'Corsi e formazione',             2, 'corsi di tedesco o francese per italofoni, ECAP, formazione professionale'),
  ('primi-passi',      'consolati-enti',     'Consolati ed enti',              1, 'consolati, Comites, sportelli per italiani all''estero'),
  ('primi-passi',      'associazioni',       'Associazioni',                   2, 'associazioni e missioni cattoliche italiane, circoli regionali, patronati'),
  ('cassa-malati',     'consulenti-assicurativi','Consulenti assicurativi',    1, 'intermediari assicurativi registrati FINMA che consigliano in italiano'),
  ('sapori',           'negozi-alimentari',  'Negozi alimentari',              1, 'negozi e importatori di prodotti alimentari italiani'),
  ('sapori',           'gastronomie',        'Gastronomie e panetterie',       2, 'gastronomie, salumerie, panetterie e pasticcerie italiane'),
  ('sapori',           'ristoranti',         'Ristoranti',                     3, 'ristoranti e pizzerie a gestione italiana'),
  ('previdenza',       'consulenti-previdenza','Consulenti previdenziali',     1, 'consulenti per AVS, pilastri e pensioni Italia-Svizzera che parlano italiano')
) as c(servizio, slug, nome, ordine, hint) on c.servizio = s.slug
on conflict (servizio_id, slug) do nothing;

-- La cassa malati di base e' un sistema svizzero: la categoria vale solo in CH.
update categorie set paesi = array['CH']
where slug = 'consulenti-assicurativi' and paesi is null;

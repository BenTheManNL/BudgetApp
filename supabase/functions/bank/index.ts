// Duppie: bankkoppeling via Enable Banking.
// Draait als Supabase Edge Function "bank". Werkt alleen voor accounts waarbij in de tabel profielen "bank" aan staat.
// Nodige secrets: EB_APP_ID (Application ID) en EB_PRIVATE_KEY (de inhoud van het .pem-bestand).
// Zet bij deze functie "Verify JWT" UIT: de functie controleert zelf wie je bent (de terugkeer van de bank
// gebeurt soms in een browser waar je niet bent ingelogd).

const EB = 'https://api.enablebanking.com';
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('DUPPIE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const APP_ID = Deno.env.get('EB_APP_ID') ?? '';
const PEM = Deno.env.get('EB_PRIVATE_KEY') ?? '';
const TERUG = 'https://benthemannl.github.io/BudgetApp/';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const antwoord = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

class Fout extends Error {
  status: number;
  constructor(bericht: string, status = 500) { super(bericht); this.status = status; }
}

// ---------- Enable Banking: elk verzoek krijgt een JWT, ondertekend met je privésleutel ----------
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlTekst = (s: string) => b64url(new TextEncoder().encode(s));
let sleutel: CryptoKey | null = null;
async function maakJwt(): Promise<string> {
  if (!sleutel) {
    if (/BEGIN RSA PRIVATE KEY/.test(PEM)) throw new Fout('De sleutel is in het oude PKCS#1-formaat. Gebruik de sleutel zoals Enable Banking hem in de browser maakte (BEGIN PRIVATE KEY).');
    const der = Uint8Array.from(atob(PEM.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    sleutel = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  }
  const nu = Math.floor(Date.now() / 1000);
  const kop = b64urlTekst(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: APP_ID }));
  const inhoud = b64urlTekst(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: nu, exp: nu + 3600 }));
  const handtekening = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', sleutel, new TextEncoder().encode(kop + '.' + inhoud));
  return kop + '.' + inhoud + '.' + b64url(new Uint8Array(handtekening));
}
async function eb(pad: string, opties: { method?: string; body?: unknown } = {}) {
  const r = await fetch(EB + pad, {
    method: opties.method ?? 'GET',
    headers: { Authorization: 'Bearer ' + (await maakJwt()), 'Content-Type': 'application/json' },
    body: opties.body === undefined ? undefined : JSON.stringify(opties.body),
  });
  const tekst = await r.text();
  if (!r.ok) throw new Fout('Enable Banking (' + r.status + '): ' + tekst.slice(0, 300), r.status);
  return tekst ? JSON.parse(tekst) : null;
}

// ---------- Supabase: de database en wie er is ingelogd ----------
const dbKop = (): Record<string, string> => ({
  apikey: SERVICE,
  'Content-Type': 'application/json',
  ...(SERVICE.startsWith('ey') ? { Authorization: 'Bearer ' + SERVICE } : {}),
});
async function db(pad: string, opties: { method?: string; body?: unknown; prefer?: string } = {}) {
  const kop = dbKop();
  if (opties.prefer) kop.Prefer = opties.prefer;
  const r = await fetch(SB_URL + '/rest/v1/' + pad, {
    method: opties.method ?? 'GET', headers: kop,
    body: opties.body === undefined ? undefined : JSON.stringify(opties.body),
  });
  const tekst = await r.text();
  if (!r.ok) throw new Fout('Database (' + r.status + '): ' + tekst.slice(0, 300));
  return tekst ? JSON.parse(tekst) : null;
}
async function wieIsHet(req: Request): Promise<{ id: string } | null> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SERVICE, Authorization: 'Bearer ' + token } });
  return r.ok ? await r.json() : null;
}

// Welke rekening is je betaalrekening? Een "CACC" (current account) heeft voorrang.
type Rekening = { uid: string; iban: string; naam: string; soort: string };
const betaalrekening = (lijst: Rekening[]) => lijst.find((r) => r.soort === 'CACC') ?? lijst[0];
// Welk saldo is het beste? Eerst "beschikbaar nu", daarna de andere soorten.
const SALDO_VOORKEUR = ['ITAV', 'CLAV', 'XPCD', 'ITBD', 'CLBD', 'OPAV', 'PRCD'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!SB_URL || !SERVICE || !APP_ID || !PEM) return antwoord({ fout: 'De bankkoppeling is nog niet ingesteld: er ontbreken secrets in Supabase.' }, 500);
    const body = await req.json().catch(() => ({}));

    // Terug van de bank. Werkt ook zonder ingelogd te zijn: de geheime "state" wijst het account aan.
    if (body.actie === 'sessie') {
      if (!/^[a-f0-9]{32}$/.test(String(body.state ?? '')) || !body.code) return antwoord({ fout: 'Deze link klopt niet.' }, 400);
      const rij = (await db('bank_sessies?state=eq.' + body.state + '&select=user_id'))[0];
      if (!rij) return antwoord({ fout: 'Deze koppeling is verlopen of al gebruikt. Probeer het opnieuw vanuit Duppie.' }, 400);
      const s = await eb('/sessions', { method: 'POST', body: { code: String(body.code) } });
      const rekeningen: Rekening[] = (s.accounts ?? []).map((a: any) => ({
        uid: a.uid, iban: a.account_id?.iban ?? '', naam: a.name ?? a.product ?? '', soort: a.cash_account_type ?? '',
      }));
      await db('bank_sessies?user_id=eq.' + rij.user_id, {
        method: 'PATCH',
        body: { state: null, session_id: s.session_id, rekeningen, geldig_tot: s.access?.valid_until ?? null, bijgewerkt: new Date().toISOString() },
      });
      return antwoord({ ok: true, aantal: rekeningen.length });
    }

    // Alle andere acties: alleen jij, ingelogd, met de bankkoppeling aan
    const gebruiker = await wieIsHet(req);
    if (!gebruiker) return antwoord({ fout: 'Log eerst in bij Duppie.' }, 401);
    const profiel = (await db('profielen?user_id=eq.' + gebruiker.id + '&select=bank'))[0];
    if (!profiel || profiel.bank !== true) return antwoord({ fout: 'De bankkoppeling staat niet aan voor dit account.' }, 403);

    if (body.actie === 'start') {
      // Zoek ING op en vraag zo lang mogelijk toestemming (de bank bepaalt het maximum)
      const banken = (await eb('/aspsps?country=NL&psu_type=personal')).aspsps ?? [];
      const ing = banken.find((b: any) => /^ING\b/i.test(b.name));
      if (!ing) return antwoord({ fout: 'ING staat niet in de lijst van Enable Banking.' }, 502);
      const maxSec = Math.min(Number(ing.maximum_consent_validity) || 90 * 86400, 180 * 86400);
      const geldigTot = new Date(Date.now() + maxSec * 1000 - 3600 * 1000).toISOString();
      const state = crypto.randomUUID().replace(/-/g, '');
      await db('bank_sessies?on_conflict=user_id', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: { user_id: gebruiker.id, state, bijgewerkt: new Date().toISOString() },
      });
      const a = await eb('/auth', {
        method: 'POST',
        body: { access: { valid_until: geldigTot }, aspsp: { name: ing.name, country: 'NL' }, state, redirect_url: TERUG, psu_type: 'personal' },
      });
      return antwoord({ url: a.url });
    }

    if (body.actie === 'saldo') {
      const rij = (await db('bank_sessies?user_id=eq.' + gebruiker.id + '&select=session_id,rekeningen,geldig_tot'))[0];
      const verlopen = !rij || !rij.session_id || (rij.geldig_tot && new Date(rij.geldig_tot) < new Date());
      const rek = rij && betaalrekening(rij.rekeningen ?? []);
      if (verlopen || !rek) return antwoord({ koppelen: true });
      try {
        const lijst = ((await eb('/accounts/' + rek.uid + '/balances')).balances ?? []) as any[];
        if (!lijst.length) return antwoord({ fout: 'ING gaf geen saldo terug.' }, 502);
        const plek = (b: any) => { const i = SALDO_VOORKEUR.indexOf(b.balance_type); return i < 0 ? 99 : i; };
        lijst.sort((x, y) => plek(x) - plek(y));
        const best = lijst[0];
        return antwoord({
          bedrag: Number(best.balance_amount?.amount), valuta: best.balance_amount?.currency ?? 'EUR', soort: best.balance_type,
          iban: rek.iban, geldig_tot: rij.geldig_tot,
        });
      } catch (e) {
        // Toestemming ingetrokken of verlopen: opnieuw koppelen
        if (e instanceof Fout && [401, 403, 422].includes(e.status)) return antwoord({ koppelen: true });
        throw e;
      }
    }

    return antwoord({ fout: 'Onbekende actie.' }, 400);
  } catch (e) {
    console.error(e);
    return antwoord({ fout: e instanceof Error ? e.message : String(e) }, 500);
  }
});

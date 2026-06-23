/* =====================================================================
   WishTvTime — Proxy métadonnées JEUX (Cloudflare Worker, gratuit)
   ---------------------------------------------------------------------
   Pourquoi : l'API Steam (et IGDB) n'autorise pas les appels directs
   depuis un navigateur (CORS). Les proxys publics sont morts ou payants.
   Ce petit Worker est TON proxy perso : fiable, gratuit, permanent.
   Il interroge IGDB (la base de Playnite) si tu fournis des identifiants
   Twitch ; sinon il bascule automatiquement sur Steam.

   ─────────────────────────────────────────────────────────────────────
   DÉPLOIEMENT (≈5 min, sans carte bancaire)
   1. Crée un compte gratuit sur https://dash.cloudflare.com/sign-up
   2. Menu « Workers & Pages » → « Create » → « Create Worker »
   3. Donne un nom (ex. wishtvtime-proxy) → « Deploy »
   4. Clique « Edit code », EFFACE tout, COLLE ce fichier en entier, « Deploy »
   5. Ton URL apparaît en haut (ex. https://wishtvtime-proxy.TONPSEUDO.workers.dev)
      → colle-la dans l'app : ⚙️ Paramètres → « Proxy jeux (URL) »

   (Optionnel) ACTIVER IGDB — meilleures données + superbes jaquettes :
   6. Va sur https://dev.twitch.tv/console/apps → « Register Your Application »
      - Name : wishtvtime (peu importe)
      - OAuth Redirect URLs : http://localhost
      - Category : Application Integration  → « Create »
   7. Ouvre l'app créée → note le « Client ID », clique « New Secret » → note le secret
   8. Dans le Worker : onglet « Settings » → « Variables and Secrets » →
      ajoute deux variables :
        TWITCH_ID     = ton Client ID
        TWITCH_SECRET = ton secret
      → « Deploy ». C'est tout : le Worker utilisera IGDB automatiquement.
   (Si tu ne fais pas les étapes 6-8, le Worker marche quand même, via Steam.)
   ===================================================================== */

const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';

function withCORS(resp){
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  return new Response(resp.body, { status: resp.status, headers: h });
}
function json(obj, status = 200){
  return withCORS(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
}

// ---- Proxy d'images : /img?url=… ----
// Récupère une image côté serveur (pas de CORS navigateur, contourne les blocages de proxys publics
// comme AniList) et la renvoie avec les en-têtes CORS. Réservé aux images http/https.
async function imgProxy(url){
  const target = url.searchParams.get('url');
  if(!target) return json({ error: 'paramètre url manquant' }, 400);
  let t; try{ t = new URL(target); }catch(e){ return json({ error: 'url invalide' }, 400); }
  if(t.protocol !== 'http:' && t.protocol !== 'https:') return json({ error: 'protocole non autorisé' }, 400);
  // Referer = domaine racine de la source (contourne les protections « hotlink » de certains CDN, ex. AniList).
  const root = t.hostname.split('.').slice(-2).join('.');
  const r = await fetch(target, { headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
    'Referer': t.protocol + '//' + root + '/',
  } });
  if(!r.ok) return json({ error: 'upstream ' + r.status, target }, 502);
  const ct = r.headers.get('Content-Type') || 'image/jpeg';
  if(!ct.startsWith('image')) return json({ error: 'la cible n\'est pas une image (' + ct + ')' }, 415);
  const h = new Headers();
  h.set('Content-Type', ct);
  h.set('Cache-Control', 'public, max-age=86400');
  h.set('Access-Control-Allow-Origin', '*');
  return new Response(r.body, { status: 200, headers: h });
}

export default {
  async fetch(req, env){
    if(req.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }));
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    try{
      if(path.endsWith('/games'))     return await searchGames(url, env);
      if(path.endsWith('/steam/app')) return await steamApp(url);
      if(path.endsWith('/dlc'))       return await gameDlc(url, env);
      if(path.endsWith('/img'))       return await imgProxy(url);
      return json({ ok: true, msg: 'WishTvTime proxy. Endpoints : /games?q=…  ·  /steam/app?appid=…  ·  /dlc?steam=APPID | ?slug=IGDB_SLUG  ·  /img?url=…' });
    }catch(e){
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};

// ---- Recherche : IGDB si configuré, sinon Steam ----
// Paramètre optionnel ?src=steam|igdb pour FORCER une source (tests). Défaut : auto.
async function searchGames(url, env){
  const q = url.searchParams.get('q') || '';
  const src = url.searchParams.get('src') || 'auto';
  if(!q) return json({ items: [] });
  const hasIgdb = !!(env.TWITCH_ID && env.TWITCH_SECRET);

  if(src === 'steam') return json({ source: 'steam', items: await steamSearch(q) });
  if(src === 'igdb'){
    if(!hasIgdb) return json({ source: 'igdb', error: 'IGDB non configuré (TWITCH_ID/TWITCH_SECRET manquants)', items: [] });
    return json({ source: 'igdb', items: await igdbSearch(q, env) });
  }
  // auto : IGDB si configuré ET s'il trouve des résultats ; sinon repli Steam
  if(hasIgdb){
    try{
      const items = await igdbSearch(q, env);
      if(items.length) return json({ source: 'igdb', items });
      // IGDB n'a rien trouvé → on tente Steam
    }catch(e){ /* IGDB en échec → on bascule sur Steam */ }
  }
  return json({ source: 'steam', items: await steamSearch(q) });
}

// ---- IGDB (via OAuth Twitch, jeton mis en cache en mémoire du Worker) ----
let _tok = { v: '', exp: 0 };
async function igdbToken(env){
  if(_tok.v && Date.now() < _tok.exp) return _tok.v;
  const r = await fetch('https://id.twitch.tv/oauth2/token?client_id=' + env.TWITCH_ID +
    '&client_secret=' + env.TWITCH_SECRET + '&grant_type=client_credentials', { method: 'POST' });
  const d = await r.json();
  if(!d.access_token) throw new Error('Twitch OAuth échec');
  _tok = { v: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return _tok.v;
}
// Catégories IGDB à écarter : 1=DLC, 3=bundle, 13=pack, 14=update (pas de « vrais » jeux).
const IGDB_SKIP_CAT = new Set([1, 3, 13, 14]);
const IGDB_FIELDS = 'fields name,first_release_date,summary,genres.name,platforms.name,cover.image_id,category,url,total_rating,total_rating_count;';
async function igdbSearch(q, env){
  const tok = await igdbToken(env);
  const headers = { 'Client-ID': env.TWITCH_ID, 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
  const run = async (body) => {
    const r = await fetch('https://api.igdb.com/v4/games', { method: 'POST', headers, body });
    if(!r.ok) throw new Error('IGDB ' + r.status);
    return await r.json();
  };
  // Découpe la saisie en mots (sans ponctuation) → trouve les jeux dont le nom CONTIENT chaque mot.
  // Gère les recherches partielles (« nier au » → « NieR: Automata »), triées par popularité.
  const words = q.split(/\s+/).map(w => w.replace(/[^a-z0-9]/gi, '')).filter(w => w.length >= 2);
  let arr = [];
  if(words.length){
    const where = 'where ' + words.map(w => `name ~ *"${w}"*`).join(' & ') + ';';
    arr = await run(`${IGDB_FIELDS} ${where} sort total_rating_count desc; limit 30;`);
  }
  // Repli : si rien (ou saisie trop courte), on tente le moteur « search » d'IGDB.
  if(!arr.length){
    arr = await run(`search "${q.replace(/"/g, '')}"; ${IGDB_FIELDS} limit 20;`);
  }
  return arr
    .filter(g => !IGDB_SKIP_CAT.has(g.category))
    .slice(0, 10)
    .map(g => ({
      title:     g.name,
      year:      g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear() : null,
      image:     g.cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${g.cover.image_id}.jpg` : '',
      synopsis:  g.summary || '',
      genres:    (g.genres || []).map(x => x.name),
      platforms: (g.platforms || []).map(x => x.name),
      rating:    g.total_rating ? Math.min(5, Math.round(g.total_rating / 20)) : 0,   // /100 → /5 arrondi
      achTotal:  0,
      link:      g.url || '',
    }));
}

// ---- Steam (storesearch + appdetails) ----
// Écarte les entrées qui ne sont pas des jeux (BO/OST, DLC, season pass, artbook, démo…).
const STEAM_SKIP = /soundtrack|\bost\b|art\s?book|season pass|wallpaper|\bdemo\b|\bdlc\b|\balbum\b|\btracks?\b|\bsongs?\b|arrangement|arranged|\bvinyl\b|original game soundtrack/i;
async function steamSearch(q){
  const r = await fetch('https://store.steampowered.com/api/storesearch/?cc=fr&l=french&term=' + encodeURIComponent(q));
  const d = await r.json();
  return (d.items || [])
    .filter(g => g.type === 'app' && !STEAM_SKIP.test(g.name || ''))
    .map(g => ({
      title:     g.name,
      year:      null,
      image:     STEAM_CDN + g.id + '/library_600x900.jpg',  // jaquette verticale
      imageAlt:  STEAM_CDN + g.id + '/header.jpg',           // repli paysage
      synopsis:  '', genres: [], platforms: ['PC'], achTotal: 0,
      link:      'https://store.steampowered.com/app/' + g.id,
      detail:    '/steam/app?appid=' + g.id,                // l'app le complétera au clic
    }));
}
async function steamApp(url){
  const appid = url.searchParams.get('appid');
  const r = await fetch('https://store.steampowered.com/api/appdetails?l=french&appids=' + appid);
  const d = await r.json();
  const info = d && d[appid] && d[appid].success ? d[appid].data : null;
  if(!info) return json({});
  const y = ((info.release_date && info.release_date.date) || '').match(/\d{4}/);
  const mc = info.metacritic && info.metacritic.score;
  return json({
    year:     y ? +y[0] : null,
    genres:   (info.genres || []).map(x => x.description),
    achTotal: (info.achievements && info.achievements.total) || 0,
    rating:   mc ? Math.min(5, Math.round(mc / 20)) : 0,   // Metacritic /100 → /5 arrondi
    synopsis: info.short_description || '',
  });
}

// ---- DLC / extensions d'un jeu (calendrier des sorties jeux) ----
// /dlc?steam=APPID  OU  /dlc?slug=IGDB_SLUG
// Interroge LES DEUX sources (Steam + IGDB) : à partir d'un seul identifiant, le Worker
// retrouve l'autre via IGDB, récupère les DLC des deux côtés, puis fusionne en dédoublonnant
// par nom (un DLC identique des deux sources n'est gardé qu'une fois ; les différents sont tous gardés).
async function gameDlc(url, env){
  let appid = url.searchParams.get('steam');
  let slug  = url.searchParams.get('slug');
  const hasIgdb = !!(env.TWITCH_ID && env.TWITCH_SECRET);

  // Résolution croisée de l'identifiant manquant (best-effort, nécessite IGDB).
  let resolveErr = null;
  if(hasIgdb){
    try{
      if(slug && !appid)      appid = await steamAppIdFromIgdbSlug(slug, env);
      else if(appid && !slug) slug  = await igdbSlugFromSteamAppId(appid, env);
    }catch(e){ resolveErr = String((e && e.message) || e); }
  }
  if(!appid && !slug) return json({ items: [] });

  // Chaque source est best-effort : l'échec de l'une n'empêche pas l'autre.
  let steamItems = [], igdbItems = [];
  if(appid)           { try{ steamItems = await steamDlc(appid); }catch(e){} }
  if(slug && hasIgdb) { try{ igdbItems  = await igdbDlc(slug, env); }catch(e){} }

  // IGDB prioritaire (dates ISO précises) : en cas de doublon, c'est sa version qui est gardée.
  const items = mergeDlcLists(igdbItems, steamItems);
  return json({ source: 'merged', hasIgdb, resolvedAppid: appid || null, resolvedSlug: slug || null,
    resolveErr, steamCount: steamItems.length, igdbCount: igdbItems.length, items });
}
// Nom normalisé pour comparer deux titres de DLC (casse, espaces et ponctuation ignorés).
function normName(s){ return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
// Fusionne deux listes de DLC en supprimant les doublons (même nom normalisé). `primary` gagne à égalité.
function mergeDlcLists(primary, secondary){
  const out = [], seen = new Set();
  for(const d of [...(primary || []), ...(secondary || [])]){
    const k = normName(d.title);
    if(!k || seen.has(k)) continue;
    seen.add(k); out.push(d);
  }
  return out;
}
// En-têtes d'authentification IGDB communs.
async function igdbHeaders(env){
  const tok = await igdbToken(env);
  return { 'Client-ID': env.TWITCH_ID, 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
}
// Retrouve l'appid Steam à partir d'un slug IGDB.
// 1) external_games catégorie 1 = Steam (uid = appid) ; 2) repli : toute URL Steam trouvée
//    dans external_games.url ou websites.url (robuste aux évolutions du champ « category »).
async function steamAppIdFromIgdbSlug(slug, env){
  const headers = await igdbHeaders(env);
  const body = `fields external_games.category, external_games.uid, external_games.url, websites.url; where slug = "${slug.replace(/"/g, '')}"; limit 1;`;
  const r = await fetch('https://api.igdb.com/v4/games', { method: 'POST', headers, body });
  if(!r.ok) return null;
  const g = (await r.json())[0]; if(!g) return null;
  const ext = (g.external_games || []).find(e => e.category === 1 && e.uid);
  if(ext) return String(ext.uid);
  const urls = [...(g.external_games || []).map(e => e.url || ''), ...(g.websites || []).map(w => w.url || '')];
  for(const u of urls){ const m = /store\.steampowered\.com\/app\/(\d+)/.exec(u); if(m) return m[1]; }
  return null;
}
// Retrouve le slug IGDB à partir d'un appid Steam (external_games catégorie 1 = Steam).
async function igdbSlugFromSteamAppId(appid, env){
  const headers = await igdbHeaders(env);
  const body = `fields game.slug; where category = 1 & uid = "${appid}"; limit 1;`;
  const r = await fetch('https://api.igdb.com/v4/external_games', { method: 'POST', headers, body });
  if(!r.ok) return null;
  const d = await r.json();
  return (d[0] && d[0].game && d[0].game.slug) || null;
}
// IGDB : dates PRÉCISES (timestamps) pour DLC + extensions, sorties et à venir.
async function igdbDlc(slug, env){
  const tok = await igdbToken(env);
  const headers = { 'Client-ID': env.TWITCH_ID, 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' };
  const body = 'fields name, dlcs.name, dlcs.first_release_date, expansions.name, expansions.first_release_date,' +
    ' standalone_expansions.name, standalone_expansions.first_release_date;' +
    ` where slug = "${slug.replace(/"/g, '')}"; limit 1;`;
  const r = await fetch('https://api.igdb.com/v4/games', { method: 'POST', headers, body });
  if(!r.ok) throw new Error('IGDB ' + r.status);
  const g = (await r.json())[0];
  if(!g) return [];
  const out = [];
  const add = (x, kind) => { if(x && x.name) out.push({
    title: x.name,
    date:  x.first_release_date ? new Date(x.first_release_date * 1000).toISOString().slice(0, 10) : null,
    kind,
  }); };
  (g.dlcs || []).forEach(x => add(x, 'DLC'));
  (g.expansions || []).forEach(x => add(x, 'Extension'));
  (g.standalone_expansions || []).forEach(x => add(x, 'Extension'));
  return out;
}
// Steam : liste des DLC + flag « à venir ». La date future est un texte (souvent imprécis), pas de timestamp fiable.
async function steamDlc(appid){
  const r = await fetch('https://store.steampowered.com/api/appdetails?l=french&filters=basic&appids=' + appid);
  const d = await r.json();
  const info = d && d[appid] && d[appid].success ? d[appid].data : null;
  const ids = (info && info.dlc) || [];
  const out = [];
  for(const id of ids.slice(0, 25)){
    try{
      const rr = await fetch('https://store.steampowered.com/api/appdetails?l=french&filters=basic&appids=' + id);
      const dd = await rr.json();
      const di = dd && dd[id] && dd[id].success ? dd[id].data : null;
      if(!di) continue;
      const rd = di.release_date || {};
      const y = (rd.date || '').match(/\d{4}/);
      out.push({
        title: di.name,
        date:  null,                       // Steam ne donne pas de date ISO fiable
        dateText: rd.date || '',           // texte tel quel (« 12 déc. 2024 », « 2025 »…)
        coming: !!rd.coming_soon,
        year:  y ? +y[0] : null,
        kind:  'DLC',
      });
    }catch(e){ /* DLC ignoré si échec */ }
  }
  return out;
}

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ═══════════════════════════════════
// SCRAPING VINTED — VERSION AMÉLIORÉE
// ═══════════════════════════════════
app.get('/api/scrape', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
  };

  try {
    // Récupérer la page HTML
    const pageRes = await fetch(url, { headers, timeout: 15000 });
    if (!pageRes.ok) {
      return res.status(422).json({ error: 'Page inaccessible (code ' + pageRes.status + '). Remplis manuellement.' });
    }
    const html = await pageRes.text();
    const $ = cheerio.load(html);

    let item = null;

    // Méthode 1 : __NEXT_DATA__ (le plus fiable sur Vinted)
    try {
      const nextScript = $('script#__NEXT_DATA__').html();
      if (nextScript) {
        const nd = JSON.parse(nextScript);
        item = nd?.props?.pageProps?.item
          || nd?.props?.pageProps?.data?.item
          || nd?.props?.pageProps?.itemDto
          || nd?.props?.pageProps?.listing;
      }
    } catch(e) {}

    // Méthode 2 : chercher dans les scripts inline
    if (!item) {
      $('script').each(function() {
        const content = $(this).html() || '';
        // Pattern Vinted : {"item":{"id":...}}
        const m = content.match(/"item"\s*:\s*(\{[^<]{100,}\})/);
        if (m && !item) {
          try {
            const parsed = JSON.parse(m[1]);
            if (parsed.title) item = parsed;
          } catch(e) {}
        }
      });
    }

    // Méthode 3 : JSON-LD structured data
    let jsonLd = null;
    if (!item) {
      $('script[type="application/ld+json"]').each(function() {
        try {
          const d = JSON.parse($(this).html());
          if (d['@type'] === 'Product' && !jsonLd) jsonLd = d;
        } catch(e) {}
      });
    }

    // Construire le résultat
    let result = {
      nom: '',
      marque: '',
      taille: '',
      prix: null,
      image: '',
      imageBase64: null,
      photos: [],
      couleur: '',
      vendeur: '',
      pays: 'France',
      description: '',
    };

    if (item && item.title) {
      result.nom = item.title || '';
      result.marque = item.brand_title || item.brand?.title || '';
      result.taille = item.size_title || item.size?.title || '';
      result.couleur = item.colour_title || item.colour?.title || '';
      result.vendeur = item.user?.login || '';
      result.pays = item.user?.country_title || 'France';
      result.description = item.description || '';

      // Prix
      if (item.price) result.prix = parseFloat(String(item.price).replace(',', '.'));
      else if (item.price_numeric) result.prix = parseFloat(item.price_numeric);

      // Photos
      const photoList = item.photos || (item.photo ? [item.photo] : []);
      result.photos = photoList.slice(0, 5).map(function(p) {
        return p.full_size_url || p.url || p.high_resolution?.url || '';
      }).filter(Boolean);
      result.image = result.photos[0] || '';

    } else if (jsonLd) {
      result.nom = jsonLd.name || '';
      result.marque = jsonLd.brand?.name || '';
      result.image = Array.isArray(jsonLd.image) ? jsonLd.image[0] : (jsonLd.image || '');
      if (jsonLd.offers?.price) result.prix = parseFloat(jsonLd.offers.price);

    } else {
      // Fallback OpenGraph
      result.nom = $('meta[property="og:title"]').attr('content') || $('title').text().split('|')[0].trim() || '';
      result.image = $('meta[property="og:image"]').attr('content') || '';
      const priceTag = $('meta[property="product:price:amount"]').attr('content');
      if (priceTag) result.prix = parseFloat(priceTag);
    }

    // Récupérer la photo et la convertir en base64 (pour stockage permanent)
    if (result.image) {
      try {
        const imgRes = await fetch(result.image, {
          headers: { 'User-Agent': headers['User-Agent'], 'Referer': 'https://www.vinted.fr/' },
          timeout: 10000
        });
        if (imgRes.ok) {
          const buf = await imgRes.buffer();
          const ct = imgRes.headers.get('content-type') || 'image/jpeg';
          // Limiter à 1.5Mo pour Supabase
          if (buf.length < 1500000) {
            result.imageBase64 = 'data:' + ct + ';base64,' + buf.toString('base64');
          }
        }
      } catch(e) {
        console.log('Photo non récupérée:', e.message);
      }
    }

    if (!result.nom) {
      return res.status(422).json({
        error: 'Données non trouvées. Vinted a peut-être changé sa structure. Remplis manuellement.',
        partiel: result
      });
    }

    console.log('Scraping OK:', result.nom, '|', result.marque, '|', result.prix + '€');
    res.json(result);

  } catch(e) {
    console.error('Scraping error:', e.message);
    res.status(500).json({ error: 'Erreur réseau: ' + e.message });
  }
});

// ═══════════════════════════════════
// ARTICLES CRUD
// ═══════════════════════════════════
app.get('/api/articles', async (req, res) => {
  const { data, error } = await supabase
    .from('articles').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/articles/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('articles').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

app.post('/api/articles', async (req, res) => {
  const { data, error } = await supabase
    .from('articles').insert([req.body]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/api/articles/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('articles').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/api/articles/:id', async (req, res) => {
  const { error } = await supabase
    .from('articles').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════════════════════════════
// DEPENSES CRUD
// ═══════════════════════════════════
app.get('/api/depenses', async (req, res) => {
  const { data, error } = await supabase
    .from('depenses').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/depenses', async (req, res) => {
  const { data, error } = await supabase
    .from('depenses').insert([req.body]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/api/depenses/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('depenses').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/api/depenses/:id', async (req, res) => {
  const { error } = await supabase
    .from('depenses').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ResellCRM en ligne port ' + PORT + ' ✅'));

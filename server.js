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

// ═══════════════════════════════════
// SUPABASE
// ═══════════════════════════════════
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ═══════════════════════════════════
// SCRAPING VINTED
// ═══════════════════════════════════
app.get('/api/scrape', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  try {
    // Extraire l'ID Vinted depuis l'URL
    // Ex: https://www.vinted.fr/vetements/1234567890-nom → 1234567890
    const idMatch = url.match(/\/(\d{6,})-/);
    
    // Headers qui imitent un vrai navigateur
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cache-Control': 'max-age=0',
    };

    // Essayer d'abord l'API Vinted si on a un ID
    if (idMatch) {
      const itemId = idMatch[1];
      try {
        const apiUrl = url.includes('vinted.fr') 
          ? `https://www.vinted.fr/api/v2/items/${itemId}`
          : `https://www.vinted.fr/api/v2/items/${itemId}`;
        
        const apiRes = await fetch(apiUrl, {
          headers: {
            ...headers,
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
          },
          timeout: 8000
        });
        
        if (apiRes.ok) {
          const data = await apiRes.json();
          const item = data.item || data;
          
          if (item && item.title) {
            return res.json({
              nom: item.title || '',
              marque: item.brand_title || item.brand?.title || '',
              taille: item.size_title || item.size?.title || '',
              prix: item.price ? parseFloat(item.price) : null,
              image: item.photos?.[0]?.full_size_url || item.photos?.[0]?.url || item.photo?.full_size_url || '',
              photos: (item.photos || []).map(p => p.full_size_url || p.url).filter(Boolean),
              couleur: item.colour_title || item.colour?.title || '',
              vendeur: item.user?.login || '',
              pays: item.user?.country_title || 'France',
              description: item.description || '',
            });
          }
        }
      } catch(apiErr) {
        console.log('API Vinted échouée, tentative scraping HTML...');
      }
    }

    // Fallback : scraper la page HTML
    const pageRes = await fetch(url, { headers, timeout: 10000 });
    const html = await pageRes.text();
    const $ = cheerio.load(html);

    // Chercher les données JSON-LD (structured data)
    let jsonLd = null;
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const data = JSON.parse($(el).html());
        if (data['@type'] === 'Product' || data.name) {
          jsonLd = data;
        }
      } catch(e) {}
    });

    // Chercher le JSON dans __NEXT_DATA__ (utilisé par Vinted)
    let nextData = null;
    try {
      const nextScript = $('script#__NEXT_DATA__').html();
      if (nextScript) {
        const nd = JSON.parse(nextScript);
        const item = nd?.props?.pageProps?.item || nd?.props?.pageProps?.data?.item;
        if (item) nextData = item;
      }
    } catch(e) {}

    // OpenGraph tags comme dernier recours
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    const ogPrice = $('meta[property="product:price:amount"]').attr('content') || '';

    const result = {
      nom: nextData?.title || jsonLd?.name || ogTitle || '',
      marque: nextData?.brand_title || jsonLd?.brand?.name || '',
      taille: nextData?.size_title || '',
      prix: nextData?.price ? parseFloat(nextData.price) : (ogPrice ? parseFloat(ogPrice) : null),
      image: nextData?.photos?.[0]?.full_size_url || jsonLd?.image || ogImage || '',
      photos: [],
      couleur: nextData?.colour_title || '',
      vendeur: nextData?.user?.login || '',
      pays: nextData?.user?.country_title || 'France',
      description: nextData?.description || jsonLd?.description || '',
    };

    if (!result.nom) {
      return res.status(422).json({ 
        error: 'Impossible de récupérer les données de cette annonce. Vinted a peut-être bloqué la requête. Remplis les champs manuellement.',
        partiel: result
      });
    }

    res.json(result);
  } catch(e) {
    console.error('Scraping error:', e.message);
    res.status(500).json({ error: 'Erreur réseau : ' + e.message });
  }
});

// ═══════════════════════════════════
// ARTICLES CRUD
// ═══════════════════════════════════
app.get('/api/articles', async (req, res) => {
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/articles/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

app.post('/api/articles', async (req, res) => {
  const { data, error } = await supabase
    .from('articles')
    .insert([req.body])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/api/articles/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('articles')
    .update(req.body)
    .eq('id', req.params.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/api/articles/:id', async (req, res) => {
  const { error } = await supabase
    .from('articles')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════════════════════════════
// DEPENSES CRUD
// ═══════════════════════════════════
app.get('/api/depenses', async (req, res) => {
  const { data, error } = await supabase
    .from('depenses')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/depenses', async (req, res) => {
  const { data, error } = await supabase
    .from('depenses')
    .insert([req.body])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.put('/api/depenses/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('depenses')
    .update(req.body)
    .eq('id', req.params.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/api/depenses/:id', async (req, res) => {
  const { error } = await supabase
    .from('depenses')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Toutes les autres routes → index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ResellCRM en ligne sur le port ${PORT} ✅`);
});

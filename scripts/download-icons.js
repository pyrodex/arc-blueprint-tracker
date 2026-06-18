#!/usr/bin/env node
'use strict';

/**
 * Downloads blueprint icons from the ARC Raiders Fandom wiki.
 *
 * Strategy:
 * 1. Batch-query arc-raiders.fandom.com MediaWiki API for blueprint images
 *    — tries "File:[Name] Blueprint.png" then "File:[Name].png" per blueprint
 * 2. Download resolved images to DATA_DIR/icons/<slug>.png
 * 3. For any not found, generate a clean SVG placeholder
 *
 * Usage:
 *   DATA_DIR=/data node scripts/download-icons.js [--force]
 */

const https   = require('https');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const { URL } = require('url');

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '../data');
const ICONS_DIR = path.join(DATA_DIR, 'icons');
const FORCE     = process.argv.includes('--force');

const FANDOM_API = 'https://arc-raiders.fandom.com/api.php';

fs.mkdirSync(ICONS_DIR, { recursive: true });

// ── Helpers ────────────────────────────────────────────────────────────────────
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fetchUrl(urlStr, retries = 2) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(urlStr);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        'User-Agent': 'ARC-Blueprint-Tracker/1.0 (icon downloader; https://github.com/pyrodex/arc-blueprint-tracker)',
        Accept: 'application/json,image/*,*/*',
      },
      timeout: 20000,
    };

    const req = lib.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, retries).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });

    req.on('error', err => {
      if (retries > 0) fetchUrl(urlStr, retries - 1).then(resolve).catch(reject);
      else reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('Request timed out');
      if (retries > 0) fetchUrl(urlStr, retries - 1).then(resolve).catch(reject);
      else reject(err);
    });
    req.end();
  });
}

async function fetchJson(url) {
  const { statusCode, body } = await fetchUrl(url);
  if (statusCode !== 200) throw new Error(`HTTP ${statusCode} for ${url}`);
  return JSON.parse(body.toString());
}

async function downloadImage(url, destPath) {
  const { statusCode, body, headers } = await fetchUrl(url);
  if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
  const ct = headers['content-type'] ?? '';
  if (!ct.startsWith('image/')) throw new Error(`Not an image: ${ct}`);
  if (body.length < 100) throw new Error(`Suspiciously small response (${body.length} bytes)`);
  fs.writeFileSync(destPath, body);
}

// ── Fandom MediaWiki batch query ───────────────────────────────────────────────
// Build candidate file titles for a blueprint name (in priority order)
function candidateTitles(name) {
  return [
    `File:${name} Blueprint.png`,
    `File:${name} Blueprint.webp`,
    `File:${name}.png`,
    `File:${name}.webp`,
  ];
}

// Query up to 50 titles at once; returns map of title → image URL
async function batchResolveImages(titles) {
  const params = new URLSearchParams({
    action: 'query',
    prop:   'imageinfo',
    iiprop: 'url',
    format: 'json',
    titles: titles.join('|'),
  });

  const data = await fetchJson(`${FANDOM_API}?${params}`);
  const result = {};

  for (const page of Object.values(data?.query?.pages ?? {})) {
    if (page.missing !== '' && page.imageinfo?.[0]?.url) {
      // normalise title to match what we queried
      result[page.title] = page.imageinfo[0].url;
    }
  }

  // Handle Fandom's title normalisation (spaces ↔ underscores)
  for (const norm of data?.query?.normalized ?? []) {
    if (result[norm.to]) result[norm.from] = result[norm.to];
  }

  return result;
}

// ── SVG placeholder ────────────────────────────────────────────────────────────
const CATEGORY_COLORS = {
  weapons:    { bg: '#1a0a0a', border: '#ef4444', text: '#ef4444', emoji: '🔫' },
  mods:       { bg: '#0a0f1a', border: '#3b82f6', text: '#3b82f6', emoji: '🔧' },
  explosives: { bg: '#1a0d00', border: '#f97316', text: '#f97316', emoji: '💣' },
  medicine:   { bg: '#001a0a', border: '#22c55e', text: '#22c55e', emoji: '💊' },
  augments:   { bg: '#0d001a', border: '#a855f7', text: '#a855f7', emoji: '🧠' },
  utility:    { bg: '#001a1a', border: '#06b6d4', text: '#06b6d4', emoji: '⚡' },
  crafting:   { bg: '#1a1a00', border: '#eab308', text: '#eab308', emoji: '⚙' },
};

function generateSvgPlaceholder(name, category) {
  const c        = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.crafting;
  const initials = name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="8" fill="${c.bg}" stroke="${c.border}" stroke-width="1.5" stroke-opacity="0.6"/>
  <text x="32" y="26" text-anchor="middle" font-family="system-ui,sans-serif" font-size="22" fill="${c.text}" opacity="0.9">${c.emoji}</text>
  <text x="32" y="52" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="${c.text}" opacity="0.8">${initials}</text>
</svg>`;
}

// ── Main ───────────────────────────────────────────────────────────────────────
const BLUEPRINTS = require('../backend/src/blueprints');

async function main() {
  console.log('\n🎮 ARC Blueprint Tracker — Icon Download (Fandom wiki)\n');
  console.log(`Icons directory: ${ICONS_DIR}`);
  console.log(`Force re-download: ${FORCE}\n`);

  // Which blueprints still need icons?
  const pending = FORCE
    ? BLUEPRINTS
    : BLUEPRINTS.filter(bp => {
        const slug = slugify(bp.name);
        return !fs.existsSync(path.join(ICONS_DIR, `${slug}.png`))
            && !fs.existsSync(path.join(ICONS_DIR, `${slug}.webp`))
            && !fs.existsSync(path.join(ICONS_DIR, `${slug}.svg`));
      });

  if (pending.length === 0) {
    console.log('✅ All icons already downloaded. Use --force to re-download.\n');
    return;
  }
  console.log(`Fetching icons for ${pending.length} blueprint(s)…\n`);

  // Build all candidate titles we want to resolve, grouped by blueprint
  // structure: [{ bp, candidates: [title, …] }]
  const jobs = pending.map(bp => ({ bp, candidates: candidateTitles(bp.name) }));

  // Collect every unique title needed across all jobs
  const allTitles = [...new Set(jobs.flatMap(j => j.candidates))];

  // Batch-resolve in chunks of 50 (API limit)
  const resolvedMap = {};
  const BATCH = 50;
  for (let i = 0; i < allTitles.length; i += BATCH) {
    const chunk = allTitles.slice(i, i + BATCH);
    try {
      const partial = await batchResolveImages(chunk);
      Object.assign(resolvedMap, partial);
    } catch (err) {
      console.error(`  ⚠️  Batch query failed (titles ${i}–${i + BATCH}): ${err.message}`);
    }
    if (i + BATCH < allTitles.length) await delay(400);
  }

  // Download images in small concurrent batches
  const results = { downloaded: 0, placeholder: 0, error: 0 };
  const CONCURRENCY = 4;

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const chunk   = jobs.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(({ bp, candidates }) => processOne(bp, candidates, resolvedMap)));

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const r = result.value;
        results[r.status]++;
        const icon = r.status === 'downloaded' ? '⬇️ ' : r.status === 'placeholder' ? '🎨' : '❌';
        const src  = r.status === 'downloaded' ? ` (${r.url.split('/revision')[0].split('/').pop()})` : '';
        console.log(`  ${icon}  ${r.name}${src}`);
      } else {
        results.error++;
        console.error(`  ❌  ${result.reason?.message}`);
      }
    }

    if (i + CONCURRENCY < jobs.length) await delay(150);
  }

  console.log('\n✅ Done!');
  console.log(`   Downloaded:       ${results.downloaded}`);
  console.log(`   Placeholder SVGs: ${results.placeholder}`);
  if (results.error) console.log(`   Errors:           ${results.error}`);
  console.log();
}

async function processOne(bp, candidates, resolvedMap) {
  const slug    = slugify(bp.name);
  const destPng = path.join(ICONS_DIR, `${slug}.png`);
  const destSvg = path.join(ICONS_DIR, `${slug}.svg`);

  // Find the first candidate that resolved to an image URL
  let imageUrl = null;
  for (const title of candidates) {
    if (resolvedMap[title]) { imageUrl = resolvedMap[title]; break; }
  }

  if (imageUrl) {
    try {
      await downloadImage(imageUrl, destPng);
      return { name: bp.name, status: 'downloaded', url: imageUrl };
    } catch (err) {
      // fall through to placeholder
      console.error(`    ⚠️  Download failed for ${bp.name}: ${err.message}`);
    }
  }

  // Write SVG placeholder
  fs.writeFileSync(destSvg, generateSvgPlaceholder(bp.name, bp.category), 'utf8');
  return { name: bp.name, status: 'placeholder' };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  // Non-fatal — server starts fine even if icons fail (SVG placeholders shown instead)
  console.error('[icons] Download failed:', err?.message ?? err);
});

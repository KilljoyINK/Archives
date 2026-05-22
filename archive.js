/* ─── KilljoyINK Archives · archive.js ─── */
/* Live data from TZKT API · SQL-style filtering · CSV export */

'use strict';

const WALLET  = 'tz1QtcA4MvmCSLJ7DdvHzXEq2sm2bEC37xdG';
const TZKT    = 'https://api.tzkt.io/v1';
const IPFS_GW = 'https://ipfs.io/ipfs/';
const HEN_CT  = 'KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton';

/* ── Utilities ── */
const ipfsUrl = uri => uri?.startsWith('ipfs://') ? IPFS_GW + uri.slice(7) : (uri || null);
const fmtDate = ts  => new Date(ts).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
const fmtYear = ts  => new Date(ts).getFullYear();

function getPlatform(token) {
  const alias = token.contract?.alias || '';
  if (alias.toLowerCase().includes('hic') || token.contract?.address === HEN_CT) return 'HicEtNunc / Teia';
  if (alias.toLowerCase().includes('objkt') || alias === 'OBJKTCOM') return 'Objkt.com';
  return alias || 'Unknown';
}

function getObjktUrl(contract, tokenId) {
  return `https://objkt.com/tokens/${contract}/${tokenId}`;
}

function getTeiUrl(tokenId) {
  return `https://teia.art/objkt/${tokenId}`;
}

function getMimeCategory(mimeType) {
  if (!mimeType) return 'unknown';
  if (mimeType.startsWith('image')) return 'image';
  if (mimeType.startsWith('video')) return 'video';
  if (mimeType.startsWith('audio')) return 'audio';
  if (mimeType.includes('html') || mimeType.includes('javascript') || mimeType.includes('text')) return 'interactive';
  return 'other';
}

/* ── State ── */
let allTokens  = [];
let viewMode   = 'grid';
let filterQ    = '';
let filterPlatform = 'all';
let filterMedia    = 'all';
let sortBy     = 'date-desc';
let openToken  = null;

/* ── DOM refs ── */
const grid       = document.getElementById('token-grid');
const drawer     = document.getElementById('detail-drawer');
const drawerTitle= document.getElementById('detail-title');
const drawerBody = document.getElementById('drawer-content');
const overlay    = document.getElementById('drawer-overlay');
const closeBtn   = document.getElementById('drawer-close');
const searchInput= document.getElementById('search-input');
const filterPlt  = document.getElementById('filter-platform');
const filterMed  = document.getElementById('filter-media');
const sortSel    = document.getElementById('sort-by');
const viewGrid   = document.getElementById('view-grid');
const viewList   = document.getElementById('view-list');
const resultsC   = document.getElementById('results-count');
const exportBtn  = document.getElementById('export-csv');

/* ── Fetch all killjoyINK tokens ── */
async function fetchTokens() {
  const url = `${TZKT}/tokens?firstMinter=${WALLET}&standard=fa2&limit=200&sort.desc=firstTime`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TZKT API error: HTTP ${res.status}`);
  const data = await res.json();

  /* Filter to genuine art tokens — exclude DeFi/stablecoin/governance symbols */
  const DEGEN_SYMBOLS = /^(USD|XTZ|BTC|ETH|PLENTY|QUIPU|WTZ|kUSD|ctez|SMAK|uUSD|wCOMP|tzBTC|wWBTC|HEHEH)$/i;
  return data.filter(t =>
    t.metadata?.name &&
    t.standard === 'fa2' &&
    !DEGEN_SYMBOLS.test(t.metadata?.symbol || '') &&
    (t.metadata?.creators || t.metadata?.minter || t.metadata?.artists || t.metadata?.description !== undefined)
  );
}

/* ── Render stats ── */
function renderStats(tokens) {
  const contracts = new Set(tokens.map(t => t.contract?.address)).size;
  const editions  = tokens.reduce((s, t) => s + Number(t.totalSupply || 0), 0);
  const sorted    = [...tokens].sort((a,b) => new Date(a.firstTime) - new Date(b.firstTime));
  const earliest  = sorted[0]?.firstTime;
  const latest    = sorted[sorted.length - 1]?.firstTime;

  document.getElementById('stat-count').textContent     = tokens.length;
  document.getElementById('stat-editions').textContent  = editions.toLocaleString();
  document.getElementById('stat-contracts').textContent = contracts;
  document.getElementById('stat-year').textContent      = earliest ? fmtYear(earliest) : '—';
  document.getElementById('stat-latest').textContent    = latest   ? fmtDate(latest)  : '—';
}

/* ── Filter + sort ── */
function getFiltered() {
  const q = filterQ.toLowerCase().trim();
  return allTokens
    .filter(t => {
      const name = (t.metadata?.name || '').toLowerCase();
      const desc = (t.metadata?.description || '').toLowerCase();
      const tags = (t.metadata?.tags || []).join(' ').toLowerCase();
      const matchQ = !q || name.includes(q) || desc.includes(q) || tags.includes(q);

      const plat = getPlatform(t).toLowerCase();
      const matchPlt = filterPlatform === 'all' ||
        (filterPlatform === 'hen'   && plat.includes('hic')) ||
        (filterPlatform === 'objkt' && plat.includes('objkt'));

      const mime = t.metadata?.formats?.[0]?.mimeType || '';
      const cat  = getMimeCategory(mime);
      const matchMed = filterMedia === 'all' || cat === filterMedia;

      return matchQ && matchPlt && matchMed;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'date-asc':       return new Date(a.firstTime) - new Date(b.firstTime);
        case 'name':           return (a.metadata?.name || '').localeCompare(b.metadata?.name || '');
        case 'editions-desc':  return Number(b.totalSupply || 0) - Number(a.totalSupply || 0);
        default:               return new Date(b.firstTime) - new Date(a.firstTime);
      }
    });
}

/* ── Render grid ── */
function renderGrid() {
  const filtered = getFiltered();
  resultsC.textContent = `showing ${filtered.length} of ${allTokens.length} tokens`;

  if (viewMode === 'grid') {
    grid.className = 'token-grid grid-view';
    grid.innerHTML = filtered.map((t, i) => renderCardHTML(t, i)).join('');
  } else {
    grid.className = 'token-grid list-view';
    grid.innerHTML = `
      <table class="list-table" aria-label="Minted tokens list">
        <thead>
          <tr>
            <th>#</th>
            <th>thumb</th>
            <th>title</th>
            <th>platform</th>
            <th>date</th>
            <th>ed.</th>
            <th>format</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map((t, i) => renderRowHTML(t, i)).join('')}
        </tbody>
      </table>`;
  }

  /* Attach click events */
  grid.querySelectorAll('[data-token-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.tokenIdx);
      openDetail(filtered[idx]);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        const idx = Number(el.dataset.tokenIdx);
        openDetail(filtered[idx]);
      }
    });
  });
}

function renderCardHTML(t, i) {
  const name    = t.metadata?.name || `OBJKT #${t.tokenId}`;
  const thumb   = ipfsUrl(t.metadata?.thumbnailUri || t.metadata?.displayUri);
  const plat    = getPlatform(t);
  const mime    = t.metadata?.formats?.[0]?.mimeType || '';
  const cat     = getMimeCategory(mime);
  const mediaLabel = cat !== 'image' && cat !== 'unknown' ? `<span class="card-media-badge">${cat}</span>` : '';

  const thumbHTML = thumb
    ? `<img src="${thumb}" alt="${escHtml(name)}" loading="lazy" onerror="this.style.display='none'">`
    : `<span class="no-preview">no preview</span>`;

  return `
    <article class="token-card" data-token-idx="${i}" tabindex="0" role="button"
             aria-label="View details for ${escHtml(name)}"
             style="animation-delay: ${Math.min(i * 0.03, 0.6)}s">
      <div class="card-thumb">
        ${thumbHTML}
        ${mediaLabel}
      </div>
      <div class="card-info">
        <p class="card-name" title="${escHtml(name)}">${escHtml(name)}</p>
        <p class="card-platform">${escHtml(plat)}</p>
        <div class="card-meta">
          <span class="card-date">${fmtDate(t.firstTime)}</span>
          <span class="card-editions">${Number(t.totalSupply || 0).toLocaleString()} ed.</span>
        </div>
      </div>
    </article>`;
}

function renderRowHTML(t, i) {
  const name  = t.metadata?.name || `OBJKT #${t.tokenId}`;
  const thumb = ipfsUrl(t.metadata?.thumbnailUri);
  const plat  = getPlatform(t);
  const mime  = t.metadata?.formats?.[0]?.mimeType || '—';

  const thumbHTML = thumb
    ? `<img class="list-thumb" src="${thumb}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="list-thumb"></div>`;

  return `
    <tr data-token-idx="${i}" tabindex="0" role="button" aria-label="View ${escHtml(name)}">
      <td class="list-meta">${i + 1}</td>
      <td>${thumbHTML}</td>
      <td class="list-name">${escHtml(name)}</td>
      <td class="list-platform">${escHtml(plat)}</td>
      <td class="list-meta">${fmtDate(t.firstTime)}</td>
      <td class="list-meta">${Number(t.totalSupply || 0).toLocaleString()}</td>
      <td class="list-meta">${escHtml(mime)}</td>
    </tr>`;
}

/* ── Detail drawer ── */
function openDetail(token) {
  openToken = token;
  const m    = token.metadata || {};
  const name = m.name || `OBJKT #${token.tokenId}`;

  drawerTitle.textContent = name;

  const artifact    = ipfsUrl(m.artifactUri);
  const display     = ipfsUrl(m.displayUri || m.thumbnailUri);
  const mimeType    = m.formats?.[0]?.mimeType || '';
  const description = m.description || 'No description provided.';
  const tags        = m.tags || [];
  const plat        = getPlatform(token);
  const contractAddr= token.contract?.address || '';
  const isHEN       = contractAddr === HEN_CT;
  const objktLink   = getObjktUrl(contractAddr, token.tokenId);
  const teiaLink    = isHEN ? getTeiUrl(token.tokenId) : null;
  const ipfsHash    = m.artifactUri?.replace('ipfs://', '') || '';

  /* Artwork panel */
  let artworkHTML = '';
  if (mimeType.startsWith('video') && artifact) {
    artworkHTML = `<video src="${artifact}" autoplay loop muted playsinline controls></video>`;
  } else if (mimeType.startsWith('audio') && artifact) {
    artworkHTML = `<audio src="${artifact}" controls style="width:100%"></audio>`;
  } else if (display) {
    artworkHTML = `<img src="${display}" alt="${escHtml(name)}" onerror="this.parentElement.innerHTML='<span class=no-preview>Preview unavailable</span>'">`;
  } else {
    artworkHTML = `<span class="no-preview">No preview available</span>`;
  }

  /* Provenance / metadata table */
  const metaRows = [
    ['Token ID',   `#${token.tokenId}`],
    ['Contract',   contractAddr ? `<a href="https://tzkt.io/${contractAddr}" target="_blank" rel="noopener">${token.contract?.alias || contractAddr.slice(0,16)+'…'}</a>` : '—'],
    ['Platform',   plat],
    ['Minted',     fmtDate(token.firstTime)],
    ['Block',      (token.firstLevel || '—').toLocaleString()],
    ['Editions',   Number(token.totalSupply || 0).toLocaleString()],
    ['Minted by',  `<a href="https://tzkt.io/${WALLET}" target="_blank" rel="noopener">${WALLET.slice(0,8)}…${WALLET.slice(-6)}</a>`],
    ['Format',     mimeType || '—'],
    ['IPFS',       ipfsHash ? `<a href="https://ipfs.io/ipfs/${ipfsHash}" target="_blank" rel="noopener">${ipfsHash.slice(0,20)}…</a>` : '—'],
    ['Royalties',  m.royalties ? `${(Object.values(m.royalties.shares || {})[0] / 10).toFixed(1)}%` : '—'],
  ];

  const metaTableHTML = metaRows.map(([k, v]) =>
    `<tr><td class="meta-key">${k}</td><td class="meta-value">${v}</td></tr>`
  ).join('');

  const tagsHTML = tags.length
    ? `<section class="tags-section" aria-label="Tags">${tags.map(t => `<span class="tag">#${escHtml(t)}</span>`).join('')}</section>`
    : '';

  const actionsHTML = `
    <div class="detail-actions">
      <a href="${objktLink}" target="_blank" rel="noopener">View on Objkt ↗</a>
      ${teiaLink ? `<a href="${teiaLink}" target="_blank" rel="noopener">View on Teia ↗</a>` : ''}
      ${artifact  ? `<a href="${artifact}" target="_blank" rel="noopener" download>Download artifact ↓</a>` : ''}
    </div>`;

  drawerBody.innerHTML = `
    <div class="detail-artwork" aria-label="Artwork preview">${artworkHTML}</div>
    <section class="detail-meta-section">
      <p class="detail-description">"${escHtml(description)}"</p>
      <table class="meta-table" aria-label="Token metadata">
        <tbody>${metaTableHTML}</tbody>
      </table>
    </section>
    ${tagsHTML}
    ${actionsHTML}
  `;

  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  drawerBody.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  openToken = null;
}

/* ── CSV Export ── */
function exportCSV() {
  const filtered = getFiltered();
  const headers = [
    'token_id','name','description','contract_address','contract_alias',
    'platform','mint_date','mint_block','total_editions','mime_type',
    'media_category','tags','artifact_uri','display_uri','thumbnail_uri',
    'royalty_pct','objkt_url','teia_url','ipfs_hash'
  ];

  const rows = filtered.map(t => {
    const m = t.metadata || {};
    const contractAddr = t.contract?.address || '';
    const isHEN = contractAddr === HEN_CT;
    const mime = m.formats?.[0]?.mimeType || '';
    const ipfsHash = m.artifactUri?.replace('ipfs://', '') || '';
    const royalty = m.royalties
      ? (Object.values(m.royalties.shares || {})[0] / 10).toFixed(1)
      : '';

    return [
      t.tokenId,
      m.name || '',
      (m.description || '').replace(/\r?\n/g, ' '),
      contractAddr,
      t.contract?.alias || '',
      getPlatform(t),
      t.firstTime ? new Date(t.firstTime).toISOString().split('T')[0] : '',
      t.firstLevel || '',
      t.totalSupply || '',
      mime,
      getMimeCategory(mime),
      (m.tags || []).join('; '),
      m.artifactUri || '',
      m.displayUri || '',
      m.thumbnailUri || '',
      royalty,
      getObjktUrl(contractAddr, t.tokenId),
      isHEN ? getTeiUrl(t.tokenId) : '',
      ipfsHash
    ];
  });

  const csvStr = [headers, ...rows]
    .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `killjoyink-archives-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── SQL-style query (simple interpreter) ── */
function sqlQuery(query) {
  const q = query.toLowerCase().trim();

  /* WHERE name LIKE */
  const likeMatch = q.match(/where name like ['"]?%?(.+?)%?['"]?(?:\s|$)/i);
  if (likeMatch) {
    filterQ = likeMatch[1].trim();
    searchInput.value = filterQ;
  }

  /* WHERE format = */
  const fmtMatch = q.match(/where.*format\s*=\s*['"](.+?)['"]/i);
  if (fmtMatch) {
    filterMedia = fmtMatch[1];
    filterMed.value = fmtMatch[1];
  }

  /* ORDER BY date DESC|ASC */
  if (q.includes('order by') && q.includes('date desc')) { sortBy = 'date-desc'; sortSel.value = 'date-desc'; }
  if (q.includes('order by') && q.includes('date asc'))  { sortBy = 'date-asc';  sortSel.value = 'date-asc'; }
  if (q.includes('order by') && q.includes('editions'))  { sortBy = 'editions-desc'; sortSel.value = 'editions-desc'; }

  renderGrid();
}

/* ── Escape HTML ── */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Event listeners ── */
searchInput.addEventListener('input', e => { filterQ = e.target.value; renderGrid(); });
filterPlt.addEventListener('change',  e => { filterPlatform = e.target.value; renderGrid(); });
filterMed.addEventListener('change',  e => { filterMedia = e.target.value; renderGrid(); });
sortSel.addEventListener('change',    e => { sortBy = e.target.value; renderGrid(); });

viewGrid.addEventListener('click', () => {
  viewMode = 'grid';
  viewGrid.classList.add('active'); viewGrid.setAttribute('aria-pressed', 'true');
  viewList.classList.remove('active'); viewList.setAttribute('aria-pressed', 'false');
  renderGrid();
});

viewList.addEventListener('click', () => {
  viewMode = 'list';
  viewList.classList.add('active'); viewList.setAttribute('aria-pressed', 'true');
  viewGrid.classList.remove('active'); viewGrid.setAttribute('aria-pressed', 'false');
  renderGrid();
});

overlay.addEventListener('click', closeDetail);
closeBtn.addEventListener('click', closeDetail);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && openToken) closeDetail(); });
exportBtn.addEventListener('click', exportCSV);

/* URL param: ?q= for search */
const urlParams = new URLSearchParams(location.search);
if (urlParams.get('q')) {
  filterQ = urlParams.get('q');
  searchInput.value = filterQ;
}

/* ── Boot ── */
(async function init() {
  try {
    grid.innerHTML = `
      <div class="loading-state">
        <p class="loading-text">Querying the chain…</p>
        <p class="loading-sub">${WALLET}</p>
      </div>`;

    allTokens = await fetchTokens();

    if (allTokens.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <p class="loading-text">No art tokens found.</p>
          <p class="empty-sub">Try checking the wallet on Objkt or Teia directly.</p>
        </div>`;
      return;
    }

    renderStats(allTokens);
    renderGrid();

  } catch (err) {
    console.error('Archive fetch error:', err);
    grid.innerHTML = `
      <div class="error-state">
        <p>Couldn't reach the TZKT API.</p>
        <p style="margin-top:8px; font-size:0.7rem; color:#666">${escHtml(err.message)}</p>
      </div>`;
  }
})();

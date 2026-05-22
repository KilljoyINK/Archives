#!/usr/bin/env python3
"""
killjoyink-archives / generate_pages.py
────────────────────────────────────────
Fetches all minted tokens for killjoyINK from the TZKT API
and generates one SEO-optimized HTML page per mint under /mint/<tokenId>/index.html

Usage:
    python3 generate_pages.py
    python3 generate_pages.py --limit 20   # test with first 20
    python3 generate_pages.py --dry-run    # print URLs only

Requires: requests
    pip install requests
"""

import json, os, re, sys, time, argparse
from pathlib import Path
from datetime import datetime
import requests

# ─── Config ───────────────────────────────────────────────────────────────────
WALLET    = "tz1QtcA4MvmCSLJ7DdvHzXEq2sm2bEC37xdG"
TZKT_BASE = "https://api.tzkt.io/v1"
IPFS_GW   = "https://ipfs.io/ipfs/"
HEN_CT    = "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton"
OUT_DIR   = Path("mint")
DATA_DIR  = Path("data")

DEGEN_SYMBOLS = {"USD", "XTZ", "BTC", "ETH", "PLENTY", "QUIPU", "WTZ", "KUSD",
                 "CTEZ", "SMAK", "UUSD", "WCOMP", "TZBTC", "WWBTC", "BLTR"}

# ─── Utilities ────────────────────────────────────────────────────────────────
def ipfs_url(uri):
    if not uri:
        return None
    if uri.startswith("ipfs://"):
        return IPFS_GW + uri[7:]
    return uri

def fmt_date(ts):
    try:
        return datetime.fromisoformat(ts.rstrip("Z")).strftime("%B %-d, %Y")
    except Exception:
        return ts or "—"

def get_platform(token):
    alias = (token.get("contract") or {}).get("alias", "") or ""
    addr  = (token.get("contract") or {}).get("address", "") or ""
    if "hic" in alias.lower() or addr == HEN_CT:
        return "Hic Et Nunc / Teia"
    if "objkt" in alias.lower() or alias.upper() == "OBJKTCOM":
        return "Objkt.com"
    return alias or "Custom Contract"

def get_mime(token):
    fmts = (token.get("metadata") or {}).get("formats") or []
    return fmts[0].get("mimeType", "") if fmts else ""

def get_mime_cat(mime):
    if not mime:
        return "unknown"
    if mime.startswith("image"):   return "image"
    if mime.startswith("video"):   return "video"
    if mime.startswith("audio"):   return "audio"
    if "html" in mime or "javascript" in mime: return "interactive"
    return "other"

def escape_html(s):
    return str(s).replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace('"','&quot;')

# ─── Fetch from TZKT ──────────────────────────────────────────────────────────
def fetch_tokens(limit=None):
    print(f"Fetching tokens for {WALLET}…")
    url    = f"{TZKT_BASE}/tokens"
    params = {"firstMinter": WALLET, "standard": "fa2", "limit": 200, "sort.desc": "firstTime"}
    all_tokens = []
    offset = 0

    while True:
        params["offset"] = offset
        r = requests.get(url, params=params, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        all_tokens.extend(batch)
        if len(batch) < 200:
            break
        offset += 200
        time.sleep(0.3)

    # filter to art tokens
    art = [t for t in all_tokens
           if t.get("metadata", {}).get("name")
           and (t.get("metadata", {}).get("symbol") or "").upper() not in DEGEN_SYMBOLS
           and t.get("standard") == "fa2"]

    print(f"  Found {len(all_tokens)} total FA2 tokens → {len(art)} art tokens after filtering")
    if limit:
        art = art[:limit]
        print(f"  Limited to first {limit}")
    return art

# ─── JSON-LD schema ────────────────────────────────────────────────────────────
def build_jsonld(token):
    m     = token.get("metadata") or {}
    addr  = (token.get("contract") or {}).get("address", "")
    disp  = ipfs_url(m.get("displayUri") or m.get("thumbnailUri"))
    tags  = m.get("tags") or []
    royalty_pct = None
    if m.get("royalties"):
        shares = m["royalties"].get("shares", {})
        if shares:
            royalty_pct = list(shares.values())[0] / 10

    schema = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "VisualArtwork",
                "@id": f"https://killjoyink.github.io/archives/mint/{token['tokenId']}/",
                "name": m.get("name") or f"OBJKT #{token['tokenId']}",
                "description": m.get("description") or m.get("name") or "",
                "url": f"https://objkt.com/tokens/{addr}/{token['tokenId']}",
                "image": disp,
                "creator": {
                    "@type": "Person",
                    "name": "killjoyINK",
                    "url": "https://teia.art/killjoyink",
                    "sameAs": [
                        "https://objkt.com/@killjoyink",
                        f"https://tzkt.io/{WALLET}"
                    ]
                },
                "dateCreated": (token.get("firstTime") or "")[:10],
                "artMedium": get_mime(token) or "Digital",
                "artworkSurface": "Blockchain (Tezos)",
                "numberOfItems": token.get("totalSupply"),
                "identifier": f"{addr}/{token['tokenId']}",
                "keywords": ", ".join(tags),
                **({"offers": {
                    "@type": "Offer",
                    "url": f"https://objkt.com/tokens/{addr}/{token['tokenId']}",
                    "seller": {"@type": "Person", "name": "killjoyINK"},
                    "priceCurrency": "XTZ",
                }} if True else {}),
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type":"ListItem","position":1,"name":"KilljoyINK Archives","item":"https://killjoyink.github.io/archives/"},
                    {"@type":"ListItem","position":2,"name":m.get("name") or f"OBJKT #{token['tokenId']}","item":f"https://killjoyink.github.io/archives/mint/{token['tokenId']}/"},
                ]
            }
        ]
    }
    return json.dumps(schema, indent=2)

# ─── HTML template per mint ────────────────────────────────────────────────────
def build_mint_page(token):
    m       = token.get("metadata") or {}
    addr    = (token.get("contract") or {}).get("address", "")
    alias   = (token.get("contract") or {}).get("alias", "")
    name    = m.get("name") or f"OBJKT #{token['tokenId']}"
    desc    = m.get("description") or ""
    tags    = m.get("tags") or []
    platform= get_platform(token)
    mime    = get_mime(token)
    cat     = get_mime_cat(mime)
    disp    = ipfs_url(m.get("displayUri") or m.get("thumbnailUri"))
    art     = ipfs_url(m.get("artifactUri"))
    ipfs_h  = (m.get("artifactUri") or "").replace("ipfs://", "")
    is_hen  = addr == HEN_CT
    date    = fmt_date(token.get("firstTime") or "")
    editions= token.get("totalSupply") or "—"
    block   = token.get("firstLevel") or "—"
    royalty = "—"
    if m.get("royalties"):
        shares = m["royalties"].get("shares", {})
        if shares:
            royalty = f"{list(shares.values())[0] / 10:.1f}%"

    # media embed
    if cat == "video" and art:
        media_html = f'<video src="{escape_html(art)}" autoplay loop muted playsinline controls class="artwork-media"></video>'
    elif cat == "audio" and art:
        media_html = f'<audio src="{escape_html(art)}" controls class="artwork-audio"></audio>'
    elif disp:
        media_html = f'<img src="{escape_html(disp)}" alt="{escape_html(name)}" class="artwork-media" onerror="this.parentElement.innerHTML=\'<p class=no-prev>Preview unavailable</p>\'">'
    else:
        media_html = '<p class="no-prev">No preview available</p>'

    # tags HTML
    tags_html = "".join(f'<span class="tag">#{escape_html(t)}</span>' for t in tags)

    # meta rows
    meta_rows = [
        ("Token ID",   f"#{token['tokenId']}"),
        ("Platform",   platform),
        ("Contract",   alias or addr[:22] + "…"),
        ("Minted",     date),
        ("Block",      f"{block:,}" if isinstance(block, int) else str(block)),
        ("Editions",   f"{int(editions):,}" if isinstance(editions, (int, str)) and str(editions).isdigit() else str(editions)),
        ("Format",     mime or "—"),
        ("Royalties",  royalty),
        ("Creator",    f"{WALLET[:10]}…{WALLET[-6:]}"),
        ("IPFS CID",   (ipfs_h[:28] + "…") if ipfs_h else "—"),
    ]
    meta_html = "".join(f"""
        <tr>
          <td class="meta-key">{escape_html(k)}</td>
          <td class="meta-val">{escape_html(v)}</td>
        </tr>""" for k, v in meta_rows)

    # action links
    actions = [
        ("View on Objkt ↗", f"https://objkt.com/tokens/{addr}/{token['tokenId']}"),
        ("View on Teia ↗",  f"https://teia.art/objkt/{token['tokenId']}") if is_hen else None,
        ("IPFS artifact ↗", f"https://ipfs.io/ipfs/{ipfs_h}") if ipfs_h else None,
        ("TZKT record ↗",   f"https://tzkt.io/{WALLET}/tokens"),
        ("← All works",     "../../"),
    ]
    actions_html = "".join(
        f'<a href="{escape_html(href)}" class="action-link" {"target=\"_blank\" rel=\"noopener noreferrer\"" if href.startswith("http") else ""}>{escape_html(label)}</a>'
        for label, href in actions if href
    )

    og_img = disp or "https://cache.teia.rocks/ipfs/Qmf9Q95zbc4hL9cddLZEznjNkmP7RZbFicq5DkshqcHnFe"
    short_desc = (desc[:155] + "…") if len(desc) > 155 else (desc or f"{name} by killjoyINK. {platform}, {date}. {editions} editions.")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{escape_html(name)} — KilljoyINK Archives</title>
  <meta name="description" content="{escape_html(short_desc)}" />
  <meta name="keywords" content="killjoyINK, {escape_html(', '.join(tags))}, Tezos NFT, {escape_html(platform)}, digital art, OBJKT" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="https://killjoyink.github.io/archives/mint/{token['tokenId']}/" />

  <meta property="og:type" content="article" />
  <meta property="og:title" content="{escape_html(name)} — KilljoyINK" />
  <meta property="og:description" content="{escape_html(short_desc)}" />
  <meta property="og:image" content="{escape_html(og_img)}" />
  <meta property="og:url" content="https://killjoyink.github.io/archives/mint/{token['tokenId']}/" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{escape_html(name)} — KilljoyINK" />
  <meta name="twitter:description" content="{escape_html(short_desc)}" />
  <meta name="twitter:image" content="{escape_html(og_img)}" />

  <script type="application/ld+json">
{build_jsonld(token)}
  </script>

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Fraunces:ital,wght@0,300;0,400;1,300&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="../../assets/style.css" />
  <style>
    .mint-page {{ max-width: 1000px; margin: 0 auto; padding: 24px 24px 60px; }}
    .mint-back {{ fontFamily: var(--font-mono); font-size: .7rem; color: var(--text-muted); background: none; border: 1px solid var(--border-2); border-radius: var(--radius); padding: 6px 12px; cursor: pointer; margin-bottom: 28px; display: inline-block; text-decoration: none; letter-spacing: .04em; }}
    .mint-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 36px; align-items: start; }}
    .artwork-wrap {{ background: var(--surface-2); border-radius: var(--radius-lg); overflow: hidden; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; }}
    .artwork-media {{ max-width: 100%; max-height: 100%; object-fit: contain; display: block; }}
    .artwork-audio {{ width: 100%; padding: 24px; }}
    .no-prev {{ font-family: var(--font-mono); font-size: .7rem; color: var(--text-muted); padding: 24px; }}
    .mint-title {{ font-family: var(--font-serif); font-size: 1.65rem; font-weight: 300; letter-spacing: -.02em; color: var(--text); margin-bottom: 8px; line-height: 1.15; }}
    .mint-platform {{ font-family: var(--font-mono); font-size: .62rem; color: var(--teal); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 20px; }}
    .mint-desc {{ font-family: var(--font-serif); font-weight: 300; font-style: italic; font-size: .9rem; color: var(--text-muted); line-height: 1.65; margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }}
    .meta-table {{ width: 100%; border-collapse: collapse; margin-bottom: 20px; }}
    .meta-table tr {{ border-bottom: 1px solid var(--border); }}
    .meta-key {{ font-family: var(--font-mono); font-size: .6rem; text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); padding: 9px 12px 9px 0; width: 36%; }}
    .meta-val {{ font-family: var(--font-mono); font-size: .72rem; color: var(--text); padding: 9px 0; word-break: break-all; }}
    .tags-row {{ display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 24px; }}
    .tag {{ font-family: var(--font-mono); font-size: .6rem; background: var(--surface-2); border: 1px solid var(--border-2); border-radius: 3px; padding: 3px 9px; color: var(--text-muted); }}
    .action-link {{ font-family: var(--font-mono); font-size: .68rem; padding: 8px 13px; border: 1px solid var(--border-2); border-radius: var(--radius); color: var(--text-muted); text-decoration: none; display: inline-block; margin: 0 6px 6px 0; transition: border-color .15s, color .15s; }}
    .action-link:hover {{ border-color: var(--accent); color: var(--accent); }}
    .provenance-box {{ margin-top: 28px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }}
    .provenance-box p {{ font-family: var(--font-mono); font-size: .68rem; color: var(--text-muted); line-height: 1.75; }}
    @media (max-width: 680px) {{ .mint-grid {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>

<header class="site-header">
  <div class="header-inner">
    <div class="header-title">
      <a href="../../" style="text-decoration:none;">
        <h1>KilljoyINK<span class="accent">Archives</span></h1>
      </a>
      <p class="wallet-id">{WALLET}</p>
    </div>
    <nav class="header-links">
      <a href="https://objkt.com/@killjoyink/created" target="_blank" rel="noopener">Objkt ↗</a>
      <a href="https://teia.art/killjoyink" target="_blank" rel="noopener">Teia ↗</a>
      <a href="../../" class="btn-export">← Archive</a>
    </nav>
  </div>
</header>

<main>
  <div class="mint-page">
    <div class="mint-grid">
      <div>
        <div class="artwork-wrap">
          {media_html}
        </div>
      </div>

      <div>
        <h2 class="mint-title">{escape_html(name)}</h2>
        <p class="mint-platform">{escape_html(platform)}</p>
        {f'<p class="mint-desc">"{escape_html(desc)}"</p>' if desc else ''}

        <table class="meta-table" aria-label="Token metadata">
          <tbody>
            {meta_html}
          </tbody>
        </table>

        {f'<div class="tags-row" aria-label="Tags">{tags_html}</div>' if tags else ''}

        <div aria-label="Marketplace and resource links">
          {actions_html}
        </div>

        <div class="provenance-box">
          <p>Minted by <strong>{WALLET[:10]}…{WALLET[-6:]}</strong> on {date} at block {block if isinstance(block, str) else f"{block:,}"}.
          {" Originally published via HicEtNunc; now indexed across Teia, Objkt, and this archive." if is_hen else " Published via Objkt.com."}
          Token #{token['tokenId']} on contract {addr[:16]}…</p>
        </div>
      </div>
    </div>
  </div>
</main>

<footer class="site-footer">
  <p>Data sourced via <a href="https://tzkt.io" target="_blank" rel="noopener">TZKT API</a> · Built with library &amp; information science best practices · <a href="https://github.com/killjoyink/archives" target="_blank" rel="noopener">View on GitHub ↗</a></p>
  <p class="footer-note">KilljoyINK Archives is an independent documentation project. Not affiliated with Objkt, Teia, or Tezos Foundation.</p>
</footer>

</body>
</html>"""

# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Generate KilljoyINK Archives mint pages")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of tokens (for testing)")
    parser.add_argument("--dry-run", action="store_true", help="Print URLs only, don't write files")
    args = parser.parse_args()

    tokens = fetch_tokens(limit=args.limit)

    if not tokens:
        print("No tokens found. Exiting.")
        sys.exit(1)

    # Save JSON snapshot
    DATA_DIR.mkdir(exist_ok=True)
    snapshot_path = DATA_DIR / "mints.json"
    with open(snapshot_path, "w") as f:
        json.dump(tokens, f, indent=2)
    print(f"  Saved snapshot → {snapshot_path}")

    if args.dry_run:
        print("\nDRY RUN — pages that would be generated:")
        for t in tokens:
            m = t.get("metadata") or {}
            print(f"  /mint/{t['tokenId']}/ — {m.get('name','(unnamed)')}")
        return

    # Generate pages
    OUT_DIR.mkdir(exist_ok=True)
    generated = 0
    for i, token in enumerate(tokens):
        token_id  = token.get("tokenId")
        page_dir  = OUT_DIR / str(token_id)
        page_dir.mkdir(exist_ok=True)
        page_path = page_dir / "index.html"

        html = build_mint_page(token)
        with open(page_path, "w", encoding="utf-8") as f:
            f.write(html)

        name = (token.get("metadata") or {}).get("name", "(unnamed)")
        print(f"  [{i+1:3d}/{len(tokens)}] /mint/{token_id}/ → {name}")
        generated += 1

    print(f"\n✓ Generated {generated} mint pages in ./{OUT_DIR}/")
    print(f"✓ JSON snapshot saved to ./{snapshot_path}")
    print(f"\nNext steps:")
    print(f"  git add mint/ data/ && git commit -m 'add {generated} mint pages'")
    print(f"  git push")

if __name__ == "__main__":
    main()

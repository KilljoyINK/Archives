import { useState, useEffect, useMemo, useCallback, useRef } from "react";

/* ─────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────── */
const WALLET  = "tz1QtcA4MvmCSLJ7DdvHzXEq2sm2bEC37xdG";
const TZKT    = "https://api.tzkt.io/v1";
const IPFS_GW = "https://ipfs.io/ipfs/";
const HEN_CT  = "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton";
const DEGEN   = /^(USD|XTZ|BTC|ETH|PLENTY|QUIPU|WTZ|kUSD|ctez|SMAK|uUSD|wCOMP|tzBTC|wWBTC|BLTR|HEHEH)$/i;

/* ─────────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────── */
const ipfs    = u  => u?.startsWith("ipfs://") ? IPFS_GW + u.slice(7) : (u || null);
const fmtDate = ts => new Date(ts).toLocaleDateString("en-US", { year:"numeric", month:"short", day:"numeric" });
const fmtYear = ts => new Date(ts).getFullYear();

const getPlatform = t => {
  const a = t.contract?.alias || "";
  if (a.toLowerCase().includes("hic") || t.contract?.address === HEN_CT) return "Hic Et Nunc / Teia";
  if (a.toLowerCase().includes("objkt") || a === "OBJKTCOM") return "Objkt.com";
  return a || "Custom Contract";
};

const getMime = t => t.metadata?.formats?.[0]?.mimeType || "";
const getMimeCat = mime => {
  if (!mime) return "unknown";
  if (mime.startsWith("image"))   return "image";
  if (mime.startsWith("video"))   return "video";
  if (mime.startsWith("audio"))   return "audio";
  if (mime.includes("html") || mime.includes("javascript")) return "interactive";
  return "other";
};

const getObjktUrl = (contract, tokenId) =>
  `https://objkt.com/tokens/${contract}/${tokenId}`;
const getTeiaUrl  = tokenId => `https://teia.art/objkt/${tokenId}`;

/* ─────────────────────────────────────────────
   SIMPLE SQL INTERPRETER
   Supports: SELECT * FROM mints WHERE ... ORDER BY ... LIMIT N
───────────────────────────────────────────── */
function runSQL(query, tokens) {
  const q = query.trim().toLowerCase();
  if (!q.startsWith("select")) return { error: "Queries must start with SELECT." };

  let rows = [...tokens];
  let isCount = q.includes("count(");

  /* WHERE */
  const whereM = query.match(/where\s+(.+?)(?:\s+order\s+by|\s+limit|$)/i);
  if (whereM) {
    const clause = whereM[1].trim();
    const conditions = clause.split(/\s+and\s+/i);
    for (const cond of conditions) {
      const like  = cond.match(/(\w+)\s+like\s+['"]%?(.+?)%?['"]/i);
      const eq    = cond.match(/(\w+)\s*=\s*['"]?([^'"]+)['"]?/i);
      const gt    = cond.match(/(\w+)\s*>\s*(\d+)/i);
      const lt    = cond.match(/(\w+)\s*<\s*(\d+)/i);

      const field = (f, t) => {
        const m = t.metadata || {};
        switch (f?.toLowerCase()) {
          case "name":        return m.name || "";
          case "description": return m.description || "";
          case "format":
          case "mime":        return getMime(t);
          case "platform":    return getPlatform(t);
          case "editions":
          case "supply":      return Number(t.totalSupply || 0);
          case "date":
          case "year":        return fmtYear(t.firstTime);
          case "tags":        return (m.tags || []).join(" ");
          case "tokenid":
          case "id":          return String(t.tokenId || "");
          default:            return "";
        }
      };

      if (like)  rows = rows.filter(t => String(field(like[1], t)).toLowerCase().includes(like[2].toLowerCase()));
      else if (eq) rows = rows.filter(t => String(field(eq[1], t)).toLowerCase() === eq[2].toLowerCase().trim());
      else if (gt) rows = rows.filter(t => Number(field(gt[1], t)) > Number(gt[2]));
      else if (lt) rows = rows.filter(t => Number(field(lt[1], t)) < Number(lt[2]));
    }
  }

  /* ORDER BY */
  const orderM = query.match(/order\s+by\s+(\w+)(?:\s+(asc|desc))?/i);
  if (orderM) {
    const [, col, dir] = orderM;
    const asc = (dir || "asc").toLowerCase() === "asc";
    rows.sort((a, b) => {
      const va = (() => {
        switch (col.toLowerCase()) {
          case "date": return new Date(a.firstTime).getTime();
          case "name": return (a.metadata?.name || "").toLowerCase();
          case "editions": return Number(a.totalSupply || 0);
          default: return "";
        }
      })();
      const vb = (() => {
        switch (col.toLowerCase()) {
          case "date": return new Date(b.firstTime).getTime();
          case "name": return (b.metadata?.name || "").toLowerCase();
          case "editions": return Number(b.totalSupply || 0);
          default: return "";
        }
      })();
      if (typeof va === "number") return asc ? va - vb : vb - va;
      return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }

  /* LIMIT */
  const limitM = query.match(/limit\s+(\d+)/i);
  if (limitM) rows = rows.slice(0, Number(limitM[1]));

  if (isCount) return { count: rows.length };
  return { rows };
}

const SQL_EXAMPLES = [
  "SELECT * FROM mints WHERE format LIKE '%video%'",
  "SELECT * FROM mints WHERE platform LIKE '%Hic%' ORDER BY date DESC",
  "SELECT * FROM mints WHERE editions > 10 ORDER BY editions DESC",
  "SELECT * FROM mints ORDER BY date ASC LIMIT 5",
  "SELECT COUNT(*) FROM mints",
  "SELECT * FROM mints WHERE name LIKE '%portrait%'",
];

/* ─────────────────────────────────────────────
   ARTIST CAPTION via Anthropic API
───────────────────────────────────────────── */
async function generateCaption(token) {
  const m = token.metadata || {};
  const prompt = `Write an artist caption (2–3 sentences, no hashtags, no "I made this" framing) for this NFT by killjoyINK:

Title: ${m.name || "Untitled"}
Description: ${m.description || "none"}
Tags: ${(m.tags || []).join(", ") || "none"}
Platform: ${getPlatform(token)}
Date minted: ${fmtDate(token.firstTime)}
Editions: ${token.totalSupply}
Format: ${getMime(token) || "image"}

Style: terse, poetic, slightly sardonic, technically-aware without showing off — like the work is explaining itself if it could talk. Think: smart artist who's seen too much internet, but still finds beauty in the specifics.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      system: `You are ghostwriting artist captions for killjoyINK, a Tezos NFT artist. 
killjoyINK is a Visual/3D Graphics artist, Animator, and AR Developer. 
Voice: sophisticated, dry, occasionally self-aware, never pretentious. 
Dave Chappelle energy — insightful and real, with just enough wit to keep it interesting.
Output ONLY the caption. No quotes. No preamble.`,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || null;
}

/* ─────────────────────────────────────────────
   STYLES (injected)
───────────────────────────────────────────── */
const GLOBAL_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:    #0a0a0a;
    --surf:  #111;
    --surf2: #181818;
    --brd:   #222;
    --brd2:  #2e2e2e;
    --tx:    #f0ece4;
    --mut:   #7a7a74;
    --fnt:   #3a3a36;
    --acc:   #c05a1f;
    --acc2:  #e07a3f;
    --teal:  #4a8f9e;
    --mono:  'IBM Plex Mono', 'Courier New', monospace;
    --r:     5px;
    --rg:    9px;
  }
  body { background: var(--bg); color: var(--tx); font-family: system-ui, sans-serif; overflow-x: hidden; }
  input, select, button, textarea { font-family: inherit; }
  a { color: var(--teal); text-decoration: none; }
  a:hover { color: var(--acc2); }
  ::-webkit-scrollbar { width: 5px; background: var(--surf); }
  ::-webkit-scrollbar-thumb { background: var(--brd2); border-radius: 3px; }
  ::placeholder { color: var(--fnt); }
  @keyframes fadeUp   { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
  @keyframes slideIn  { from { transform:translateX(32px); opacity:0; } to { transform:translateX(0); opacity:1; } }
  @keyframes spin     { to { transform: rotate(360deg); } }
  .anim-card  { animation: fadeUp 0.3s ease both; }
  .anim-panel { animation: slideIn 0.22s ease both; }
  select option { background: #181818; color: #f0ece4; }
`;

/* ─────────────────────────────────────────────
   TOKEN CARD
───────────────────────────────────────────── */
function TokenCard({ token, onOpen, delay = 0 }) {
  const m    = token.metadata || {};
  const name = m.name || `OBJKT #${token.tokenId}`;
  const th   = ipfs(m.thumbnailUri || m.displayUri);
  const cat  = getMimeCat(getMime(token));
  const [hover, setHover] = useState(false);

  return (
    <div className="anim-card"
      role="button" tabIndex={0}
      onClick={() => onOpen(token)}
      onKeyDown={e => (e.key==="Enter"||e.key===" ") && onOpen(token)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        animationDelay: `${delay}s`,
        background: "var(--surf)", border: `1px solid ${hover ? "var(--acc)" : "var(--brd)"}`,
        borderRadius: "var(--rg)", overflow: "hidden", cursor: "pointer",
        transform: hover ? "translateY(-3px)" : "translateY(0)",
        transition: "border-color .15s, transform .15s",
      }}>
      <div style={{ aspectRatio:"1", background:"var(--surf2)", position:"relative", overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center" }}>
        {th
          ? <img src={th} alt={name} loading="lazy" style={{ width:"100%", height:"100%", objectFit:"cover" }}
                 onError={e => e.target.style.display="none"} />
          : <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--fnt)" }}>no preview</span>}
        {cat!=="image" && cat!=="unknown" && (
          <span style={{ position:"absolute", top:7, right:7, fontFamily:"var(--mono)", fontSize:8, background:"rgba(0,0,0,.82)", color:"var(--mut)", padding:"3px 7px", borderRadius:3, textTransform:"uppercase", letterSpacing:".05em" }}>{cat}</span>
        )}
      </div>
      <div style={{ padding:"11px 13px" }}>
        <p style={{ fontSize:12, fontWeight:500, color:"var(--tx)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:3 }} title={name}>{name}</p>
        <p style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--teal)", textTransform:"uppercase", letterSpacing:".05em", marginBottom:9 }}>{getPlatform(token)}</p>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--fnt)" }}>{fmtDate(token.firstTime)}</span>
          <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)", background:"var(--surf2)", padding:"2px 7px", borderRadius:3 }}>{Number(token.totalSupply||0).toLocaleString()} ed.</span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   LIST ROW
───────────────────────────────────────────── */
function TokenRow({ token, idx, onOpen }) {
  const m    = token.metadata || {};
  const name = m.name || `OBJKT #${token.tokenId}`;
  const th   = ipfs(m.thumbnailUri);
  const [hover, setHover] = useState(false);

  return (
    <tr onClick={() => onOpen(token)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{ borderBottom:"1px solid var(--brd)", cursor:"pointer", background: hover ? "var(--surf2)" : "transparent", transition:"background .12s" }}>
      <td style={{ padding:"9px 10px 9px 0", fontFamily:"var(--mono)", fontSize:9, color:"var(--fnt)", width:32 }}>{idx+1}</td>
      <td style={{ padding:"9px 10px 9px 0", width:44 }}>
        {th ? <img src={th} alt="" loading="lazy" style={{ width:36, height:36, objectFit:"cover", borderRadius:3, display:"block" }} onError={e => e.target.style.display="none"} />
            : <div style={{ width:36, height:36, background:"var(--surf2)", borderRadius:3 }} />}
      </td>
      <td style={{ padding:"9px 10px 9px 0", fontSize:12, fontWeight:500, color:"var(--tx)", maxWidth:220 }}>{name}</td>
      <td style={{ padding:"9px 10px 9px 0", fontFamily:"var(--mono)", fontSize:9, color:"var(--teal)" }}>{getPlatform(token)}</td>
      <td style={{ padding:"9px 10px 9px 0", fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)" }}>{fmtDate(token.firstTime)}</td>
      <td style={{ padding:"9px 10px 9px 0", fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)" }}>{Number(token.totalSupply||0).toLocaleString()}</td>
      <td style={{ padding:"9px 0", fontFamily:"var(--mono)", fontSize:8, color:"var(--fnt)" }}>{getMime(token) || "—"}</td>
    </tr>
  );
}

/* ─────────────────────────────────────────────
   MINT DETAIL PAGE (individual page view)
───────────────────────────────────────────── */
function MintDetailPage({ token, onBack }) {
  const m      = token.metadata || {};
  const name   = m.name || `OBJKT #${token.tokenId}`;
  const art    = ipfs(m.artifactUri);
  const disp   = ipfs(m.displayUri || m.thumbnailUri);
  const mime   = getMime(token);
  const cat    = getMimeCat(mime);
  const desc   = m.description || "";
  const tags   = m.tags || [];
  const plat   = getPlatform(token);
  const addr   = token.contract?.address || "";
  const isHEN  = addr === HEN_CT;
  const ipfsH  = m.artifactUri?.replace("ipfs://","") || "";
  const royalty = m.royalties
    ? ((Object.values(m.royalties.shares||{})[0]||0)/10).toFixed(1)+"%"
    : "—";

  const [caption, setCaption]     = useState(null);
  const [capLoading, setCapLoading]= useState(false);
  const [capError, setCapError]   = useState(null);

  const fetchCaption = async () => {
    setCapLoading(true); setCapError(null);
    try {
      const c = await generateCaption(token);
      setCaption(c);
    } catch(e) {
      setCapError("Caption generation failed. The blockchain ate my homework.");
    } finally {
      setCapLoading(false);
    }
  };

  const metaRows = [
    ["Token ID",   `#${token.tokenId}`],
    ["Platform",   plat],
    ["Contract",   token.contract?.alias || addr.slice(0,22)+"…"],
    ["Minted",     fmtDate(token.firstTime)],
    ["Block #",    (token.firstLevel||"—").toLocaleString?.() || "—"],
    ["Editions",   Number(token.totalSupply||0).toLocaleString()],
    ["Format",     mime || "—"],
    ["Media",      cat],
    ["Royalties",  royalty],
    ["Creator",    `${WALLET.slice(0,10)}…${WALLET.slice(-6)}`],
    ["IPFS",       ipfsH ? ipfsH.slice(0,28)+"…" : "—"],
  ];

  /* JSON-LD for SEO — injected into document head */
  useEffect(() => {
    const script = document.createElement("script");
    script.type  = "application/ld+json";
    script.id    = "mint-schema";
    script.text  = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "VisualArtwork",
      "name": name,
      "description": desc || name,
      "url": getObjktUrl(addr, token.tokenId),
      "image": disp,
      "creator": { "@type":"Person", "name":"killjoyINK", "url":"https://teia.art/killjoyink" },
      "dateCreated": token.firstTime?.split("T")[0],
      "artMedium": mime || "Digital",
      "artworkSurface": "Blockchain (Tezos)",
      "numberOfItems": token.totalSupply,
      "identifier": `${addr}/${token.tokenId}`,
    });
    document.head.appendChild(script);
    return () => { const el = document.getElementById("mint-schema"); if (el) el.remove(); };
  }, [token]);

  return (
    <div style={{ maxWidth:960, margin:"0 auto", padding:"20px 24px 40px" }}>
      {/* Back nav */}
      <button onClick={onBack}
              style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--mut)", background:"none", border:"1px solid var(--brd2)", borderRadius:"var(--r)", padding:"6px 12px", cursor:"pointer", marginBottom:24, letterSpacing:".04em" }}>
        ← back to archive
      </button>

      {/* Two-column layout */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:32, alignItems:"start" }}>

        {/* Left — artwork */}
        <div>
          <div style={{ background:"var(--surf2)", borderRadius:"var(--rg)", overflow:"hidden", aspectRatio:"1", display:"flex", alignItems:"center", justifyContent:"center", marginBottom:16 }}>
            {cat==="video" && art
              ? <video src={art} autoPlay loop muted playsInline controls style={{ maxWidth:"100%", maxHeight:"100%", objectFit:"contain" }} />
              : cat==="audio" && art
              ? <div style={{ padding:24, width:"100%" }}><audio src={art} controls style={{ width:"100%" }} /></div>
              : disp
              ? <img src={disp} alt={name} style={{ maxWidth:"100%", maxHeight:"100%", objectFit:"contain" }} />
              : <span style={{ fontFamily:"var(--mono)", fontSize:11, color:"var(--fnt)" }}>No preview</span>}
          </div>

          {/* Artist Caption panel */}
          <div style={{ background:"var(--surf)", border:"1px solid var(--brd2)", borderRadius:"var(--rg)", padding:18 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--fnt)", textTransform:"uppercase", letterSpacing:".08em" }}>Artist Caption</span>
              {!caption && (
                <button onClick={fetchCaption} disabled={capLoading}
                        style={{ fontFamily:"var(--mono)", fontSize:9, padding:"5px 11px", background:capLoading?"var(--brd2)":"var(--acc)", color:"#fff", border:"none", borderRadius:"var(--r)", cursor:capLoading?"wait":"pointer" }}>
                  {capLoading ? "writing…" : "Generate ✦"}
                </button>
              )}
            </div>
            {caption && (
              <p style={{ fontSize:13, fontStyle:"italic", color:"var(--tx)", lineHeight:1.65, fontFamily:"Georgia, serif", fontWeight:300 }}>"{caption}"</p>
            )}
            {!caption && !capLoading && (
              <p style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--fnt)", lineHeight:1.6 }}>
                Generate an artist-voice caption for this work using AI trained on killjoyINK's style.
              </p>
            )}
            {capError && (
              <p style={{ fontFamily:"var(--mono)", fontSize:9, color:"#a04040" }}>{capError}</p>
            )}
          </div>
        </div>

        {/* Right — metadata */}
        <div>
          <h1 style={{ fontFamily:"Georgia, serif", fontWeight:300, fontSize:"1.6rem", letterSpacing:"-.02em", color:"var(--tx)", marginBottom:8, lineHeight:1.2 }}>{name}</h1>
          <p style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--teal)", textTransform:"uppercase", letterSpacing:".06em", marginBottom:20 }}>{plat}</p>

          {desc && (
            <p style={{ fontSize:13, color:"var(--mut)", lineHeight:1.65, fontStyle:"italic", fontFamily:"Georgia, serif", fontWeight:300, marginBottom:24, paddingBottom:20, borderBottom:"1px solid var(--brd)" }}>
              {desc}
            </p>
          )}

          {/* Metadata table */}
          <table style={{ width:"100%", borderCollapse:"collapse", marginBottom:20 }}>
            <tbody>
              {metaRows.map(([k,v]) => (
                <tr key={k} style={{ borderBottom:"1px solid var(--brd)" }}>
                  <td style={{ padding:"8px 0", fontFamily:"var(--mono)", fontSize:8, color:"var(--fnt)", textTransform:"uppercase", letterSpacing:".08em", width:"38%", paddingRight:12 }}>{k}</td>
                  <td style={{ padding:"8px 0", fontFamily:"var(--mono)", fontSize:10, color:"var(--tx)", wordBreak:"break-all" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Tags */}
          {tags.length > 0 && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:24 }}>
              {tags.map(t => (
                <span key={t} style={{ fontFamily:"var(--mono)", fontSize:8, background:"var(--surf2)", border:"1px solid var(--brd2)", borderRadius:3, padding:"3px 9px", color:"var(--mut)" }}>#{t}</span>
              ))}
            </div>
          )}

          {/* Actions */}
          <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
            {[
              ["Objkt ↗",       getObjktUrl(addr, token.tokenId)],
              isHEN && ["Teia ↗", getTeiaUrl(token.tokenId)],
              ipfsH && ["IPFS artifact ↗", `https://ipfs.io/ipfs/${ipfsH}`],
              [`TZKT block ↗`,   `https://tzkt.io/${WALLET}/tokens`],
            ].filter(Boolean).map(([label, href]) => (
              <a key={label} href={href} target="_blank" rel="noopener noreferrer"
                 style={{ fontFamily:"var(--mono)", fontSize:9, padding:"8px 13px", border:"1px solid var(--brd2)", borderRadius:"var(--r)", color:"var(--mut)", transition:"border-color .15s, color .15s" }}
                 onMouseEnter={e => { e.target.style.borderColor="var(--acc)"; e.target.style.color="var(--acc)"; }}
                 onMouseLeave={e => { e.target.style.borderColor="var(--brd2)"; e.target.style.color="var(--mut)"; }}>
                {label}
              </a>
            ))}
          </div>

          {/* Provenance note */}
          <div style={{ marginTop:28, padding:14, background:"var(--surf)", border:"1px solid var(--brd)", borderRadius:"var(--r)" }}>
            <p style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--fnt)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:6 }}>Provenance</p>
            <p style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)", lineHeight:1.7 }}>
              Minted by <span style={{ color:"var(--tx)" }}>{WALLET.slice(0,10)}…{WALLET.slice(-6)}</span> on {fmtDate(token.firstTime)} (block {(token.firstLevel||"—").toLocaleString?.() || "—"}).
              {isHEN ? " Originally published via HicEtNunc; mirrored on Teia and indexed by Objkt." : " Published via Objkt.com minting factory."}
              {" "}Token ID #{token.tokenId} on contract {addr.slice(0,10)}….
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   SQL PANEL
───────────────────────────────────────────── */
function SQLPanel({ tokens, onResultClick }) {
  const [query,   setQuery]   = useState("");
  const [results, setResults] = useState(null);
  const [error,   setError]   = useState(null);
  const textRef = useRef();

  const run = () => {
    if (!query.trim()) return;
    const out = runSQL(query, tokens);
    if (out.error) { setError(out.error); setResults(null); }
    else { setError(null); setResults(out); }
  };

  const loadExample = ex => {
    setQuery(ex);
    setResults(null); setError(null);
    textRef.current?.focus();
  };

  return (
    <div style={{ background:"var(--surf)", borderTop:"1px solid var(--brd2)", padding:"20px 28px 24px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
        <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--fnt)", textTransform:"uppercase", letterSpacing:".1em" }}>SQL Query Interface</span>
        <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)" }}>{tokens.length} rows available</span>
      </div>

      {/* Input */}
      <div style={{ display:"flex", gap:8, marginBottom:10 }}>
        <textarea ref={textRef} value={query} onChange={e=>setQuery(e.target.value)}
                  rows={2}
                  placeholder="SELECT * FROM mints WHERE format LIKE '%video%' ORDER BY date DESC"
                  onKeyDown={e => { if (e.key==="Enter" && (e.metaKey||e.ctrlKey)) run(); }}
                  style={{ flex:1, background:"var(--bg)", border:"1px solid var(--brd2)", borderRadius:"var(--r)", padding:"10px 13px", color:"var(--tx)", fontFamily:"var(--mono)", fontSize:10, resize:"vertical", outline:"none", lineHeight:1.5 }} />
        <button onClick={run}
                style={{ background:"var(--acc)", color:"#fff", border:"none", borderRadius:"var(--r)", padding:"0 18px", cursor:"pointer", fontFamily:"var(--mono)", fontSize:10, flexShrink:0, alignSelf:"stretch" }}>
          Run ↵
        </button>
      </div>

      {/* Examples */}
      <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:16 }}>
        {SQL_EXAMPLES.map(ex => (
          <button key={ex} onClick={() => loadExample(ex)}
                  style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--teal)", background:"none", border:"1px solid var(--brd)", borderRadius:3, padding:"4px 10px", cursor:"pointer" }}>
            {ex.length > 48 ? ex.slice(0,48)+"…" : ex}
          </button>
        ))}
      </div>

      {/* Results */}
      {error && <p style={{ fontFamily:"var(--mono)", fontSize:10, color:"#a05050", marginTop:10 }}>Error: {error}</p>}
      {results?.count !== undefined && (
        <p style={{ fontFamily:"var(--mono)", fontSize:11, color:"var(--tx)", marginTop:10 }}>COUNT(*) = <strong>{results.count}</strong></p>
      )}
      {results?.rows && (
        <div style={{ marginTop:12, overflowX:"auto" }}>
          <p style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)", marginBottom:8 }}>{results.rows.length} row{results.rows.length!==1?"s":""} returned · click a row to open</p>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10 }}>
            <thead>
              <tr style={{ borderBottom:"1px solid var(--brd2)" }}>
                {["#","name","platform","date","editions","format"].map(h => (
                  <th key={h} style={{ textAlign:"left", fontFamily:"var(--mono)", fontSize:7, color:"var(--fnt)", textTransform:"uppercase", letterSpacing:".08em", fontWeight:400, padding:"6px 10px 6px 0" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.rows.map((t, i) => (
                <tr key={t.id||i} onClick={() => onResultClick(t)} style={{ borderBottom:"1px solid var(--brd)", cursor:"pointer" }}
                    onMouseEnter={e => e.currentTarget.style.background="var(--surf2)"}
                    onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                  <td style={{ padding:"7px 10px 7px 0", fontFamily:"var(--mono)", fontSize:8, color:"var(--fnt)" }}>{i+1}</td>
                  <td style={{ padding:"7px 10px 7px 0", fontWeight:500, maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{t.metadata?.name || `#${t.tokenId}`}</td>
                  <td style={{ padding:"7px 10px 7px 0", fontFamily:"var(--mono)", fontSize:9, color:"var(--teal)" }}>{getPlatform(t)}</td>
                  <td style={{ padding:"7px 10px 7px 0", fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)" }}>{fmtDate(t.firstTime)}</td>
                  <td style={{ padding:"7px 10px 7px 0", fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)" }}>{Number(t.totalSupply||0).toLocaleString()}</td>
                  <td style={{ padding:"7px 0", fontFamily:"var(--mono)", fontSize:8, color:"var(--fnt)" }}>{getMime(t)||"—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   MAIN APP
───────────────────────────────────────────── */
export default function KilljoyINKArchives() {
  const [tokens,   setTokens]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [search,   setSearch]   = useState("");
  const [platF,    setPlatF]    = useState("all");
  const [mediaF,   setMediaF]   = useState("all");
  const [sort,     setSort]     = useState("date-desc");
  const [viewMode, setViewMode] = useState("grid");
  const [showSQL,  setShowSQL]  = useState(false);
  const [activePage, setActivePage] = useState("archive"); // "archive" | "mint"
  const [activeToken, setActiveToken] = useState(null);

  /* fetch */
  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch(`${TZKT}/tokens?firstMinter=${WALLET}&standard=fa2&limit=200&sort.desc=firstTime`);
        if (!res.ok) throw new Error(`TZKT returned HTTP ${res.status}`);
        const data = await res.json();
        setTokens(data.filter(t => t.metadata?.name && !DEGEN.test(t.metadata?.symbol||"") && t.standard==="fa2"));
      } catch(e) { setError(e.message); }
      finally { setLoading(false); }
    })();
  }, []);

  /* filter + sort */
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return tokens
      .filter(t => {
        const m = t.metadata||{};
        const matchQ = !q || [m.name,m.description,...(m.tags||[])].join(" ").toLowerCase().includes(q);
        const p = getPlatform(t).toLowerCase();
        const matchP = platF==="all" || (platF==="hen"&&p.includes("hic")) || (platF==="objkt"&&p.includes("objkt"));
        const matchM = mediaF==="all" || getMimeCat(getMime(t))===mediaF;
        return matchQ && matchP && matchM;
      })
      .sort((a, b) => {
        if (sort==="date-asc")     return new Date(a.firstTime)-new Date(b.firstTime);
        if (sort==="name")         return (a.metadata?.name||"").localeCompare(b.metadata?.name||"");
        if (sort==="editions-desc")return Number(b.totalSupply||0)-Number(a.totalSupply||0);
        return new Date(b.firstTime)-new Date(a.firstTime);
      });
  }, [tokens,search,platF,mediaF,sort]);

  /* stats */
  const stats = useMemo(() => {
    const contracts = new Set(tokens.map(t=>t.contract?.address)).size;
    const editions  = tokens.reduce((s,t)=>s+Number(t.totalSupply||0),0);
    const sorted    = [...tokens].sort((a,b)=>new Date(a.firstTime)-new Date(b.firstTime));
    return { count:tokens.length, editions, contracts, earliest: sorted[0]?.firstTime, latest: sorted[sorted.length-1]?.firstTime };
  }, [tokens]);

  /* CSV export */
  const exportCSV = useCallback(() => {
    const hdr = ["token_id","name","description","contract_address","contract_alias","platform","mint_date","mint_block","total_editions","mime_type","media_category","tags","artifact_uri","display_uri","objkt_url"];
    const rows = filtered.map(t => {
      const m=t.metadata||{};
      return [t.tokenId,m.name||"",(m.description||"").replace(/\r?\n/g," "),t.contract?.address||"",t.contract?.alias||"",getPlatform(t),
              t.firstTime?new Date(t.firstTime).toISOString().split("T")[0]:"",t.firstLevel||"",t.totalSupply||"",getMime(t)||"",getMimeCat(getMime(t)),(m.tags||[]).join("; "),m.artifactUri||"",m.displayUri||"",getObjktUrl(t.contract?.address||"",t.tokenId)];
    });
    const csv = [hdr,...rows].map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\r\n");
    const a = Object.assign(document.createElement("a"), { href:URL.createObjectURL(new Blob([csv],{type:"text/csv"})), download:`killjoyink-archives-${new Date().toISOString().split("T")[0]}.csv` });
    a.click();
  }, [filtered]);

  const openMint = t => { setActiveToken(t); setActivePage("mint"); };
  const closeM   = () => { setActiveToken(null); setActivePage("archive"); };

  /* Shared input/button styles */
  const inp = { background:"var(--bg)", border:"1px solid var(--brd2)", borderRadius:"var(--r)", padding:"7px 11px", color:"var(--tx)", fontFamily:"var(--mono)", fontSize:10, outline:"none" };
  const vBtn= active => ({ ...inp, cursor:"pointer", padding:"6px 9px", border:`1px solid ${active?"var(--acc)":"var(--brd2)"}`, color:active?"var(--acc)":"var(--mut)", background:active?"rgba(192,90,31,.12)":"transparent", fontSize:12 });

  /* ── RENDER: MINT PAGE ── */
  if (activePage==="mint" && activeToken) {
    return (
      <>
        <style>{GLOBAL_CSS}</style>
        <div style={{ background:"var(--bg)", color:"var(--tx)", minHeight:"100vh" }}>
          {/* slim header */}
          <header style={{ borderBottom:"1px solid var(--brd)", padding:"14px 24px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <span style={{ fontFamily:"Georgia, serif", fontSize:"1rem", fontWeight:300, color:"var(--tx)", letterSpacing:"-.01em" }}>
              KilljoyINK<span style={{ color:"var(--acc)", fontStyle:"italic" }}>Archives</span>
            </span>
            <button onClick={closeM} style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)", background:"none", border:"1px solid var(--brd2)", borderRadius:"var(--r)", padding:"5px 11px", cursor:"pointer" }}>← archive</button>
          </header>
          <MintDetailPage token={activeToken} onBack={closeM} />
        </div>
      </>
    );
  }

  /* ── RENDER: ARCHIVE HOME ── */
  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <div style={{ background:"var(--bg)", color:"var(--tx)", minHeight:"100vh", fontFamily:"system-ui, sans-serif" }}>

        {/* ── HEADER ── */}
        <header style={{ borderBottom:"1px solid var(--brd)", padding:"22px 28px 18px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:14, marginBottom:12 }}>
            <div>
              <h1 style={{ fontFamily:"Georgia, serif", fontWeight:300, fontSize:"1.85rem", letterSpacing:"-.02em", lineHeight:1.1, color:"var(--tx)", marginBottom:5 }}>
                KilljoyINK<span style={{ color:"var(--acc)", fontStyle:"italic" }}>Archives</span>
              </h1>
              <p style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--mut)", letterSpacing:".02em" }}>tz1QtcA4MvmCSLJ7DdvHzXEq2sm2bEC37xdG · visual/3d · animator · ar developer</p>
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
              {[["Objkt ↗","https://objkt.com/@killjoyink/created"],["Teia ↗","https://teia.art/killjoyink"]].map(([l,h])=>(
                <a key={l} href={h} target="_blank" rel="noopener noreferrer"
                   style={{ fontFamily:"var(--mono)", fontSize:9, padding:"6px 11px", border:"1px solid var(--brd2)", borderRadius:"var(--r)", color:"var(--mut)" }}>{l}</a>
              ))}
              <button onClick={exportCSV} style={{ ...inp, cursor:"pointer", padding:"6px 11px", fontSize:9 }}>Export CSV ↓</button>
              <button onClick={() => setShowSQL(s=>!s)}
                      style={{ ...inp, cursor:"pointer", padding:"6px 11px", fontSize:9, borderColor:showSQL?"var(--acc)":"var(--brd2)", color:showSQL?"var(--acc)":"var(--mut)" }}>
                {showSQL ? "SQL ✕" : "SQL ⌖"}
              </button>
            </div>
          </div>
          <p style={{ fontFamily:"Georgia, serif", fontSize:12, fontStyle:"italic", color:"var(--mut)", fontWeight:300, lineHeight:1.6, maxWidth:560 }}>
            Every token. Every block. Every edition. Because someone has to keep the receipts — and the blockchain sure won't narrate itself.
          </p>
        </header>

        {/* ── STATS ── */}
        {!loading && tokens.length>0 && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5, 1fr)", borderBottom:"1px solid var(--brd)" }}>
            {[
              { label:"tokens minted",  val: stats.count },
              { label:"total editions", val: stats.editions.toLocaleString() },
              { label:"smart contracts",val: stats.contracts },
              { label:"first mint",     val: stats.earliest ? fmtYear(stats.earliest) : "—" },
              { label:"latest mint",    val: stats.latest   ? fmtDate(stats.latest) : "—" },
            ].map(({ label, val }) => (
              <div key={label} style={{ padding:"12px 18px", borderRight:"1px solid var(--brd)" }}>
                <span style={{ display:"block", fontFamily:"var(--mono)", fontSize:7, color:"var(--fnt)", textTransform:"uppercase", letterSpacing:".09em", marginBottom:4 }}>{label}</span>
                <span style={{ display:"block", fontFamily:"var(--mono)", fontSize:"1.2rem", fontWeight:500, color:"var(--tx)", letterSpacing:"-.02em" }}>{val}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── CONTROLS ── */}
        <div style={{ padding:"12px 28px", borderBottom:"1px solid var(--brd)", background:"var(--surf)", position:"sticky", top:0, zIndex:10 }}>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
            {/* search */}
            <div style={{ flex:1, minWidth:180, position:"relative" }}>
              <svg style={{ position:"absolute", left:9, top:"50%", transform:"translateY(-50%)", color:"var(--fnt)", pointerEvents:"none" }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input type="search" placeholder="search titles, tags, descriptions…" value={search} onChange={e=>setSearch(e.target.value)}
                     style={{ ...inp, width:"100%", paddingLeft:27, fontSize:10 }} />
            </div>
            {/* filters */}
            {[
              { val:platF,  set:setPlatF,  opts:[["all","all platforms"],["hen","Hic Et Nunc / Teia"],["objkt","Objkt.com"]] },
              { val:mediaF, set:setMediaF, opts:[["all","all media"],["image","image"],["video","video"],["audio","audio"],["interactive","interactive"]] },
              { val:sort,   set:setSort,   opts:[["date-desc","newest"],["date-asc","oldest"],["name","name A–Z"],["editions-desc","most editions"]] },
            ].map((s,i) => (
              <select key={i} value={s.val} onChange={e=>s.set(e.target.value)} style={{ ...inp, cursor:"pointer" }}>
                {s.opts.map(([v,l])=><option key={v} value={v}>{l}</option>)}
              </select>
            ))}
            {/* view toggle */}
            <div style={{ display:"flex", gap:3 }}>
              {[["grid","⊞"],["list","≡"]].map(([m,ic])=>(
                <button key={m} onClick={()=>setViewMode(m)} style={vBtn(viewMode===m)}>{ic}</button>
              ))}
            </div>
          </div>
          {!loading && (
            <p style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--fnt)", marginTop:8, letterSpacing:".04em" }}>
              {filtered.length} of {tokens.length} tokens · live data via TZKT API
            </p>
          )}
        </div>

        {/* ── MAIN CONTENT ── */}
        <main style={{ padding: showSQL ? "20px 28px 0" : "20px 28px 36px", minHeight:400 }}>
          {loading && (
            <div style={{ textAlign:"center", padding:"70px 20px", color:"var(--mut)" }}>
              <p style={{ fontSize:15, fontStyle:"italic", fontFamily:"Georgia, serif", marginBottom:8 }}>Querying the chain…</p>
              <p style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--fnt)" }}>{WALLET}</p>
              <div style={{ margin:"20px auto 0", width:20, height:20, border:"2px solid var(--brd2)", borderTopColor:"var(--acc)", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
            </div>
          )}

          {error && (
            <div style={{ padding:18, background:"#130808", border:"1px solid #502020", borderRadius:"var(--rg)", fontFamily:"var(--mono)", fontSize:10, maxWidth:560 }}>
              <p style={{ color:"#c06060", marginBottom:6, fontWeight:500 }}>Couldn't reach TZKT API</p>
              <p style={{ color:"var(--mut)" }}>{error}</p>
              <p style={{ marginTop:10, color:"var(--fnt)" }}>Verify directly at <a href={`https://tzkt.io/${WALLET}/tokens`} target="_blank" rel="noopener noreferrer">tzkt.io</a></p>
            </div>
          )}

          {!loading && !error && tokens.length===0 && (
            <div style={{ textAlign:"center", padding:60, color:"var(--mut)" }}>
              <p style={{ fontStyle:"italic", fontSize:14, fontFamily:"Georgia, serif" }}>No art tokens found for this wallet.</p>
              <p style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--fnt)", marginTop:6 }}>{WALLET}</p>
            </div>
          )}

          {/* grid */}
          {!loading && filtered.length>0 && viewMode==="grid" && (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(195px, 1fr))", gap:16 }}>
              {filtered.map((t,i) => <TokenCard key={t.id||i} token={t} onOpen={openMint} delay={Math.min(i*0.04,0.5)} />)}
            </div>
          )}

          {/* list */}
          {!loading && filtered.length>0 && viewMode==="list" && (
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ borderBottom:"1px solid var(--brd2)" }}>
                  {["#","","title","platform","date","ed.","format"].map(h=>(
                    <th key={h} style={{ textAlign:"left", fontFamily:"var(--mono)", fontSize:7, color:"var(--fnt)", textTransform:"uppercase", letterSpacing:".09em", fontWeight:400, padding:"7px 10px 7px 0" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((t,i) => <TokenRow key={t.id||i} token={t} idx={i} onOpen={openMint} />)}
              </tbody>
            </table>
          )}
        </main>

        {/* ── SQL PANEL ── */}
        {showSQL && <SQLPanel tokens={filtered} onResultClick={openMint} />}

        {/* ── FOOTER ── */}
        <footer style={{ borderTop:"1px solid var(--brd)", padding:"14px 28px", fontFamily:"var(--mono)", fontSize:8, color:"var(--fnt)", lineHeight:1.9, marginTop:showSQL?0:0 }}>
          <p>Data: <a href="https://tzkt.io" target="_blank" rel="noopener noreferrer">TZKT API</a> by Baking Bad · Media via IPFS public gateway · Built with LIS best practices · <a href="https://github.com/killjoyink/archives" target="_blank" rel="noopener noreferrer">GitHub ↗</a></p>
          <p>An independent documentation project. Not affiliated with Objkt, Teia, or Tezos Foundation.</p>
        </footer>
      </div>
    </>
  );
}

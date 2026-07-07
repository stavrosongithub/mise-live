// ============================================================================
// Mise — cook-render.js (Phase 18 / Plan 18-01)
// ----------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for the Cook-this-day standalone sheet's CSS, runtime,
// and document skeleton (CONTEXT 18: "Single source of truth"). Both the local
// offline blob (app.js _renderCookArtifactHtml) and the future hosted cook.html
// viewer (18-04) consume THIS module so the sheet can never drift between them.
//
// This module has ZERO imports — no Alpine, no PapaParse, no esm.sh, no DOM or
// browser globals at module top level — exactly like cook-artifact.js /
// scale.js / schema.js. That is what lets BOTH the browser (app.js) AND a Node
// test (scripts/cook-render.test.mjs) import it unchanged. Do NOT add a
// browser/CDN import here, reference `document`/`window`/`this` at the module
// top level, or read app state — the Node test stops working and the purity
// contract breaks.
//
// NOTE: COOK_RUNTIME is a STRING that contains code which DOES use `document`
// /`window`/`navigator`. That code is never executed in Node — it only runs
// inside the generated standalone document. Keeping it as a string is exactly
// what preserves this module's purity.
//
// The CSS + runtime + body skeleton here are a VERBATIM lift out of the former
// app.js `_renderCookArtifactHtml` body (Phase 6 / Plan 06-02). This plan
// (18-01) makes NO visible/behavioural change — it only moves WHERE they live.
// 18-02 restyles COOK_CSS; 18-04 reuses renderCookDocument for the viewer.
// ============================================================================

// ----------------------------------------------------------------------------
// LZSTRING_MIN — canonical lz-string v1.5.0 minified UMD source, VENDORED ONCE
// here so both the in-sheet Share runtime (compress) and the hosted cook.html
// viewer (decompress) get it WITHOUT any esm.sh / CDN fetch at open-time (D-01:
// the sheet must work fully offline; 18-04 viewer must render even if esm.sh is
// down). renderCookDocument injects this as a `<script>` BEFORE the dataIsland
// and BEFORE COOK_RUNTIME, so it defines a global `LZString` (with
// compressToEncodedURIComponent / decompressFromEncodedURIComponent) that both
// the viewer's hash-decode preamble and COOK_RUNTIME can call.
//
// Provenance: https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js
// lz-string v1.5.0 — © pieroxy — MIT License. Do NOT hand-edit; re-fetch that
// exact URL to update. The source is a single line with no backtick / ${ /
// backslash, so it embeds safely verbatim inside this template literal.
// ----------------------------------------------------------------------------
export const LZSTRING_MIN = `var LZString=function(){var r=String.fromCharCode,o="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",n="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$",e={};function t(r,o){if(!e[r]){e[r]={};for(var n=0;n<r.length;n++)e[r][r.charAt(n)]=n}return e[r][o]}var i={compressToBase64:function(r){if(null==r)return"";var n=i._compress(r,6,function(r){return o.charAt(r)});switch(n.length%4){default:case 0:return n;case 1:return n+"===";case 2:return n+"==";case 3:return n+"="}},decompressFromBase64:function(r){return null==r?"":""==r?null:i._decompress(r.length,32,function(n){return t(o,r.charAt(n))})},compressToUTF16:function(o){return null==o?"":i._compress(o,15,function(o){return r(o+32)})+" "},decompressFromUTF16:function(r){return null==r?"":""==r?null:i._decompress(r.length,16384,function(o){return r.charCodeAt(o)-32})},compressToUint8Array:function(r){for(var o=i.compress(r),n=new Uint8Array(2*o.length),e=0,t=o.length;e<t;e++){var s=o.charCodeAt(e);n[2*e]=s>>>8,n[2*e+1]=s%256}return n},decompressFromUint8Array:function(o){if(null==o)return i.decompress(o);for(var n=new Array(o.length/2),e=0,t=n.length;e<t;e++)n[e]=256*o[2*e]+o[2*e+1];var s=[];return n.forEach(function(o){s.push(r(o))}),i.decompress(s.join(""))},compressToEncodedURIComponent:function(r){return null==r?"":i._compress(r,6,function(r){return n.charAt(r)})},decompressFromEncodedURIComponent:function(r){return null==r?"":""==r?null:(r=r.replace(/ /g,"+"),i._decompress(r.length,32,function(o){return t(n,r.charAt(o))}))},compress:function(o){return i._compress(o,16,function(o){return r(o)})},_compress:function(r,o,n){if(null==r)return"";var e,t,i,s={},u={},a="",p="",c="",l=2,f=3,h=2,d=[],m=0,v=0;for(i=0;i<r.length;i+=1)if(a=r.charAt(i),Object.prototype.hasOwnProperty.call(s,a)||(s[a]=f++,u[a]=!0),p=c+a,Object.prototype.hasOwnProperty.call(s,p))c=p;else{if(Object.prototype.hasOwnProperty.call(u,c)){if(c.charCodeAt(0)<256){for(e=0;e<h;e++)m<<=1,v==o-1?(v=0,d.push(n(m)),m=0):v++;for(t=c.charCodeAt(0),e=0;e<8;e++)m=m<<1|1&t,v==o-1?(v=0,d.push(n(m)),m=0):v++,t>>=1}else{for(t=1,e=0;e<h;e++)m=m<<1|t,v==o-1?(v=0,d.push(n(m)),m=0):v++,t=0;for(t=c.charCodeAt(0),e=0;e<16;e++)m=m<<1|1&t,v==o-1?(v=0,d.push(n(m)),m=0):v++,t>>=1}0==--l&&(l=Math.pow(2,h),h++),delete u[c]}else for(t=s[c],e=0;e<h;e++)m=m<<1|1&t,v==o-1?(v=0,d.push(n(m)),m=0):v++,t>>=1;0==--l&&(l=Math.pow(2,h),h++),s[p]=f++,c=String(a)}if(""!==c){if(Object.prototype.hasOwnProperty.call(u,c)){if(c.charCodeAt(0)<256){for(e=0;e<h;e++)m<<=1,v==o-1?(v=0,d.push(n(m)),m=0):v++;for(t=c.charCodeAt(0),e=0;e<8;e++)m=m<<1|1&t,v==o-1?(v=0,d.push(n(m)),m=0):v++,t>>=1}else{for(t=1,e=0;e<h;e++)m=m<<1|t,v==o-1?(v=0,d.push(n(m)),m=0):v++,t=0;for(t=c.charCodeAt(0),e=0;e<16;e++)m=m<<1|1&t,v==o-1?(v=0,d.push(n(m)),m=0):v++,t>>=1}0==--l&&(l=Math.pow(2,h),h++),delete u[c]}else for(t=s[c],e=0;e<h;e++)m=m<<1|1&t,v==o-1?(v=0,d.push(n(m)),m=0):v++,t>>=1;0==--l&&(l=Math.pow(2,h),h++)}for(t=2,e=0;e<h;e++)m=m<<1|1&t,v==o-1?(v=0,d.push(n(m)),m=0):v++,t>>=1;for(;;){if(m<<=1,v==o-1){d.push(n(m));break}v++}return d.join("")},decompress:function(r){return null==r?"":""==r?null:i._decompress(r.length,32768,function(o){return r.charCodeAt(o)})},_decompress:function(o,n,e){var t,i,s,u,a,p,c,l=[],f=4,h=4,d=3,m="",v=[],g={val:e(0),position:n,index:1};for(t=0;t<3;t+=1)l[t]=t;for(s=0,a=Math.pow(2,2),p=1;p!=a;)u=g.val&g.position,g.position>>=1,0==g.position&&(g.position=n,g.val=e(g.index++)),s|=(u>0?1:0)*p,p<<=1;switch(s){case 0:for(s=0,a=Math.pow(2,8),p=1;p!=a;)u=g.val&g.position,g.position>>=1,0==g.position&&(g.position=n,g.val=e(g.index++)),s|=(u>0?1:0)*p,p<<=1;c=r(s);break;case 1:for(s=0,a=Math.pow(2,16),p=1;p!=a;)u=g.val&g.position,g.position>>=1,0==g.position&&(g.position=n,g.val=e(g.index++)),s|=(u>0?1:0)*p,p<<=1;c=r(s);break;case 2:return""}for(l[3]=c,i=c,v.push(c);;){if(g.index>o)return"";for(s=0,a=Math.pow(2,d),p=1;p!=a;)u=g.val&g.position,g.position>>=1,0==g.position&&(g.position=n,g.val=e(g.index++)),s|=(u>0?1:0)*p,p<<=1;switch(c=s){case 0:for(s=0,a=Math.pow(2,8),p=1;p!=a;)u=g.val&g.position,g.position>>=1,0==g.position&&(g.position=n,g.val=e(g.index++)),s|=(u>0?1:0)*p,p<<=1;l[h++]=r(s),c=h-1,f--;break;case 1:for(s=0,a=Math.pow(2,16),p=1;p!=a;)u=g.val&g.position,g.position>>=1,0==g.position&&(g.position=n,g.val=e(g.index++)),s|=(u>0?1:0)*p,p<<=1;l[h++]=r(s),c=h-1,f--;break;case 2:return v.join("")}if(0==f&&(f=Math.pow(2,d),d++),l[c])m=l[c];else{if(c!==h)return null;m=i+i.charAt(0)}v.push(m),l[h++]=i+m.charAt(0),i=m,0==--f&&(f=Math.pow(2,d),d++)}}};return i}();"function"==typeof define&&define.amd?define(function(){return LZString}):"undefined"!=typeof module&&null!=module?module.exports=LZString:"undefined"!=typeof angular&&null!=angular&&angular.module("LZString",[]).factory("LZString",function(){return LZString});`;

// ----------------------------------------------------------------------------
// COOK_CSS — the literal standalone stylesheet (NOT the parent app's design
// tokens, D-01). Verbatim lift from the former `<style>` block. 18-02 restyles
// this; do NOT restyle here.
// ----------------------------------------------------------------------------
export const COOK_CSS = `
  /* STANDALONE artifact CSS — Mise design language HAND-PORTED to LITERAL values,
     NOT the parent app's design tokens / CSS custom properties (D-01). No web-font
     fetch: the faces are system humanist-sans + system-mono stacks that ECHO the
     design (18-RESEARCH §4) so the sheet renders fully OFFLINE.
     Tuned for kitchen-distance legibility: large body type, generous line-height. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 19px;
    line-height: 1.5;
    color: #1B2A28;        /* ink */
    background: #F3F2EC;    /* paper (enamel) */
  }
  .sheet { max-width: 820px; margin: 0 auto; }
  header.sheet-header {
    border-bottom: 3px solid #0E6E66;   /* petrol accent rule */
    padding-bottom: 16px;
    margin-bottom: 28px;
  }
  header.sheet-header h1 { font-size: 34px; font-weight: 700; margin: 0 0 8px; line-height: 1.2; color: #1B2A28; }
  .dish-index { margin: 8px 0 0; padding: 0; list-style: none; font-size: 17px; color: #5C6A66; }
  .dish-index li { margin: 2px 0; }
  .dish-index .srv {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    color: #8A958F;        /* faint */
  }
  .generated-at {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 14px;
    color: #8A958F;        /* faint */
    margin-top: 10px;
  }
  .dish {
    margin: 0 0 36px;
    padding: 20px 22px;
    background: #FFFFFF;    /* raised surface */
    border: 1px solid #E3E1D8;   /* hairline */
    border-radius: 7px;     /* card radius */
  }
  .dish h2 { font-size: 27px; font-weight: 700; margin: 0 0 6px; line-height: 1.2; color: #1B2A28; }
  .dish .servings {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 15px;
    color: #5C6A66;        /* muted */
    margin: 0 0 14px;
  }
  .prep-ahead {
    background: #FBF3E0;    /* amber ground */
    border-left: 5px solid #E0A93B;   /* amber border */
    padding: 10px 14px;
    margin: 0 0 16px;
    border-radius: 5px;     /* control radius */
  }
  /* EYEBROW (mono, uppercase, letter-spaced) — the strongest Mise design signal. */
  .prep-ahead .label {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-weight: 600;
    display: block;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #9A6212;        /* amber warn text (eyebrow stays in the warn family) */
  }
  /* EYEBROW (mono, uppercase, letter-spaced) — INGREDIENTS / METHOD. */
  h3.block-label {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 15px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #0E6E66;        /* petrol — the section-label motif */
    margin: 22px 0 9px;
  }
  /* quick-260707-nrg: component SUBHEADING inside an ingredient list ("Cheese
     Sauce", "Pasta"). Mirrors the block-label's mono/uppercase/tracking motif but
     is deliberately QUIET + SUBORDINATE to the petrol INGREDIENTS label — smaller,
     muted ink, lighter weight — so it reads as a within-list divider, not a peer. */
  .ing-section {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #8A958F;        /* muted ink — NOT petrol */
    margin: 16px 0 5px;
  }
  /* First section eyebrow sits right under the petrol INGREDIENTS label — kill its
     top margin so the two don't double-space. */
  .ing-section-first { margin-top: 4px; }
  ul.ingredients { margin: 0; padding: 0; list-style: none; }
  ul.ingredients li { padding: 5px 0; border-bottom: 1px solid #E3E1D8; display: flex; gap: 10px; align-items: baseline; }
  ul.ingredients .amt {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-weight: 600;
    flex: 0 0 auto;
    min-width: 58px;       /* narrow enough for the right column; name never tucks under it */
    color: #1B2A28;
  }
  /* Name takes the remaining width and wraps within its own area (not under the
     amount) — keeps the narrow ingredients column tidy. */
  ul.ingredients .ing-name { flex: 1 1 auto; min-width: 0; }
  ul.ingredients .vol {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    color: #8A958F;        /* faint */
  }
  ul.ingredients .role { color: #5C6A66; font-style: italic; font-size: 15px; }

  /* ---- Overview mise-en-place tick-off (Plan 18-03 Task 2) — DISPLAY-ONLY ----
     The checkbox lives ONLY on the Overview ingredients list (.ingredients-gather);
     the wizard's per-step collapsible list is built WITHOUT gather, so it never
     gets a tick (it stays the read-only reference list). A ticked <li> gets a
     subtle strike + faint — it must NOT alter the frozen amount/role text (D-05). */
  ul.ingredients-gather li { align-items: center; }
  .gather-tick {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 30px;             /* narrow footprint so the name keeps its width */
    min-height: 44px;            /* full kitchen-tablet tap height (≥44px vertical) */
    margin: -8px 6px -8px -4px;  /* tall hit area without bloating the row height */
    cursor: pointer;
  }
  /* In the (narrow) gather column, give the amount a touch less width so long
     ingredient names don't wrap to 3 lines next to the checkbox. */
  ul.ingredients-gather .amt { min-width: 48px; }
  .gather-cb {
    width: 24px;
    height: 24px;
    accent-color: #0E6E66;       /* petrol tick */
    cursor: pointer;
  }
  ul.ingredients-gather li.gathered .amt,
  ul.ingredients-gather li.gathered .ing-name,
  ul.ingredients-gather li.gathered .vol,
  ul.ingredients-gather li.gathered .role {
    text-decoration: line-through;
    opacity: 0.5;                /* faint — display only, text content unchanged */
  }
  .step-group { margin: 14px 0 0; }
  .step-group > .heading { font-weight: 600; font-size: 18px; margin: 14px 0 6px; color: #1B2A28; }
  ol.steps { margin: 0; padding-left: 1.6em; }
  ol.steps li { padding: 5px 0; }
  ol.steps .tip { display: block; margin-top: 4px; font-size: 15px; color: #5C6A66; font-style: italic; }
  .no-steps { color: #8A958F; font-style: italic; margin: 8px 0 0; }
  .serve-with { margin: 16px 0 0; font-style: italic; color: #5C6A66; }
  .serve-with .label { font-style: normal; font-weight: 600; color: #0E6E66; }

  /* ---- Two-column Overview body (Phase 18): METHOD left, INGREDIENTS right ----
     The dish head (name / servings / prep-ahead) stays full-width above; the body
     splits into a wider method column and a narrower ingredients column. The
     ingredients column is a quiet sticky card that follows the cook down a long
     method (sticky is bounded by the .dish, so it scrolls away with its dish). */
  .dish-cols {
    display: grid;
    grid-template-columns: 1.7fr 1fr;
    gap: 32px;
    align-items: start;     /* required for the sticky ingredients card to work */
  }
  .col-method { min-width: 0; }
  .col-method > h3.block-label:first-child { margin-top: 0; }
  .col-ingredients {
    min-width: 0;
    position: sticky;
    top: 16px;
    align-self: start;
    background: #FCFBF8;          /* surface — quiet, untinted card */
    border: 1px solid #E3E1D8;    /* hairline */
    border-radius: 7px;
    padding: 14px 16px 16px;
  }
  .col-ingredients > h3.block-label { margin-top: 0; }
  .col-ingredients ul.ingredients li:last-child { border-bottom: none; padding-bottom: 0; }
  /* Narrow viewport / mobile: stack to one column; the card stops sticking. */
  @media (max-width: 760px) {
    .dish-cols { grid-template-columns: 1fr; gap: 8px; }
    .col-ingredients { position: static; }
  }

  /* ---- Dual-mode toggle (D-08/D-09) — Plan 03 ---- */
  .mode-toggle {
    display: flex;
    gap: 0;
    margin: 0 auto 24px;
    max-width: 820px;
    border: 2px solid #0E6E66;   /* petrol */
    border-radius: 5px;          /* control radius */
    overflow: hidden;
  }
  .mode-toggle button {
    flex: 1 1 0;
    font: inherit;
    font-size: 18px;
    font-weight: 600;
    padding: 12px 16px;
    min-height: 44px;        /* kitchen-tablet tap target (≥44px) */
    border: none;
    background: #FFFFFF;
    color: #1B2A28;
    cursor: pointer;
  }
  .mode-toggle button + button { border-left: 2px solid #0E6E66; }
  .mode-toggle button[aria-pressed="true"] { background: #0E6E66; color: #FFFFFF; }

  /* ---- Share-link control (Plan 18-04) — screen-only (print hides .screen-only).
     A quiet outline button under the mode toggle; "Copied ✓" swaps its label ~2s.
     Lets the operator copy a data-in-the-URL link (lz-string in the hash) — nothing
     is uploaded. */
  .share-row {
    display: flex;
    justify-content: center;
    margin: 0 auto 24px;
    max-width: 820px;
  }
  .share-link-btn {
    font: inherit;
    font-size: 16px;
    font-weight: 600;
    padding: 10px 18px;
    min-height: 44px;            /* kitchen-tablet tap target (≥44px) */
    border: 2px solid #0E6E66;   /* petrol */
    border-radius: 5px;          /* control radius */
    background: #FFFFFF;
    color: #0E6E66;
    cursor: pointer;
  }
  .share-link-btn:active { background: #F3F2EC; }

  /* The toggle flips a class on <body>: default (no class) = Overview (D-09);
     body.mode-wizard shows the wizard region and hides the overview. */
  .wizard { display: none; }
  body.mode-wizard .overview-region { display: none; }
  body.mode-wizard .wizard { display: block; }

  /* ---- Wizard (D-10/D-11/D-16) ---- */
  .wizard { max-width: 820px; margin: 0 auto; }
  .wizard-progress {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 15px;
    color: #5C6A66;        /* muted */
    margin: 0 0 8px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
  }
  .wizard-progress .ticks { color: #2F7D4F; font-weight: 600; }   /* success herb */

  /* ---- Progress BAR (Plan 18-03 Task 1) — slim petrol fill above the card ---- */
  .wizard-progress-bar {
    height: 8px;
    background: #E3E1D8;          /* hairline track */
    border-radius: 4px;
    overflow: hidden;
    margin: 0 0 14px;
  }
  .wizard-progress-fill {
    height: 100%;
    width: 0%;                    /* set by updateProgress() */
    background: #0E6E66;          /* petrol fill */
    border-radius: 4px;
    transition: width 0.2s ease;
  }

  /* ---- Jump-to-dish control (Plan 18-03 Task 1) ---- */
  .wizard-jump { margin: 0 0 16px; }
  .wizard-jump-label {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #5C6A66;              /* muted */
    font-weight: 600;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .wizard-jump-select {
    font: inherit;
    font-size: 17px;
    text-transform: none;
    letter-spacing: normal;
    font-weight: 400;
    color: #1B2A28;
    padding: 10px 12px;
    min-height: 44px;            /* kitchen-tablet tap target (≥44px) */
    background: #FFFFFF;
    border: 2px solid #0E6E66;   /* petrol */
    border-radius: 5px;          /* control radius */
    cursor: pointer;
  }
  .wizard-card {
    background: #FFFFFF;
    border: 1px solid #E3E1D8;   /* hairline */
    border-radius: 7px;          /* card radius */
    padding: 22px 24px 26px;
    min-height: 220px;
  }
  /* EYEBROW (mono, uppercase, letter-spaced) — which dish this step belongs to. */
  .wizard-card .dish-name {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 15px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #0E6E66;        /* petrol */
    margin: 0 0 6px;
  }
  .wizard-card .group-heading {
    font-weight: 600;
    font-size: 18px;
    color: #1B2A28;
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 2px solid #E3E1D8;   /* hairline */
  }
  /* EYEBROW — prep-ahead step kind (warn family). */
  .wizard-card .step-kind {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #9A6212;        /* amber warn text */
    font-weight: 600;
    margin: 0 0 8px;
  }
  .wizard-card .step-text { font-size: 24px; line-height: 1.45; margin: 0; color: #1B2A28; }
  .wizard-card .step-tip {
    display: block;
    margin-top: 12px;
    font-size: 16px;
    color: #5C6A66;        /* muted */
    font-style: italic;
  }
  .wizard-card.overview-only .step-text { font-size: 20px; color: #5C6A66; }
  .wizard-card .see-overview-hint {
    margin-top: 14px;
    font-size: 16px;
    color: #5C6A66;
  }
  .wizard-done {
    margin: 16px 0 0;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;        /* kitchen-tablet tap target (≥44px) */
    font-size: 17px;
    cursor: pointer;
    user-select: none;
  }
  .wizard-done input { width: 26px; height: 26px; accent-color: #0E6E66; }   /* petrol tick */

  /* Per-step collapsible full ingredient list (D-11) */
  .wizard-ingredients { margin: 18px 0 0; border-top: 1px solid #E3E1D8; }   /* hairline */
  .wizard-ingredients > summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 16px;
    padding: 12px 0 4px;
    list-style: revert;
    color: #1B2A28;
  }
  .wizard-ingredients ul.ingredients { margin-top: 8px; }

  .wizard-nav {
    margin: 22px 0 0;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .wizard-nav button {
    font: inherit;
    font-size: 18px;
    font-weight: 600;
    padding: 12px 24px;
    min-height: 44px;            /* kitchen-tablet tap target (≥44px) */
    border: 2px solid #0E6E66;   /* petrol */
    border-radius: 5px;          /* control radius */
    background: #FFFFFF;
    color: #0E6E66;
    cursor: pointer;
  }
  .wizard-nav button.primary { background: #0E6E66; border-color: #0A554E; color: #FFFFFF; }   /* petrol + darker border */
  .wizard-nav button:disabled { opacity: 0.4; cursor: default; }
  .wake-status {
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 13px;
    color: #8A958F;        /* faint */
    margin: 12px 0 0;
    text-align: center;
  }

  @media print {
    /* Ink-friendly: white ground, ink text, no enamel-paper fill bleeding the page. */
    body { background: #FFFFFF; color: #1B2A28; font-size: 12pt; padding: 0; }
    /* Hide ALL screen-only chrome — the mode toggle, the wizard, and any control
       carrying .screen-only (18-04's share controls MUST be tagged .screen-only
       so they inherit this hide — see SUMMARY). */
    .screen-only, .mode-toggle, .wizard { display: none !important; }
    /* Force Overview visible regardless of toggle state (D-13): Overview is the
       canonical PRINTED form. */
    body.mode-wizard .overview-region { display: block !important; }
    .overview, .overview-region { display: block !important; }
    /* Petrol header rule stays as a thin ink-light line, not a heavy fill. */
    header.sheet-header { border-bottom: 1.5pt solid #0E6E66; }
    .dish {
      break-inside: avoid;
      page-break-inside: avoid;
      background: #FFFFFF;
      border: none;
      box-shadow: none;
      padding: 0;
      margin-bottom: 20pt;
    }
    /* Never orphan a dish heading at the foot of a page. */
    .dish h2 { break-after: avoid; page-break-after: avoid; }
    /* Drop the amber FILL for print — keep a left rule so the callout still reads,
       but no solid ground to bleed ink. */
    .prep-ahead { background: transparent; border-left: 2pt solid #E0A93B; }
    .prep-ahead .label { color: #1B2A28; }
    /* Eyebrow labels print in ink (petrol can read faint on cheap printers). */
    h3.block-label { color: #1B2A28; }
    /* quick-260707-nrg: component subheading drops to ink for print, staying a
       touch lighter than the block-label so the hierarchy survives on paper. */
    .ing-section { color: #4A5652; }
    ul.ingredients li { border-bottom: 0.5pt solid #E3E1D8; }
    /* Two-column body retained on paper, but the ingredients card de-fills
       (no surface fill / border / sticky) so it prints as a plain column. */
    .dish-cols { display: grid; grid-template-columns: 1.7fr 1fr; gap: 18pt; align-items: start; }
    .col-ingredients { position: static; background: transparent; border: none; border-radius: 0; padding: 0; }
    @page { margin: 15mm; }
    /* Don't echo URLs after links in print (we have none, but guard it). */
    a[href]::after { content: ""; }
  }
`;

// ----------------------------------------------------------------------------
// COOK_RUNTIME — the standalone sheet's hand-written vanilla-JS runtime, as a
// STRING (verbatim lift of the former trailing IIFE body, NOT including the
// surrounding <script> tags). It reads its model from the JSON data island
// (document.getElementById('cook-data').textContent), builds the Overview and
// the wizard, persists per-day progress to localStorage, and manages the Wake
// Lock. This code is NEVER executed in Node — only inside the generated
// document — which is what keeps this module pure/browser-free.
// ----------------------------------------------------------------------------
export const COOK_RUNTIME = `
  // STANDALONE artifact runtime — hand-written vanilla JS (D-01, no Alpine/CDN).
  // All recipe text is injected via textContent so it can never break the document.
  (function () {
    var DATA = JSON.parse(document.getElementById('cook-data').textContent);

    // Progress + mise-en-place state and its per-day localStorage persistence are
    // set up FIRST: the Overview render (below) reads state.gathered through
    // buildIngredientList, so state AND any restored ticks must exist before it.
    // (persist / restore / isGathered / setGathered are hoisted function
    // declarations defined further down; they close over these two vars.)
    // D-14: deterministic per-day key from the island's dayKey VERBATIM (= group.key:
    // 'YYYY-MM-DD' scheduled, '' Unscheduled → 'cook-progress:v1:'). NOT the blob UUID,
    // NOT normalized (RESEARCH Pitfall 4). Schema-versioned (v1) against stale shapes.
    var state = { pos: 0, completed: {}, gathered: {} };  // pos/completed = wizard; gathered = Overview mise-en-place
    var STORAGE_KEY = 'cook-progress:v1:' + (DATA.dayKey == null ? '' : String(DATA.dayKey));
    restore();  // load saved progress + ticks BEFORE the Overview/wizard render

    // Shared ingredient-list builder — used by BOTH the Overview and the wizard's
    // per-step collapsible panel (D-11: the SAME scaled amount strings, full list).
    // opts.gather (Overview-only) adds a tappable mise-en-place tick checkbox per
    // <li>, bound to state.gathered[dishIdx][ingredientIdx]; the wizard list NEVER
    // passes gather, so it stays a read-only reference list (Plan 18-03 Task 2).
    function buildIngredientList(dish, opts) {
      opts = opts || {};
      var gather = !!opts.gather;
      var dishIdx = (typeof opts.dishIdx === 'number') ? opts.dishIdx : -1;
      var ul = document.createElement('ul');
      ul.className = 'ingredients' + (gather ? ' ingredients-gather' : '');
      // quick-260707-nrg: render by section GROUPS. Falls back to a single
      // null-heading group over every flat index for OLD frozen models / share
      // links that predate ingredientGroups. Each item is rendered from its
      // ORIGINAL flat index into dish.ingredients so mise-en-place ticks realign.
      var groups = (dish.ingredientGroups && dish.ingredientGroups.length)
        ? dish.ingredientGroups
        : [{ heading: null, itemIndexes: (dish.ingredients || []).map(function (_, i) { return i; }) }];
      groups.forEach(function (group, groupIdx) {
        if (group.heading != null && String(group.heading) !== '') {
          var h = document.createElement('div');
          h.className = 'ing-section' + (groupIdx === 0 ? ' ing-section-first' : '');
          h.textContent = group.heading;
          ul.appendChild(h);
        }
        (group.itemIndexes || []).forEach(function (flatIdx) {
          var ing = (dish.ingredients || [])[flatIdx];
          if (!ing) { return; }
          var li = document.createElement('li');
          // Mise-en-place tick (Overview only). DISPLAY-ONLY: it never alters the
          // frozen amount/volParen/role text (D-05) — only toggles a .gathered class.
          // Tick binds to the ORIGINAL flat index (flatIdx), NOT a per-group counter.
          if (gather) {
            var lab = document.createElement('label');
            lab.className = 'gather-tick';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'gather-cb';
            cb.checked = isGathered(dishIdx, flatIdx);
            cb.addEventListener('change', function () {
              setGathered(dishIdx, flatIdx, cb.checked);
              li.classList.toggle('gathered', cb.checked);
            });
            lab.appendChild(cb);
            li.appendChild(lab);
            if (cb.checked) { li.classList.add('gathered'); }
          }
          if (ing.amount) {
            var a = document.createElement('span');
            a.className = 'amt';
            a.textContent = ing.amount;
            li.appendChild(a);
          }
          var n = document.createElement('span');
          n.className = 'ing-name';
          n.textContent = ing.name;
          li.appendChild(n);
          if (ing.volParen) {
            var v = document.createElement('span');
            v.className = 'vol';
            v.textContent = ing.volParen;
            li.appendChild(v);
          }
          if (ing.role && ing.role !== 'required') {
            var r = document.createElement('span');
            r.className = 'role';
            r.textContent = ing.role === 'to_taste' ? 'to taste' : ing.role;
            li.appendChild(r);
          }
          ul.appendChild(li);
        });
      });
      return ul;
    }

    document.querySelector('[data-x="dayLabel"]').textContent = DATA.dayLabel || 'Cooking sheet';

    var idx = document.getElementById('dish-index');
    DATA.dishes.forEach(function (d) {
      var li = document.createElement('li');
      var nm = document.createElement('span');
      nm.textContent = d.name;
      li.appendChild(nm);
      if (d.servings != null && d.servings !== '') {
        var srv = document.createElement('span');
        srv.className = 'srv';
        srv.textContent = ' — ' + d.servings + ' servings';
        li.appendChild(srv);
      }
      idx.appendChild(li);
    });

    var gen = document.getElementById('generated-at');
    var when = DATA.generatedAt ? new Date(DATA.generatedAt) : null;
    gen.textContent = 'Generated ' + (when && !isNaN(when) ? when.toLocaleString() : (DATA.generatedAt || ''));

    var host = document.getElementById('dishes');
    DATA.dishes.forEach(function (d, dishIdx) {
      var sec = document.createElement('section');
      sec.className = 'dish';

      var h2 = document.createElement('h2');
      h2.textContent = d.name;
      sec.appendChild(h2);

      if (d.servings != null && d.servings !== '') {
        var srv = document.createElement('p');
        srv.className = 'servings';
        srv.textContent = d.servings + ' servings';
        sec.appendChild(srv);
      }

      if (d.prepNote) {
        var pa = document.createElement('div');
        pa.className = 'prep-ahead';
        var lab = document.createElement('span');
        lab.className = 'label';
        lab.textContent = 'Prep ahead';
        pa.appendChild(lab);
        var pn = document.createElement('span');
        pn.textContent = d.prepNote;
        pa.appendChild(pn);
        sec.appendChild(pa);
      }

      // Two-column body (Overview): METHOD column (left) + INGREDIENTS column
      // (right, a sticky card). The head above (name/servings/prep-ahead) stays
      // full-width. A dish with no ingredients renders the method column only,
      // full-width (no empty grid track).
      var colMethod = document.createElement('div');
      colMethod.className = 'col-method';

      var mh = document.createElement('h3');
      mh.className = 'block-label';
      mh.textContent = 'Method';
      colMethod.appendChild(mh);

      if (d.hasSteps) {
        d.instructionGroups.forEach(function (g) {
          var grp = document.createElement('div');
          grp.className = 'step-group';
          if (g.heading) {
            var hd = document.createElement('div');
            hd.className = 'heading';
            hd.textContent = g.heading;
            grp.appendChild(hd);
          }
          var ol = document.createElement('ol');
          ol.className = 'steps';
          (g.steps || []).forEach(function (st) {
            var li = document.createElement('li');
            li.textContent = st.text;
            (st.tips || []).forEach(function (t) {
              var tip = document.createElement('span');
              tip.className = 'tip';
              tip.textContent = 'Tip: ' + t;
              li.appendChild(tip);
            });
            ol.appendChild(li);
          });
          grp.appendChild(ol);
          colMethod.appendChild(grp);
        });
      } else {
        var ns = document.createElement('p');
        ns.className = 'no-steps';
        ns.textContent = 'No numbered method recorded for this dish — see the recipe.';
        colMethod.appendChild(ns);
      }

      if (d.serveWith) {
        var sw = document.createElement('p');
        sw.className = 'serve-with';
        var swl = document.createElement('span');
        swl.className = 'label';
        swl.textContent = 'Serve with: ';
        sw.appendChild(swl);
        var swt = document.createElement('span');
        swt.textContent = d.serveWith;
        sw.appendChild(swt);
        colMethod.appendChild(sw);
      }

      if (d.ingredients && d.ingredients.length) {
        var cols = document.createElement('div');
        cols.className = 'dish-cols';
        cols.appendChild(colMethod);

        var colIng = document.createElement('aside');
        colIng.className = 'col-ingredients';
        var ih = document.createElement('h3');
        ih.className = 'block-label';
        ih.textContent = 'Ingredients';
        colIng.appendChild(ih);
        // Overview list ONLY gets the mise-en-place tick-off checkboxes (Task 2).
        colIng.appendChild(buildIngredientList(d, { gather: true, dishIdx: dishIdx }));
        cols.appendChild(colIng);

        sec.appendChild(cols);
      } else {
        // No ingredients — method spans full width, no grid.
        sec.appendChild(colMethod);
      }

      host.appendChild(sec);
    });

    // ====================================================================
    // WIZARD (D-08/D-09/D-10/D-11/D-16) — hand-written vanilla, no Alpine.
    // One numbered instruction line = one wizard step (D-10); section headings
    // are non-counting group dividers shown above their first step; prepNote is
    // an optional per-dish step-zero ("Prep ahead"); EVERY step carries a
    // collapsible full scaled ingredient list (D-11); a hasSteps===false dish is
    // a single "see Overview" card and is never best-effort-split (D-16).
    // ====================================================================

    // Flatten the model into an ordered sequence of wizard cards. Each item:
    //   { dishIdx, dishName, kind, heading?, text?, tips?, isFirstOfGroup, stepLabel }
    // kind ∈ 'prep' | 'step' | 'overview-only'. dishIdx is the dish's index in
    // model order — the stable per-dish id used for completed-step keying (D-14).
    var SEQUENCE = (function buildSequence() {
      var seq = [];
      DATA.dishes.forEach(function (d, dishIdx) {
        if (!d.hasSteps) {
          // D-16: Overview-only dish — single pointer card, no synthesized steps.
          seq.push({ dishIdx: dishIdx, dishName: d.name, kind: 'overview-only' });
          return;
        }
        // Optional step-zero from prepNote (Claude's-discretion wizard placement).
        if (d.prepNote) {
          seq.push({ dishIdx: dishIdx, dishName: d.name, kind: 'prep', text: d.prepNote });
        }
        (d.instructionGroups || []).forEach(function (g) {
          (g.steps || []).forEach(function (st, sIdx) {
            seq.push({
              dishIdx: dishIdx,
              dishName: d.name,
              kind: 'step',
              heading: g.heading || null,
              isFirstOfGroup: sIdx === 0 && !!g.heading,
              text: st.text,
              tips: st.tips || []
            });
          });
        });
      });
      return seq;
    })();

    var cardEl = document.getElementById('wizard-card');
    var posEl = document.getElementById('wizard-position');
    var ticksEl = document.getElementById('wizard-ticks');
    var prevBtn = document.getElementById('wizard-prev');
    var nextBtn = document.getElementById('wizard-next');
    var overviewBtn = document.getElementById('mode-overview');
    var wizardBtn = document.getElementById('mode-wizard-btn');
    var wizardEl = document.getElementById('wizard');

    // ---- Inject the progress BAR + jump-to-dish control (Task 1) ----
    // Injected by the runtime (not the body skeleton) so the skeleton stays stable
    // across the local blob and the hosted viewer (18-04). The bar sits ABOVE the
    // wizard card; the jump control sits just under it.
    var progressBar = document.createElement('div');
    progressBar.className = 'wizard-progress-bar';
    progressBar.setAttribute('role', 'progressbar');
    progressBar.setAttribute('aria-label', 'Steps completed');
    var progressFill = document.createElement('div');
    progressFill.className = 'wizard-progress-fill';
    progressBar.appendChild(progressFill);

    // Jump-to-dish: a <select> of DATA.dishes by name. Selecting a dish moves the
    // cursor to that dish's FIRST SEQUENCE index (resolved via item.dishIdx — NOT a
    // hardcoded map), then persists + re-renders. Works for overview-only dishes too
    // (their single card is its own first SEQUENCE index).
    var jumpWrap = document.createElement('div');
    jumpWrap.className = 'wizard-jump';
    var jumpLabel = document.createElement('label');
    jumpLabel.className = 'wizard-jump-label';
    jumpLabel.setAttribute('for', 'wizard-jump-select');
    jumpLabel.textContent = 'Jump to dish';
    var jumpSelect = document.createElement('select');
    jumpSelect.id = 'wizard-jump-select';
    jumpSelect.className = 'wizard-jump-select';
    DATA.dishes.forEach(function (d, dishIdx) {
      var opt = document.createElement('option');
      opt.value = String(dishIdx);
      opt.textContent = d.name;
      jumpSelect.appendChild(opt);
    });
    function firstSeqIndexForDish(dishIdx) {
      for (var i = 0; i < SEQUENCE.length; i += 1) {
        if (SEQUENCE[i].dishIdx === dishIdx) { return i; }
      }
      return -1;
    }
    jumpSelect.addEventListener('change', function () {
      var dishIdx = parseInt(jumpSelect.value, 10);
      var target = firstSeqIndexForDish(dishIdx);
      if (target >= 0) { state.pos = target; persist(); renderCard(); }
    });
    jumpLabel.appendChild(jumpSelect);
    jumpWrap.appendChild(jumpLabel);

    // Mount: bar first, then jump, then BEFORE the existing card.
    if (wizardEl && cardEl) {
      wizardEl.insertBefore(progressBar, cardEl);
      wizardEl.insertBefore(jumpWrap, cardEl);
    }

    // (state + STORAGE_KEY are declared at the TOP of the runtime — they must exist
    // before the Overview render reads state.gathered.)

    // ---- Overview mise-en-place ticks (Task 2) — display-only, persisted in the
    // SAME cook-progress blob under a gathered key. Keyed by dishIdx (index in
    // DATA.dishes) + ingredientIdx (index in that dish's frozen ingredients array).
    function isGathered(dishIdx, ingredientIdx) {
      var byDish = state.gathered[dishIdx];
      return !!(byDish && byDish[ingredientIdx]);
    }
    function setGathered(dishIdx, ingredientIdx, on) {
      var byDish = state.gathered[dishIdx] || (state.gathered[dishIdx] = {});
      if (on) { byDish[ingredientIdx] = true; } else { delete byDish[ingredientIdx]; }
      persist();
    }

    // (STORAGE_KEY is declared at the TOP of the runtime — see the D-14 note there.)

    // localStorage throws on an opaque origin (file://-served artifact) — wrap every
    // access in try/catch and fail soft to in-memory-only (T-06-09, D-14 file:// note).
    function persist() {
      try {
        var payload = {
          dishIndex: SEQUENCE.length ? SEQUENCE[state.pos].dishIdx : 0,
          stepIndex: state.pos,
          completed: state.completed,
          gathered: state.gathered    // ADDITIVE (Task 2): old payloads without it restore fine
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (e) { /* opaque origin / quota / private mode — no-op, in-memory only */ }
    }
    function restore() {
      var raw = null;
      try { raw = window.localStorage.getItem(STORAGE_KEY); }
      catch (e) { return; } // opaque origin → keep defaults, in-memory only
      if (!raw) return;
      try {
        var saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          if (typeof saved.stepIndex === 'number' && saved.stepIndex >= 0) {
            // restore() runs BEFORE SEQUENCE is built — store the raw index;
            // renderCard() clamps it to [0, SEQUENCE.length-1] at render time.
            state.pos = saved.stepIndex;
          }
          if (saved.completed && typeof saved.completed === 'object') {
            state.completed = saved.completed;
          }
          // ADDITIVE: an older payload (pre-Task-2) has no gathered key → default {}.
          if (saved.gathered && typeof saved.gathered === 'object') {
            state.gathered = saved.gathered;
          }
        }
      } catch (e) { /* corrupt/stale shape — ignore, start fresh */ }
    }

    // ---- D-15: Screen Wake Lock (keep a kitchen tablet awake) ----
    // Feature-detected + try/catch swallowed → graceful no-op where unsupported or
    // denied (battery saver, hidden doc). Re-acquired on visibilitychange because the
    // OS auto-releases on hide and does NOT re-acquire (RESEARCH Pitfall 3, T-06-10).
    var wakeLock = null;
    var inWizardMode = false;
    var wakeStatusEl = document.getElementById('wake-status');
    function setWakeStatus(msg) { if (wakeStatusEl) wakeStatusEl.textContent = msg || ''; }

    function acquireWake() {
      if (!('wakeLock' in navigator)) { setWakeStatus('Screen stay-awake not supported on this device.'); return; }
      if (document.visibilityState !== 'visible') return;
      if (wakeLock) return; // already held
      try {
        navigator.wakeLock.request('screen').then(function (lock) {
          // WR-02: request() is async. If the user left wizard mode (or a
          // release ran) while it was in flight, the lock resolves AFTER exit —
          // release it immediately rather than letting it persist in Overview.
          if (!inWizardMode) {
            try { lock.release(); } catch (e) { /* no-op */ }
            return;
          }
          wakeLock = lock;
          setWakeStatus('Screen will stay awake while cooking.');
          if (lock && typeof lock.addEventListener === 'function') {
            lock.addEventListener('release', function () { wakeLock = null; });
          }
        }).catch(function () { /* denied — no-op, wizard still works (D-15) */ });
      } catch (e) { /* never throw (D-15) */ }
    }
    function releaseWake() {
      try { if (wakeLock && typeof wakeLock.release === 'function') wakeLock.release(); }
      catch (e) { /* no-op */ }
      wakeLock = null;
    }
    function onEnterWizard() { inWizardMode = true; acquireWake(); }
    function onExitWizard() { inWizardMode = false; releaseWake(); setWakeStatus(''); }

    document.addEventListener('visibilitychange', function () {
      // Re-acquire only when visible AND still in the wizard (OS released it on hide).
      if (document.visibilityState === 'visible' && inWizardMode) acquireWake();
    });
    window.addEventListener('pagehide', function () { releaseWake(); });

    function countCompleted() {
      var n = 0;
      Object.keys(state.completed).forEach(function (dk) {
        n += Object.keys(state.completed[dk] || {}).length;
      });
      return n;
    }

    function isCompleted(item, seqIdx) {
      var byDish = state.completed[item.dishIdx];
      return !!(byDish && byDish[seqIdx]);
    }

    function setCompleted(item, seqIdx, on) {
      if (item.kind === 'overview-only') return;
      var byDish = state.completed[item.dishIdx] || (state.completed[item.dishIdx] = {});
      if (on) { byDish[seqIdx] = true; } else { delete byDish[seqIdx]; }
      persist();
    }

    function renderCard() {
      if (!SEQUENCE.length) {
        cardEl.textContent = '';
        var empty = document.createElement('p');
        empty.className = 'step-text';
        empty.textContent = 'No wizard steps — see Overview for this day.';
        cardEl.appendChild(empty);
        posEl.textContent = '';
        ticksEl.textContent = '';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
      }
      if (state.pos < 0) { state.pos = 0; }
      if (state.pos > SEQUENCE.length - 1) { state.pos = SEQUENCE.length - 1; }
      var item = SEQUENCE[state.pos];
      cardEl.textContent = '';
      cardEl.className = 'wizard-card' + (item.kind === 'overview-only' ? ' overview-only' : '');

      // Dish name (which dish this step belongs to).
      var dn = document.createElement('p');
      dn.className = 'dish-name';
      dn.textContent = item.dishName;
      cardEl.appendChild(dn);

      // Section heading divider (D-10) — only above the first step of a group.
      if (item.isFirstOfGroup && item.heading) {
        var gh = document.createElement('p');
        gh.className = 'group-heading';
        gh.textContent = item.heading;
        cardEl.appendChild(gh);
      }

      if (item.kind === 'prep') {
        var pk = document.createElement('p');
        pk.className = 'step-kind';
        pk.textContent = 'Prep ahead';
        cardEl.appendChild(pk);
      }

      if (item.kind === 'overview-only') {
        var ot = document.createElement('p');
        ot.className = 'step-text';
        ot.textContent = 'This dish has no numbered steps.';
        cardEl.appendChild(ot);
        var hint = document.createElement('p');
        hint.className = 'see-overview-hint';
        hint.textContent = 'See Overview for this dish — switch to Overview mode for its full method.';
        cardEl.appendChild(hint);
      } else {
        var stx = document.createElement('p');
        stx.className = 'step-text';
        stx.textContent = item.text;
        (item.tips || []).forEach(function (t) {
          var tip = document.createElement('span');
          tip.className = 'step-tip';
          tip.textContent = 'Tip: ' + t;
          stx.appendChild(tip);
        });
        cardEl.appendChild(stx);

        // Per-step "done" tick (skipped for overview-only).
        var doneLabel = document.createElement('label');
        doneLabel.className = 'wizard-done';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isCompleted(item, state.pos);
        cb.addEventListener('change', function () {
          setCompleted(item, state.pos, cb.checked);
          updateProgress();
        });
        doneLabel.appendChild(cb);
        var dt = document.createElement('span');
        dt.textContent = 'Mark this step done';
        doneLabel.appendChild(dt);
        cardEl.appendChild(doneLabel);
      }

      // Collapsible full scaled ingredient list on EVERY step (D-11).
      var dish = DATA.dishes[item.dishIdx];
      if (dish && dish.ingredients && dish.ingredients.length) {
        var det = document.createElement('details');
        det.className = 'wizard-ingredients';
        var sum = document.createElement('summary');
        sum.textContent = 'Ingredients (' + dish.name + ')';
        det.appendChild(sum);
        det.appendChild(buildIngredientList(dish));
        cardEl.appendChild(det);
      }

      prevBtn.disabled = state.pos <= 0;
      nextBtn.disabled = state.pos >= SEQUENCE.length - 1;
      updateProgress();
    }

    function updateProgress() {
      posEl.textContent = 'Step ' + (state.pos + 1) + ' of ' + SEQUENCE.length;
      var done = countCompleted();
      ticksEl.textContent = done ? ('✓ ' + done + ' done') : '';
      // Progress BAR fill = completed steps / total SEQUENCE length (guard ÷0).
      var pct = SEQUENCE.length ? Math.round((done / SEQUENCE.length) * 100) : 0;
      if (pct < 0) { pct = 0; } else if (pct > 100) { pct = 100; }
      progressFill.style.width = pct + '%';
      progressBar.setAttribute('aria-valuenow', String(pct));
      progressBar.setAttribute('aria-valuemin', '0');
      progressBar.setAttribute('aria-valuemax', '100');
      // Reflect the active dish in the jump control.
      if (SEQUENCE.length) {
        var activeDish = SEQUENCE[state.pos].dishIdx;
        if (jumpSelect.value !== String(activeDish)) { jumpSelect.value = String(activeDish); }
      }
    }

    prevBtn.addEventListener('click', function () {
      if (state.pos > 0) { state.pos -= 1; persist(); renderCard(); }
    });
    nextBtn.addEventListener('click', function () {
      if (state.pos < SEQUENCE.length - 1) { state.pos += 1; persist(); renderCard(); }
    });

    function setMode(wizard) {
      document.body.classList.toggle('mode-wizard', !!wizard);
      overviewBtn.setAttribute('aria-pressed', wizard ? 'false' : 'true');
      wizardBtn.setAttribute('aria-pressed', wizard ? 'true' : 'false');
      if (wizard) { renderCard(); onEnterWizard(); } else { onExitWizard(); }
    }
    overviewBtn.addEventListener('click', function () { setMode(false); });
    wizardBtn.addEventListener('click', function () { setMode(true); });

    // ====================================================================
    // SHARE LINK (Plan 18-04) — data-in-the-URL. Compress the sheet's OWN
    // frozen model (re-parse #cook-data — D-05: NEVER re-scale/re-derive) into
    // a cook.html#<lz-string> link. LZString is provided GLOBALLY by the
    // LZSTRING_MIN <script> renderCookDocument injects BEFORE this runtime, so a
    // kitchen tablet can build a link fully OFFLINE (no CDN fetch).
    // Nothing is uploaded; no GitHub write — the data lives only in the link.
    // ====================================================================
    var SHARE_URL_WARN = 8000;  // named/tunable: above this, warn (chat apps may truncate; a normal day ≈ 4.3k stays silent — SMS is the only sub-8k-limited channel)
    var shareBtn = document.getElementById('share-link-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', function () {
        var url;
        try {
          // D-05: use exactly what's embedded — re-parse the island, do NOT re-derive.
          var frozen = JSON.parse(document.getElementById('cook-data').textContent);
          var compressed = LZString.compressToEncodedURIComponent(JSON.stringify(frozen));
          // Base: the parent embedded an absolute https base (the blob can't resolve
          // 'cook.html' relatively — new URL('cook.html', 'blob:…') THROWS); the hosted
          // viewer leaves it '' and resolves relative to its own https location.
          var base = window.__COOK_SHARE_BASE__ || new URL('cook.html', location.href).href;
          url = base + '#' + compressed;
        } catch (e) {
          window.alert('Could not build a share link for this sheet.');
          return;
        }
        // Long-URL guard: warn + copy-anyway; NEVER block, NEVER truncate the data.
        if (url.length > SHARE_URL_WARN) {
          var go = window.confirm(
            'This share link is long (' + url.length + ' characters) and may be ' +
            'truncated by some chat apps. Copy it anyway?'
          );
          if (!go) { return; }
        }
        copyShareUrl(url);
      });
    }

    function flashCopied() {
      if (!shareBtn) { return; }
      var original = shareBtn.textContent;
      shareBtn.textContent = 'Copied ✓';
      window.setTimeout(function () { shareBtn.textContent = original; }, 2000);
    }

    function copyShareUrl(url) {
      // Async clipboard first; fall back to a hidden textarea + execCommand for
      // non-secure / opaque (blob:/file:) contexts where navigator.clipboard is absent.
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(url).then(flashCopied, function () { legacyCopy(url); });
      } else {
        legacyCopy(url);
      }
    }
    function legacyCopy(url) {
      try {
        var ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) { flashCopied(); }
        else { window.prompt('Copy this share link:', url); }
      } catch (e) {
        window.prompt('Copy this share link:', url);
      }
    }

    // Progress + ticks were already restored at the top (before the Overview render).
    // Prime the wizard card (clamps state.pos against SEQUENCE).
    renderCard();
    // Default mode = Overview (D-09): no body.mode-wizard class is set on load.
  })();
`;

// ----------------------------------------------------------------------------
// renderCookDocument({ dataIsland, titleDay, shareBase }) — assemble the full
// <!doctype html>…</html> standalone document string. The ONLY thing that varies
// between the local blob (app.js) and the hosted viewer (18-04) is the data
// SOURCE: the caller supplies the COMPLETE
//   <script type="application/json" id="cook-data">…</script>
// element string as `dataIsland` (so the < → < escaping stays in the
// caller). `titleDay` is HTML-escaped here for the <title> exactly as the former
// app.js code did (& → &amp;, < → &lt;, > → &gt;).
//
// `shareBase` (Plan 18-04, default '') is the absolute base URL the Share control
// uses to build links. app.js passes the parent's resolved
// `new URL('cook.html', window.location.href).href` because a `blob:` document
// CANNOT resolve 'cook.html' relatively (`new URL('cook.html', 'blob:…')` THROWS).
// The hosted viewer passes '' and resolves relative to its own https location.
//
// INJECT ORDER (load-bearing): LZSTRING_MIN <script> FIRST (defines global
// LZString), THEN the window.__COOK_SHARE_BASE__ assignment, THEN the dataIsland,
// THEN COOK_RUNTIME. So both the viewer's hash-decode preamble (in dataIsland) and
// the in-sheet Share runtime can call LZString without any esm.sh fetch.
// ----------------------------------------------------------------------------
export function renderCookDocument({ dataIsland, titleDay, shareBase } = {}) {
  const safeTitle = String(titleDay == null ? 'Cook' : titleDay)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cook — ${safeTitle}</title>
<style>${COOK_CSS}</style>
</head>
<body>
<script>${LZSTRING_MIN}</script>
<script>window.__COOK_SHARE_BASE__ = ${JSON.stringify(shareBase || '')};</script>
${dataIsland}
<div class="sheet">
  <header class="sheet-header">
    <h1 data-x="dayLabel"></h1>
    <ul class="dish-index" id="dish-index"></ul>
    <p class="generated-at" id="generated-at"></p>
  </header>
  <!-- Mode toggle (D-08): Overview default (D-09); flips body.mode-wizard. -->
  <div class="mode-toggle screen-only" id="mode-toggle">
    <button type="button" id="mode-overview" aria-pressed="true">Overview</button>
    <button type="button" id="mode-wizard-btn" aria-pressed="false">Step-by-step</button>
  </div>
  <!-- Share-link control (Plan 18-04): screen-only so the print rule hides it.
       Compresses the frozen #cook-data model into a cook.html#hash link — no upload. -->
  <div class="share-row screen-only">
    <button type="button" id="share-link-btn" class="share-link-btn">Copy share link</button>
  </div>
  <!-- Overview region (everything visible). -->
  <div class="overview-region overview">
    <main id="dishes"></main>
  </div>
  <!-- Wizard region (one step at a time) — populated by the runtime (D-10/D-11/D-16). -->
  <div class="wizard" id="wizard">
    <p class="wizard-progress"><span id="wizard-position"></span><span class="ticks" id="wizard-ticks"></span></p>
    <div class="wizard-card" id="wizard-card"></div>
    <div class="wizard-nav">
      <button type="button" id="wizard-prev">‹ Back</button>
      <button type="button" id="wizard-next" class="primary">Next ›</button>
    </div>
    <p class="wake-status" id="wake-status"></p>
  </div>
</div>
<script>${COOK_RUNTIME}</script>
</body>
</html>`;
}

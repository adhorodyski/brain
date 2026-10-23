#!/usr/bin/env python3
"""Render MEMORY-DESIGN.md into a self-contained visual HTML preview."""
import html as H
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "MEMORY-DESIGN.md")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "MEMORY-DESIGN.html")

md_text = SRC.read_text()


def slug(t):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9 -]", "", t.lower())).strip().replace(" ", "-")


def inline(t):
    codes = []

    def stash(m):
        codes.append(m.group(1))
        return "\x00%d\x00" % (len(codes) - 1)

    t = re.sub(r"`([^`]+)`", stash, t)
    t = H.escape(t, quote=False)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', t)
    t = re.sub(r"\x00(\d+)\x00", lambda m: "<code>%s</code>" % H.escape(codes[int(m.group(1))], quote=False), t)
    return t


def render(md):
    out, i, n = [], 0, 0
    lines = md.splitlines()
    section_open = False
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("```"):
            lang = ln[3:].strip()
            i += 1
            body = []
            while i < len(lines) and not lines[i].startswith("```"):
                body.append(lines[i])
                i += 1
            i += 1
            out.append('<pre class="code" data-lang="%s">%s</pre>' % (lang or "text", H.escape("\n".join(body), quote=False)))
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", ln)
        if m:
            lvl, txt = len(m.group(1)), m.group(2)
            if lvl == 1:
                out.append('<h1 class="doc">%s</h1>' % inline(txt))
            elif lvl == 2:
                if section_open:
                    out.append("</section>")
                out.append('<section class="card" id="%s"><h2>%s</h2>' % (slug(txt), inline(txt)))
                section_open = True
            else:
                out.append("<h3>%s</h3>" % inline(txt))
            i += 1
            continue
        if ln.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|?\s*$", lines[i + 1]):
            head = [c.strip() for c in ln.strip().strip("|").split("|")]
            i += 2
            rows, cur = [], None
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                raw = lines[i].strip()
                cells = [c.strip() for c in raw.strip("|").split("|")]
                rows.append(cells)
                cur = cells
                i += 1
                while i < len(lines) and lines[i].strip() and not lines[i].lstrip().startswith("|") \
                        and not lines[i].startswith(("#", "```", "-", "> ")) and not re.match(r"^\d+\.", lines[i]):
                    cur[-1] = (cur[-1] + " " + lines[i].strip()).strip()
                    i += 1
            tbl = ['<div class="tw"><table><thead><tr>' + "".join("<th>%s</th>" % inline(c) for c in head) + "</tr></thead><tbody>"]
            for r in rows:
                tbl.append("<tr>" + "".join("<td>%s</td>" % inline(c) for c in r) + "</tr>")
            tbl.append("</tbody></table></div>")
            out.append("".join(tbl))
            continue
        if ln.startswith("> "):
            buf = []
            while i < len(lines) and (lines[i].startswith("> ") or (buf and lines[i].strip() and not lines[i].startswith(">") and lines[i - 1].startswith(">") and not lines[i].lstrip().startswith(("#", "|", "```")))):
                buf.append(re.sub(r"^>\s?", "", lines[i]))
                i += 1
            out.append('<blockquote>%s</blockquote>' % "<br>".join(inline(x) for x in buf))
            continue
        if ln.startswith("- "):
            items, i = [], i
            while i < len(lines):
                if lines[i].startswith("- "):
                    items.append(lines[i][2:])
                    i += 1
                elif items and lines[i].startswith("  ") and not lines[i].startswith("```"):
                    items[-1] += " " + lines[i].strip()
                    i += 1
                else:
                    break
            out.append('<ul class="%s">' % ("cure" if items and "Propose" in items[0] else "") + "".join("<li>%s</li>" % inline(x) for x in items) + "</ul>")
            continue
        if re.match(r"^\d+\.\s", ln):
            items = []
            while i < len(lines):
                if re.match(r"^\d+\.\s", lines[i]):
                    items.append(re.sub(r"^\d+\.\s+", "", lines[i]))
                    i += 1
                elif items and lines[i].strip() and not lines[i].startswith(("#", "|", "```", "- ", "> ")) and not re.match(r"^\d+\.", lines[i]):
                    items[-1] += " " + lines[i].strip()
                    i += 1
                else:
                    break
            out.append('<ol class="steps">' + "".join("<li>%s</li>" % inline(x) for x in items) + "</ol>")
            continue
        if ln.strip() == "":
            i += 1
            continue
        buf = [ln]
        i += 1
        while i < len(lines) and lines[i].strip() and not lines[i].startswith(("#", "|", "```", "- ", "> ")) and not re.match(r"^\d+\.", lines[i]):
            buf.append(lines[i])
            i += 1
        out.append("<p>%s</p>" % inline(" ".join(buf)))
    if section_open:
        out.append("</section>")
    return "\n".join(out)


body = render(md_text)

# ---------- visualisations injected at known anchors ----------

HERO = """
<div class="hero">
  <div class="stats">
    <div class="stat"><b>0</b><span>model calls on the<br>request path</span></div>
    <div class="stat"><b>2</b><span>runtime deps,<br>3 packages transitive</span></div>
    <div class="stat"><b>7</b><span>MCP tools,<br>one endpoint, one token</span></div>
    <div class="stat"><b>2</b><span>tables + FTS index<br>+ 3 sync triggers</span></div>
    <div class="stat"><b>~70</b><span>hand-written lines<br>that aren't SQL</span></div>
    <div class="stat"><b>1215<i> KiB</i></b><span>bundle · 209 KiB gz<br>no nodejs_compat</span></div>
  </div>
</div>"""

ARCH = """
<h3 class="viz">Request path — every call, no exceptions</h3>
<div class="flow">
  <div class="fcol">
    <div class="fbox host"><em>pi</em><em>Codex</em><em>Cursor</em><em>Claude Code</em><span>hosts do all thinking</span></div>
  </div>
  <div class="farrow">streamable HTTP<br><code>Authorization: Bearer</code></div>
  <div class="fcol">
    <div class="fbox mid"><b>Worker · mcp.ts</b><span>requireBearerAuth → 401+challenge</span><span>host-header guard</span><span>createMcpHandler (stateless)</span></div>
  </div>
  <div class="farrow">1 RPC per tool call<br>owner + source ride along</div>
  <div class="fcol">
    <div class="fbox do"><b>DO · Brain</b><span class="mono">ctx.storage.sql</span>
      <div class="mini">notes <i>⇄ 3 triggers ⇄</i> notes_ft (FTS5 · bm25)<br>instructions (supersede + tombstones)</div>
      <span>budget · dkey · owner · flat() — <b>below the tools</b></span>
    </div>
  </div>
</div>"""

SPLIT = """
<h3 class="viz">Who writes what</h3>
<div class="splitbar">
  <div class="sb lib" style="flex:88"><span>library — auth, transport, schema, validation, ranking, refusal plumbing</span></div>
  <div class="sb own" style="flex:12"><span>~70 LoC</span></div>
</div>
<div class="splitlegend"><span class="k lib"></span>MCP SDK + zod + SQLite FTS5 + triggers
  <span class="k own"></span>verifier 15 · Levenshtein 25 · block renderer 15 · toFtsQuery 8 · flat() 4</div>"""

BUDGET = """
<h3 class="viz">Budget meters (what the fill line shows the model)</h3>
<div class="meters">
  <div class="meter"><label>core notes</label><div class="track"><div class="fill" style="width:19%"></div></div><code>612/3150 (19%)</code></div>
  <div class="meter"><label>instructions</label><div class="track"><div class="fill" style="width:28%"></div></div><code>291/1050 (28%)</code></div>
  <div class="meter"><label>a full block, every response</label><div class="track slim"><div class="fill b2" style="width:3%"></div></div><code>~180 tokens vs ~6K/turn</code></div>
</div>"""

SCHEMAV = """
<h3 class="viz">Storage topology</h3>
<div class="er">
  <div class="ert"><b>notes</b><span>key PK · text · tags · tier · at · source · owner · <u>dkey UNIQUE</u></span></div>
  <div class="erlink">▲ INSERT / UPDATE / DELETE triggers keep the index honest<span>the <i>'delete'</i> rows are what stop stale text staying searchable</span></div>
  <div class="ert fts"><b>notes_ft</b><span>FTS5 external-content · bm25() · tags column searchable · rowid = notes.rowid (<u>rowids are reused</u> → id+words rule)</span></div>
  <div class="ert i2"><b>instructions</b><span>key PK · when_scope · priority · active · superseded_key · <u>dkey UNIQUE</u> — retired rows never surface in recall</span></div>
</div>"""

PROBE = """
<h3 class="viz">Behavioural probe — tuning target for <code>brain_learn</code>’s description</h3>
<div class="probe">
<table class="pt"><thead><tr><th>utterance</th><th>phrase the tool description must carry</th><th>tool</th><th>passes when</th></tr></thead><tbody>
<tr><td>“always use British English”</td><td><code>always</code></td><td>learn</td><td>a row lands, <code>when_scope</code> set, block shows <code>5 of n</code></td></tr>
<tr><td>“you were too verbose, stop that”</td><td><code>stop doing</code>, <code>not like that</code></td><td>learn</td><td>supersedes the old verbosity rule; loser <code>active=0</code></td></tr>
<tr><td>“I prefer bullets over prose”</td><td><code>I prefer</code></td><td>learn</td><td>no duplicate if it repeats later</td></tr>
<tr><td>“next time edit rather than rewrite”</td><td><code>next time</code></td><td>learn</td><td>called <b>before</b> the answer, not after</td></tr>
<tr><td>“my garage code is 4417”</td><td>—</td><td>remember</td><td><b>must</b> write; a <code>recall</code> for <code>4417</code> ranks it first</td></tr>
<tr><td>“what’s my garage code”</td><td>—</td><td>recall</td><td><b>must write nothing</b> — zero rows inserted</td></tr>
</tbody></table>
</div>"""

RAW_MD = '<details class="raw"><summary>raw markdown — %s</summary><pre id="rawmd">%s</pre></details>' % (SRC, H.escape(md_text, quote=False))

anchors = [
    ("## stack", ARCH, "end"),
    ("## library-surface-vs-hand-written", SPLIT, "start"),
    ("## schema", SCHEMAV, "start"),
    ("## the-standing-instruction-block", BUDGET, "start"),
    ("## verification", PROBE, "before-end"),
]
for sid, frag, where in anchors:
    sid = sid.replace("## ", "").strip()
    marker = '<section class="card" id="%s">' % sid
    pos = body.find(marker)
    if pos == -1:
        continue
    end = body.find("</section>", pos)
    if where == "end":
        body = body[:end] + frag + body[end:]
    elif where == "start":
        h2end = body.find("</h2>", pos) + 5
        body = body[:h2end] + frag + body[h2end:]
    else:
        body = body[:end] + frag + body[end:]

h1end = body.find("</h1>")
if h1end != -1:
    body = body[: h1end + 5] + HERO + body[h1end + 5:]

CSS_JS = """
:root{
  --bg:#0f1115; --panel:#171a21; --panel2:#1d212a; --line:#2a2f3a;
  --ink:#e8eaf0; --ink2:#9aa3b2; --ink3:#6b7484;
  --mine:#4c9be8; --yes:#2ea36b; --partial:#c9992a; --no:#c25450;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.layout{display:grid;grid-template-columns:250px minmax(0,1fr);max-width:1280px;margin:0 auto;gap:28px;padding:0 22px}
header.top{padding:34px 22px 6px;max-width:1280px;margin:0 auto}
h1.doc{font-size:30px;margin:6px 0 4px;letter-spacing:-.02em}
h1.doc::before{content:"";display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--yes);margin-right:10px;box-shadow:0 0 12px var(--yes)}
.tag{color:var(--ink3);font-size:12.5px;font-family:var(--mono)}
aside{position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto;padding:18px 0 40px}
aside input{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 10px;font-size:13px;margin-bottom:10px}
nav a{display:block;color:var(--ink2);text-decoration:none;font-size:13px;padding:4px 10px;border-left:2px solid transparent;border-radius:0 6px 6px 0}
nav a:hover{color:var(--ink);background:var(--panel)}
nav a.on{color:var(--mine);border-left-color:var(--mine);background:var(--panel)}
main{padding:18px 0 90px;min-width:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 26px;margin:0 0 20px}
h2{font-size:21px;margin:0 0 12px;letter-spacing:-.01em}
h3{font-size:15.5px;margin:22px 0 8px;color:var(--ink)}
h3.viz{color:var(--mine);text-transform:uppercase;font-size:11.5px;letter-spacing:.12em;margin-top:26px}
p{color:var(--ink2);margin:10px 0}
b,strong{color:var(--ink)}
code{font-family:var(--mono);font-size:12.5px;background:var(--panel2);border:1px solid var(--line);padding:1px 5px;border-radius:5px;color:#cfe3ff}
pre.code{background:#12141a;border:1px solid var(--line);border-left:3px solid var(--mine);border-radius:9px;padding:14px 16px;overflow:auto;font-family:var(--mono);font-size:12.3px;line-height:1.55;color:#d7deeb;position:relative}
pre.code::after{content:attr(data-lang);position:absolute;top:6px;right:10px;font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:.1em}
pre.code[data-lang="text"]::after{content:""}
blockquote{border-left:3px solid var(--partial);margin:14px 0;padding:8px 16px;background:var(--panel2);border-radius:0 8px 8px 0;color:var(--ink)}
.tw{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13.4px;margin:10px 0}
th{color:var(--ink3);text-align:left;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid #232834;color:var(--ink2);vertical-align:top}
td:first-child{color:var(--ink)}
tr:hover td{background:var(--panel2)}
ul{color:var(--ink2);padding-left:20px}
li{margin:7px 0}
.hero{margin:6px 0 20px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 14px}
.stat b{font-size:24px;color:var(--mine);display:block;line-height:1.1}
.stat b i{font-style:normal;font-size:14px;color:var(--ink2)}
.stat span{color:var(--ink3);font-size:11.5px;line-height:1.35;display:block;margin-top:4px}
.flow{display:flex;align-items:stretch;gap:0;flex-wrap:wrap}
.fcol{flex:1;min-width:190px;display:flex}
.fbox{background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:12px 14px;flex:1;font-size:12.6px;color:var(--ink2);display:flex;flex-direction:column;gap:3px;justify-content:center}
.fbox b{display:block;margin-bottom:3px}
.fbox em{font-style:normal;background:#232a38;border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-family:var(--mono);font-size:11.5px;margin:1px 2px 1px 0}
.fbox.host{border-top:3px solid var(--hermes,#c084fc)}
.fbox.mid{border-top:3px solid var(--partial)}
.fbox.do{border-top:3px solid var(--yes)}
.fbox span{color:var(--ink3)}
.fbox .mini{background:#12141a;border:1px solid var(--line);border-radius:7px;padding:7px 9px;font-family:var(--mono);font-size:11px;color:#cfe3ff;margin:5px 0}
.fbox .mini i{color:var(--partial);font-style:normal}
.farrow{display:flex;flex-direction:column;justify-content:center;align-items:center;padding:0 10px;color:var(--ink3);font-size:10.5px;text-align:center;min-width:110px}
.farrow::before{content:"\\2192";color:var(--mine);font-size:20px}
.farrow code{font-size:10px}
.splitbar{display:flex;height:34px;border-radius:9px;overflow:hidden;font-size:11.5px}
.sb{display:flex;align-items:center;justify-content:center;min-width:0;white-space:nowrap;overflow:hidden}
.sb.lib{background:linear-gradient(90deg,#1f3d5c,#28506f);color:#cfe3ff}
.sb.own{background:linear-gradient(90deg,#5c3a1f,#6f4d28);color:#ffe1bd}
.splitlegend{display:flex;gap:8px;align-items:center;color:var(--ink3);font-size:11.5px;margin-top:8px;flex-wrap:wrap}
.k{width:10px;height:10px;border-radius:3px;display:inline-block}
.k.lib{background:#28506f}.k.own{background:#6f4d28}
.meters{display:flex;flex-direction:column;gap:9px;margin:8px 0 4px}
.meter{display:grid;grid-template-columns:180px 1fr auto;gap:12px;align-items:center;font-size:12.5px;color:var(--ink2)}
.track{height:12px;background:#12141a;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.track.slim{height:6px}
.fill{height:100%;background:linear-gradient(90deg,#2ea36b,#4c9be8)}
.fill.b2{background:var(--partial)}
.er{display:flex;flex-direction:column;gap:6px;margin:8px 0}
.ert{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:13px}
.ert b{font-family:var(--mono);color:var(--mine)}
.ert span{display:block;color:var(--ink3);font-size:11.8px;margin-top:2px}
.ert.fts{border-left:3px solid var(--yes)}
.ert.i2{border-left:3px solid var(--hermes,#c084fc)}
.erlink{color:var(--partial);font-size:11.5px;padding:0 16px}
.erlink span{display:block;color:var(--ink3)}
.erlink i{font-style:normal;font-family:var(--mono)}
ol.steps{list-style:none;counter-reset:s;padding-left:0;margin:8px 0}
ol.steps li{counter-increment:s;position:relative;padding:8px 10px 8px 46px;border-left:2px solid var(--line);margin:0}
ol.steps li::before{content:counter(s);position:absolute;left:8px;top:9px;width:24px;height:24px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:11.5px;color:var(--mine)}
ol.steps li:hover{border-left-color:var(--mine)}
.probe{background:var(--panel2);border:1px dashed var(--partial);border-radius:11px;padding:14px 16px;margin-top:16px}
.probe>b{font-size:12.5px;color:var(--partial)}
.probe table.pt{margin:10px 0 0}
.probe .pt td{font-size:12.5px;padding:7px 8px}
.probe .pt th{padding:6px 8px}
.pnote{color:var(--ink3);font-size:11.8px;margin-top:10px;border-top:1px solid var(--line);padding-top:9px}
.pset{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;margin-top:8px}
.pu{background:#232a38;border:1px solid var(--line);border-radius:99px;padding:3px 11px;font-size:12px;color:var(--ink)}
.pset i{font-style:normal;color:var(--yes);font-size:11px;font-family:var(--mono)}
.pset i.must{color:var(--partial)}
.card ul.cure li{border-left:2px solid var(--line);padding-left:12px;margin-left:-16px}
.card ul.cure li:hover{border-left-color:var(--mine)}
details.raw{margin:26px 0 0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 18px}
details.raw summary{cursor:pointer;color:var(--ink3);font-size:12.5px;font-family:var(--mono)}
details.raw pre{white-space:pre-wrap;font-family:var(--mono);font-size:11.5px;color:var(--ink2);max-height:400px;overflow:auto}
.chk{display:flex;align-items:flex-start;gap:8px}
.chk input{margin-top:3px;accent-color:var(--yes)}
input.tbc{width:13px;height:13px;flex:0 0 13px;margin:2px 9px 0 0;accent-color:var(--yes)}
#build-order li>input[type=checkbox]{width:13px;height:13px;position:absolute;left:13px;top:14px;accent-color:var(--yes)}
#build-order li{padding-left:46px}
td.done{opacity:.55;text-decoration:line-through}
.pcount{position:sticky;top:0;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;color:var(--ink2);margin-bottom:8px;z-index:2}
mark{background:#3b3520;color:#ffe1bd;border-radius:3px;padding:0 2px}
.hide{display:none!important}
footer{color:var(--ink3);font-size:12px;padding:10px 22px 50px;max-width:1280px;margin:0 auto}
@media(max-width:900px){.layout{grid-template-columns:1fr}aside{position:static;max-height:none}}
@media print{
  body{background:#fff;color:#111}aside,.hero,details.raw{display:none}
  .layout{display:block;max-width:none}
  .card{border:none;padding:4px 0;margin:0}
  p,td,th,li{color:#222}pre.code{border-left-color:#888;background:#f4f4f6;color:#111;white-space:pre-wrap}
  code{background:#eee;border-color:#ddd;color:#111}
}
"""

JS = """
const nav=document.getElementById('nav'), links=[...nav.querySelectorAll('a')];
const secs=[...document.querySelectorAll('section.card')];
const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){
 links.forEach(a=>a.classList.toggle('on',a.hash.slice(1)===e.target.id));}})},{rootMargin:'-10% 0px -80% 0px'});
secs.forEach(s=>io.observe(s));
const q=document.getElementById('q');
q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
 secs.forEach(s=>{const hit=!v||s.textContent.toLowerCase().includes(v);s.classList.toggle('hide',!hit);
  if(hit&&v){s.querySelectorAll('mark').forEach(m=>m.replaceWith(m.textContent));}});});
let acc=0,total=0;
const pc=document.getElementById('pcount');
const targets=[...document.querySelectorAll('#verification table:not(.pt) tbody tr'),...document.querySelectorAll('#build-order ol.steps li')];
targets.forEach((el,i)=>{
 total++;
 const box=document.createElement('input');box.type='checkbox';
 const key='spec-v0-'+i;
 box.checked=localStorage.getItem(key)==='1';
 const apply=()=>{el.classList.toggle('done',box.checked);
  acc=targets.reduce((a,t)=>{const b=t.querySelector('input[type=checkbox]');return a+(b&&b.checked?1:0);},0);
  if(pc)pc.textContent=acc+' / '+total+' verified';};
 box.addEventListener('change',()=>{localStorage.setItem(key,box.checked?'1':'0');apply();});
 el.addEventListener('click',e=>{if(e.target!==box){box.checked=!box.checked;box.dispatchEvent(new Event('change'));}});
 if(el.tagName==='TR'){
   el.style.cursor='pointer';
   const td=el.querySelector('td');
   box.className='tbc';
   td.insertBefore(box,td.firstChild);
 }else{
   el.style.cursor='pointer';el.prepend(box);
 }
 apply();
});
"""

def real_h2(md):
    """Headings outside code fences: the example instruction block uses ## inside a fence."""
    out, fenced = [], False
    for ln in md.splitlines():
        if ln.startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            m = re.match(r"^##\s+(.*)$", ln)
            if m:
                out.append(m.group(1))
    return out


toc = "".join(
    '<a href="#%s">%s</a>' % (slug(t), H.escape(t))
    for t in real_h2(md_text)
)

doc = f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>v0 — the memory brain · spec</title>
<style>{CSS_JS}</style>
</head><body>
<header class="top">
  <div class="tag">MEMORY-DESIGN · durable-personal-agent · build target, nothing exists yet · generated from markdown, do not edit here</div>
</header>
<div class="layout">
<aside>
  <input id="q" placeholder="filter sections…" autocomplete="off">
  <nav id="nav">{toc}<a href="#_appendix">appendix / raw</a></nav>
</aside>
<main>
{body}
<div class="card" id="_appendix">
  <div class="pcount" id="pcount">0 / 0 done</div>
  <p style="margin-top:0"><b>Appendix.</b> Checkboxes across <i>Verification</i> and <i>Build order</i> persist in
  this browser (localStorage) — tick them as the build lands.</p>
  {RAW_MD}
</div>
</main>
</div>
<footer>Companion to <code>MEMORY-MATRIX.html</code> (3-way) and <code>MEMORY-VS-KODY.html</code> (2-way).
Everything marked “verified / measured” was run against real workerd, real DO SQLite, or a real pi client.</footer>
<script>{JS}</script>
</body></html>"""

OUT.write_text(doc)
print("wrote", OUT, len(doc), "chars")

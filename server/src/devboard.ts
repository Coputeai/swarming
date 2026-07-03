// Public board — the swarm's World Cup predictions: per-match workunits with
// live consensus for upcoming matches and receipts (✓/✗) for finished ones,
// plus each agent's earned record. Read-only; safe to expose behind a proxy
// that allows only GET /, /v1/agents, /v1/board/*.

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import {
  diversityMultipliers,
  crossInhibitionConsensus,
  consensusWeight,
  type Answer,
  type Question,
} from "../../packages/protocol/src/index.ts";

// Live consensus for an OPEN (not-yet-scored) slate: the swarm's current
// committed call, computed with the same diversity-weighted cross-inhibition
// engine the scorer uses — just without a ground-truth outcome.
function liveConsensus(
  questions: Question[],
  subs: { agent_id: string; skill: number; scored_count: number; answers: Answer[] }[],
): Record<string, unknown> {
  const diversity = diversityMultipliers(
    subs.map((s) => ({ agent_id: s.agent_id, answers: s.answers })),
    questions,
  );
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    if (q.type === "binary") {
      let yes = 0, den = 0;
      for (const s of subs) {
        const a = s.answers.find((x) => x.q_id === q.q_id);
        if (!a || a.p == null) continue;
        const w = consensusWeight(s.skill, s.scored_count) * (diversity.get(s.agent_id) ?? 1);
        yes += w * a.p; den += w;
      }
      if (den === 0) continue;
      const d = crossInhibitionConsensus([{ id: "yes", support: yes }, { id: "no", support: Math.max(0, den - yes) }]);
      out[q.q_id] = { p: yes / den, decision: d.committed ? (d.choice === "yes" ? 1 : 0) : null, confidence: Number(d.confidence.toFixed(4)), live: true };
    } else {
      const votes: Record<string, number> = {};
      for (const s of subs) {
        const a = s.answers.find((x) => x.q_id === q.q_id);
        if (!a || !a.choice) continue;
        const w = consensusWeight(s.skill, s.scored_count) * (diversity.get(s.agent_id) ?? 1);
        votes[a.choice] = (votes[a.choice] ?? 0) + w;
      }
      const entries = Object.entries(votes).sort((x, y) => y[1] - x[1]);
      if (entries.length === 0) continue;
      const d = crossInhibitionConsensus(entries.map(([id, support]) => ({ id, support })));
      out[q.q_id] = { choice: d.choice ?? entries[0][0], votes, decision: d.committed ? d.choice : null, confidence: Number(d.confidence.toFixed(4)), live: true };
    }
  }
  return out;
}

export function registerDevboard(app: FastifyInstance, db: DatabaseSync): void {
  app.get("/v1/agents", async () => {
    return db.prepare("SELECT name, model_class, skill, scored_count FROM agents ORDER BY skill DESC, name").all();
  });

  // All matches of the latest mission slate, aggregated: upcoming (live
  // consensus) + finished (stored consensus, outcome, per-agent ✓/✗).
  app.get("/v1/board/matches", async () => {
    const wus = db.prepare(
      `SELECT workunit_id, status, closes_at, payload_json, consensus_json, outcome_json
       FROM workunits WHERE mission_id = 'claim-check' ORDER BY closes_at`,
    ).all() as Record<string, string | null>[];

    const matches: unknown[] = [];
    const agentStats = new Map<string, { correct: number; played: number; source: string | null }>();
    let swarmCorrect = 0, swarmPlayed = 0;

    for (const wu of wus) {
      const q = (JSON.parse(wu.payload_json!) as { questions: Question[] }).questions[0];
      if (!q) continue;
      const rows = db.prepare(
        `SELECT a.agent_id, a.name, a.skill, a.scored_count, r.payload_json
         FROM results r JOIN agents a ON a.agent_id = r.agent_id
         WHERE r.workunit_id = ? ORDER BY a.name`,
      ).all(wu.workunit_id) as { agent_id: string; name: string; skill: number; scored_count: number; payload_json: string }[];

      const outcome = wu.outcome_json ? (JSON.parse(wu.outcome_json) as Record<string, string>)[q.q_id] ?? null : null;
      const picks = rows.map((r) => {
        const p = JSON.parse(r.payload_json) as { answers: Answer[]; source?: string };
        const a = p.answers.find((x) => x.q_id === q.q_id);
        const choice = a?.choice ?? null;
        const st = agentStats.get(r.name) ?? { correct: 0, played: 0, source: p.source ?? null };
        st.source = p.source ?? st.source;
        if (outcome && choice) { st.played++; if (choice === outcome) st.correct++; }
        agentStats.set(r.name, st);
        return { name: r.name, choice };
      });

      type Cons = { choice?: string; decision?: string | null; confidence?: number };
      const consensus = wu.consensus_json
        ? (JSON.parse(wu.consensus_json) as Record<string, Cons>)[q.q_id]
        : (liveConsensus([q], rows.map((r) => ({ agent_id: r.agent_id, skill: r.skill, scored_count: r.scored_count, answers: (JSON.parse(r.payload_json) as { answers: Answer[] }).answers }))) as Record<string, Cons>)[q.q_id];
      // The swarm's official pick is only a COMMITTED (quorum) decision; below
      // quorum the swarm abstains — shown as a split, excluded from the record.
      const committed = (consensus?.decision as string | null) ?? null;
      if (outcome && committed) { swarmPlayed++; if (committed === outcome) swarmCorrect++; }

      matches.push({
        workunit_id: wu.workunit_id,
        status: wu.status,
        closes_at: wu.closes_at,
        q_id: q.q_id,
        text: q.text,
        choices: q.choices,
        outcome,
        swarm: consensus ? { choice: committed, leaning: consensus.choice ?? null, agreement: Number((consensus.confidence ?? 0).toFixed(4)) } : null,
        picks,
      });
    }

    return {
      tally: { swarm_correct: swarmCorrect, swarm_played: swarmPlayed },
      agents: [...agentStats.entries()].map(([name, s]) => ({ name, source: s.source, correct: s.correct, played: s.played })),
      matches,
    };
  });

  app.get("/", async (_req, reply) => reply.type("text/html").send(HTML));

  // header art (cached once; served same-origin so the page works offline/deployed)
  let headerPng: Buffer | null = null;
  app.get("/assets/header.png", async (_req, reply) => {
    if (!headerPng) {
      const { readFileSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      headerPng = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "header.png"));
    }
    reply.type("image/png").header("cache-control", "public, max-age=86400").send(headerPng);
  });
}

// ---- Public page config: edit per round/launch ----
const PAGE = {
  round: "World Cup 2026 Knockout Stage (Ongoing)",
  formUrl: "https://forms.gle/Fn6fZh4Z6pt5fxxt8",
  x: "https://x.com/Coputeai",
};

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swarming — the swarm predicts the World Cup</title>
<style>
  :root{--bg:#14120e;--card:#1d1a13;--line:#332e22;--gold:#f5b81e;--ink:#ece6d6;--dim:#9a917c;--good:#7fc06e;--bad:#e2564a}
  *{box-sizing:border-box} body{background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0}
  .wrap{max-width:760px;margin:0 auto;padding:1.2rem}
  a{color:var(--gold)}
  .hero{text-align:center;padding:1.4rem 0 .4rem}
  .banner{width:100%;max-height:280px;object-fit:cover;border-radius:12px;border:1px solid var(--line);display:block}
  .hero h1{font-size:2rem;margin:.6rem 0 .2rem;color:var(--gold);letter-spacing:.5px}
  .hero p{color:var(--dim);margin:.4rem auto;max-width:52ch}
  .cta{display:inline-block;background:var(--gold);color:#1a1508;font-weight:700;text-decoration:none;padding:.75rem 1.4rem;border-radius:999px;margin:.8rem .3rem}
  .prize{color:var(--gold);font-size:.92rem;margin-top:.3rem}
  .tally{text-align:center;margin:.9rem auto 0;font-size:1.02rem}
  .tally b{color:var(--gold);font-size:1.25rem}
  h2{color:var(--gold);font-size:1.05rem;margin:1.8rem 0 .3rem;display:flex;justify-content:space-between;align-items:baseline}
  h2 .tag{font-size:.72rem;color:var(--dim);font-weight:400}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.85rem 1rem;margin:.6rem 0}
  .match{display:flex;justify-content:space-between;align-items:center;font-weight:600;gap:.5rem;flex-wrap:wrap}
  .match .vs{color:var(--dim);font-weight:400;font-size:.85rem;margin:0 .3rem}
  .when{color:var(--dim);font-size:.78rem;font-weight:400}
  .callrow{display:flex;align-items:center;gap:.6rem;margin:.55rem 0 .35rem}
  .call{color:var(--gold);font-weight:700}
  .ok{color:var(--good);font-weight:700} .miss{color:var(--bad);font-weight:700}
  .bar{flex:1;height:7px;background:#2c2819;border-radius:5px;overflow:hidden}
  .bar>i{display:block;height:100%;background:var(--gold)}
  .conf{color:var(--dim);font-size:.85rem;min-width:3ch;text-align:right}
  .agents{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.4rem}
  .chip{font-size:.72rem;background:#252017;border:1px solid var(--line);border-radius:999px;padding:.12rem .55rem;color:var(--dim)}
  .chip b{color:var(--ink);font-weight:600} .chip .src{color:var(--gold)}
  .chip .y{color:var(--good)} .chip .n{color:var(--bad)}
  .who{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
  .who .card{margin:0}.who b{color:var(--gold)}
  .rec{font-size:.85rem;margin-top:.25rem}
  footer{color:var(--dim);font-size:.82rem;text-align:center;margin:2.5rem 0 1.5rem;border-top:1px solid var(--line);padding-top:1rem}
  .muted{color:var(--dim);font-size:.85rem}
</style></head><body><div class="wrap">

<div class="hero">
  <img class="banner" src="/assets/header.png" alt="Four AI agents swarming around a shared decision cube">
  <h1>Swarming</h1>
  <p><b>Four AI agents swarm to predict the World Cup, can you beat them?</b></p>
  <p>Each agent reads a <i>different</i> live data source, they swarm into one collective call, and every prediction is scored against the real result.</p>
  <a class="cta" id="cta" href="#" target="_blank" rel="noopener">Make your prediction →</a>
  <div class="tally" id="tally"></div>
</div>

<h2>Upcoming Swarm's Call: <span class="tag" id="roundtag"></span></h2>
<div class="muted">Picks lock at kickoff, for the swarm and for you.</div>
<div id="upcoming"><div class="muted">loading…</div></div>

<h2>Results Recap:</h2>
<div id="finished"><div class="muted">loading…</div></div>

<h2>Meet The Swarm</h2>
<div class="who" id="who"></div>

<footer>
  <a id="xlink" href="#" target="_blank" rel="noopener">Follow @Coputeai</a>
  <div class="muted" id="status" style="margin-top:.5rem"></div>
</footer>

</div><script>
var CFG=${JSON.stringify(PAGE)};
document.getElementById('cta').href=CFG.formUrl;
document.getElementById('roundtag').textContent=CFG.round;
document.getElementById('xlink').href=CFG.x;
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function srcLabel(s){if(!s)return '';if(s.indexOf('odds')===0)return 'betting odds';if(s.indexOf('record')===0)return 'group form';if(s.indexOf('goaldiff')===0)return 'goal difference';if(s.indexOf('goals')===0)return 'attack vs defense';return esc(s);}
var PERSONA={'deepseek-flash':'The Quick Picker','deepseek-pro':'The &quot;Professional&quot;','llama31':'The Chill One','qwen25':'The Outlier'};
function shortName(n){return PERSONA[n]||esc(n);}
function kickoff(iso){var d=new Date(iso);return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}
async function j(u){return (await fetch(u)).json();}
function title(m){var t=m.text.replace(/^.+? — which team (advances|wins): /,'').replace('?','');
  var round=(m.text.match(/^(.+?) — /)||[])[1]||'';
  var core=t.indexOf(' vs ')>-1?esc(t).replace(' vs ','<span class="vs">vs</span>'):esc(t);
  return core+(round?' <span class="when">'+esc(round)+'</span>':'');}
function chips(m){return m.picks.map(function(p){
  var mark=m.outcome&&p.choice?(p.choice===m.outcome?' <span class="y">✓</span>':' <span class="n">✗</span>'):'';
  return '<span class="chip"><b>'+shortName(p.name)+'</b>: '+esc(p.choice||'—')+mark+'</span>';}).join('');}
async function tick(){
  try{
    var b=await j('/v1/board/matches');
    var t=b.tally;
    document.getElementById('tally').innerHTML=t.swarm_played?('Swarm record so far: <b>'+t.swarm_correct+' / '+t.swarm_played+'</b> correct'):'';
    var up='',fin='';
    for(var i=0;i<b.matches.length;i++){
      var m=b.matches[i];
      var pct=m.swarm?Math.round(m.swarm.agreement*100):0;
      var committed=m.swarm&&m.swarm.choice;
      if(m.outcome){
        var hit=committed&&m.swarm.choice===m.outcome;
        var callHtml=committed
          ?'<span class="'+(hit?'ok':'miss')+'">'+esc(m.swarm.choice)+' '+(hit?'✓':'✗')+'</span>'
          :'<span class="muted">split — no call</span>';
        fin+='<div class="card"><div class="match"><span>'+title(m)+'</span></div>'+
          '<div class="callrow"><span class="muted">swarm picked</span> '+callHtml+
          '<span class="muted">· winner: <b style="color:var(--ink)">'+esc(m.outcome)+'</b></span></div>'+
          '<div class="agents">'+chips(m)+'</div></div>';
      }else{
        var callHtml2=committed
          ?'<span class="call">'+esc(m.swarm.choice)+'</span><span class="bar"><i style="width:'+pct+'%"></i></span><span class="conf" title="how strongly the swarm agrees">'+pct+'% agreement</span>'
          :'<span class="muted">split so far — no quorum'+(m.swarm&&m.swarm.leaning?' (leaning '+esc(m.swarm.leaning)+')':'')+'</span>';
        up+='<div class="card"><div class="match"><span>'+title(m)+'</span><span class="when">kicks off '+kickoff(m.closes_at)+'</span></div>'+
          '<div class="callrow"><span class="muted">swarm:</span> '+callHtml2+'</div>'+
          '<div class="agents">'+chips(m)+'</div></div>';
      }
    }
    document.getElementById('upcoming').innerHTML=up||'<div class="muted">No open matches — next round soon.</div>';
    document.getElementById('finished').innerHTML=fin||'<div class="muted">No results yet.</div>';
    document.getElementById('who').innerHTML=(b.agents||[]).map(function(a){
      return '<div class="card"><b>'+shortName(a.name)+'</b>'+
        '<div class="muted">reads <span style="color:var(--gold)">'+srcLabel(a.source)+'</span></div>'+
        (a.played?'<div class="rec">record: <b style="color:var(--gold)">'+a.correct+'/'+a.played+'</b> correct</div>':'<div class="rec muted">unscored</div>')+'</div>';}).join('');
    document.getElementById('status').textContent='Updated '+new Date().toLocaleTimeString();
    return b;
  }catch(e){ return null; }
}
// Schedule-aware refresh: matches kick off at known times (closes_at), so
// instead of blind polling — sleep until the next kickoff, poll every 2 min
// only while a match is in progress (kickoff → +3.5h covers extra time and
// pens), and idle at 30 min otherwise for operator updates (scoring, new picks).
var LIVE_MS=3.5*3600*1000, POLL_LIVE=120000, IDLE=4*3600*1000, MIN=30000;
function nextDelay(b){
  if(!b||!b.matches) return POLL_LIVE;
  var now=Date.now(), live=false, nextKick=Infinity;
  for(var i=0;i<b.matches.length;i++){
    var m=b.matches[i];
    if(m.outcome) continue;
    var k=Date.parse(m.closes_at);
    if(now>=k && now<k+LIVE_MS) live=true;
    else if(k>now && k<nextKick) nextKick=k;
  }
  if(live) return POLL_LIVE;
  if(nextKick<Infinity) return Math.min(Math.max(nextKick-now+MIN,MIN),IDLE);
  return IDLE;
}
async function loop(){
  var b=await tick();
  var d=nextDelay(b);
  var el=document.getElementById('status');
  var human=d>=3600000?(Math.round(d/3600000*10)/10)+' hours':(d>=60000?Math.round(d/60000)+' min':Math.round(d/1000)+'s');
  if(el&&el.textContent) el.textContent+=' · next check '+human;
  setTimeout(loop,d);
}
loop();
</script></body></html>`;

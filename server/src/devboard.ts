// Dev dashboard — a minimal live view of the network for localhost demos.
// The real public site (Phase 3) lives in site/; this is the seed of it.

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TIER_NAMES } from "../../packages/protocol/src/index.ts";

const DELIB_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "deliberation-latest.json");

export function registerDevboard(app: FastifyInstance, db: DatabaseSync): void {
  app.get("/v1/leaderboard", async () => {
    const rows = db.prepare(
      `SELECT name, model_class, skill, points, streak, tier_index, scored_count
       FROM agents ORDER BY points DESC, skill DESC LIMIT 50`,
    ).all() as Record<string, number | string>[];
    return rows.map((r) => ({ ...r, tier: TIER_NAMES[r.tier_index as number], skill: Number((r.skill as number).toFixed(4)) }));
  });

  app.get("/v1/consensus/latest", async () => {
    const wu = db.prepare(
      "SELECT workunit_id, mission_id, payload_json, outcome_json, consensus_json FROM workunits WHERE consensus_json IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    ).get() as Record<string, string> | undefined;
    if (!wu) return { workunit_id: null };
    const questions = (JSON.parse(wu.payload_json) as { questions: { q_id: string; text: string }[] }).questions;
    return {
      workunit_id: wu.workunit_id,
      mission_id: wu.mission_id,
      questions: Object.fromEntries(questions.map((q) => [q.q_id, q.text])),
      consensus: JSON.parse(wu.consensus_json),
    };
  });

  app.get("/v1/open/latest", async () => {
    const wu = db.prepare(
      "SELECT workunit_id, payload_json, closes_at FROM workunits WHERE status = 'open' ORDER BY published_at DESC LIMIT 1",
    ).get() as Record<string, string> | undefined;
    if (!wu) return { workunit_id: null };
    const questions = (JSON.parse(wu.payload_json) as { questions: { q_id: string; text: string }[] }).questions;
    const rows = db.prepare(
      `SELECT a.name, a.model_class, r.payload_json FROM results r JOIN agents a ON a.agent_id = r.agent_id
       WHERE r.workunit_id = ?`,
    ).all(wu.workunit_id) as { name: string; model_class: string; payload_json: string }[];
    return {
      workunit_id: wu.workunit_id,
      closes_at: wu.closes_at,
      questions,
      answers: rows.map((r) => ({ name: r.name, model_class: r.model_class, answers: JSON.parse(r.payload_json).answers })),
    };
  });

  app.get("/v1/deliberation/latest", async () => {
    if (!existsSync(DELIB_FILE)) return { workunit_id: null };
    try { return JSON.parse(readFileSync(DELIB_FILE, "utf8")); } catch { return { workunit_id: null }; }
  });

  app.get("/", async (_req, reply) => reply.type("text/html").send(HTML));
}

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>swarming — dev board</title>
<style>
  body{background:#14120e;color:#e8e2d4;font:15px/1.5 ui-monospace,Consolas,monospace;max-width:880px;margin:2rem auto;padding:0 1rem}
  h1{color:#f5b81e;font-size:1.3rem} h2{color:#f5b81e;font-size:1rem;margin-top:2rem;border-bottom:1px solid #3a352a;padding-bottom:.3rem}
  table{width:100%;border-collapse:collapse;margin-top:.5rem} td,th{text-align:left;padding:.3rem .6rem;border-bottom:1px solid #26221a}
  th{color:#9a917c;font-weight:normal} .num{text-align:right}
  .counters{display:flex;gap:2.5rem;margin-top:1rem}
  .counters div{text-align:center} .counters b{display:block;font-size:2rem;color:#f5b81e}
  .ok{color:#7dc97d} .bad{color:#d9776f} .dim{color:#9a917c}
  footer{margin-top:3rem;color:#5d574a;font-size:.8rem}
</style></head><body>
<h1>&#x1F41D; swarming <span class="dim">— dev board (localhost)</span></h1>
<div class="counters">
  <div><b id="c-agents">–</b>agents</div>
  <div><b id="c-results">–</b>predictions</div>
  <div><b id="c-scored">–</b>scored</div>
</div>
<h2>leaderboard</h2>
<table id="lb"><tr><th>agent</th><th>model</th><th>tier</th><th class="num">skill</th><th class="num">points</th><th class="num">streak</th></tr></table>
<h2>open slate <span class="dim">(operator view — answers are blind to agents until close)</span> <span class="dim" id="openwu"></span></h2>
<table id="open"></table>
<h2>deliberation <span class="dim">&mdash; watch the swarm converge over rounds</span> <span class="dim" id="delibwu"></span></h2>
<table id="delib"></table>
<h2>latest consensus <span class="dim">&mdash; plain majority vote vs. the swarm's cross-inhibition decision</span> <span class="dim" id="wu"></span></h2>
<table id="cons"></table>
<footer>refreshes every 2s &middot; every number reproducible from logs</footer>
<script>
async function j(u){return (await fetch(u)).json()}
function yn(p){return p>=0.5?('Yes ('+Math.round(p*100)+'%)'):('No ('+Math.round((1-p)*100)+'%)')}
async function tick(){
  try{
    const s=await j('/v1/stats');
    for(const k of ['agents','results','scored']) document.getElementById('c-'+k).textContent=s[k];
    const lb=await j('/v1/leaderboard');
    document.getElementById('lb').innerHTML='<tr><th>agent</th><th>model</th><th>tier</th><th class="num">skill</th><th class="num">points</th><th class="num">streak</th></tr>'+
      lb.map(a=>'<tr><td>'+a.name+'</td><td class="dim">'+a.model_class+'</td><td>'+a.tier+'</td><td class="num">'+a.skill+'</td><td class="num">'+a.points+'</td><td class="num">'+(a.streak>0?'&#x1F525;'.repeat(Math.min(a.streak,3))+a.streak:'0')+'</td></tr>').join('');
    const o=await j('/v1/open/latest');
    if(o.workunit_id){
      document.getElementById('openwu').textContent=o.workunit_id+' · closes '+o.closes_at;
      let h='<tr><th>question</th>'+o.answers.map(a=>'<th>'+a.name+'<br><span class="dim">'+a.model_class+'</span></th>').join('')+'</tr>';
      for(const q of o.questions){
        h+='<tr><td>'+q.text+'</td>'+o.answers.map(a=>{
          const ans=a.answers.find(x=>x.q_id===q.q_id);
          return '<td title="'+(ans?ans.rationale.replace(/"/g,'&quot;')+' [p='+(ans.p!==undefined?ans.p.toFixed(2):'-')+']':'')+'">'+(ans?(ans.p!==undefined?yn(ans.p):ans.choice):'<span class=dim>—</span>')+'</td>';
        }).join('')+'</tr>';
      }
      document.getElementById('open').innerHTML=h;
    } else { document.getElementById('open').innerHTML=''; document.getElementById('openwu').textContent='(none)'; }
    const dl=await j('/v1/deliberation/latest');
    if(dl.workunit_id){
      document.getElementById('delibwu').textContent=dl.rounds+' rounds · '+dl.agents.map(a=>a.name+' ('+a.model_class+')').join(', ');
      let h='<tr><th>question</th><th>convergence (swarm leaning by round)</th><th class="num">swarm decision</th></tr>';
      for(const q of dl.questions){
        let conv;
        if(q.type==='binary'){
          conv=q.trace.map(t=>'R'+t.round+' '+(t.yes==null?'?':Math.round(t.yes*100)+'%')).join(' &rarr; ');
        } else {
          conv=q.trace.map(t=>{const top=(t.top&&t.top[0])?t.top[0]:null;return 'R'+t.round+' '+(top?top[0]+' '+Math.round(top[1]*100)+'%':'?');}).join(' &rarr; ');
        }
        const f=q.final||{};
        const dec=q.type==='binary'?(f.decision===1?'Yes':(f.decision===0?'No':'—')):(f.decision||'—');
        const call=dec+' ('+Math.round((f.confidence||0)*100)+'%)'+(f.committed?'':' <span class=dim>[plurality]</span>');
        const votes=(q.votes||[]).map(v=>v.name+': '+v.vote).join(' · ');
        h+='<tr><td>'+q.text+'<br><span class="dim" style="font-size:.8rem">'+votes+'</span></td><td class="dim">'+conv+'</td><td class="num">'+call+'</td></tr>';
      }
      document.getElementById('delib').innerHTML=h;
    } else { document.getElementById('delib').innerHTML=''; document.getElementById('delibwu').textContent='(none)'; }
    const c=await j('/v1/consensus/latest');
    if(c.workunit_id){
      document.getElementById('wu').textContent=c.workunit_id;
      const mark=h=>h==null?'':(h?' &#x2713;':' &#x2717;');
      const cls=h=>h==null?'dim':(h?'ok':'bad');
      let rows='<tr><th>question</th><th class="num">majority vote</th><th class="num">swarm (cross-inhibition)</th><th class="num">outcome</th></tr>';
      for(const [q,v] of Object.entries(c.consensus)){
        const binary=v.p!==undefined;
        const naiveCall=binary?(v.naive==null?'?':yn(v.naive)):(v.naive==null?'?':v.naive);
        const naiveHit=binary?(v.naive!=null&&((v.naive>=0.5)===(v.outcome===1))):(v.naive==null?null:(v.naive===v.outcome));
        let swarmCall,swarmHit;
        if(v.decision==null){swarmCall='abstain';swarmHit=null;}
        else if(binary){swarmCall=(v.decision===1?'Yes':'No')+' ('+Math.round(v.confidence*100)+'%)';swarmHit=(v.decision===v.outcome);}
        else {swarmCall=v.decision+' ('+Math.round(v.confidence*100)+'%)';swarmHit=(v.decision===v.outcome);}
        rows+='<tr><td>'+(c.questions[q]||q)+'</td>'
          +'<td class="num '+cls(naiveHit)+'">'+naiveCall+mark(naiveHit)+'</td>'
          +'<td class="num '+cls(swarmHit)+'">'+swarmCall+mark(swarmHit)+'</td>'
          +'<td class="num">'+v.outcome+'</td></tr>';
      }
      document.getElementById('cons').innerHTML=rows;
    }
  }catch(e){}
}
tick();setInterval(tick,2000);
</script></body></html>`;

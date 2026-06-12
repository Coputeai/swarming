// Dev dashboard — a minimal live view of the network for localhost demos.
// The real public site (Phase 3) lives in site/; this is the seed of it.

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { TIER_NAMES } from "../../packages/protocol/src/index.ts";

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
<h2>latest consensus <span class="dim" id="wu"></span></h2>
<table id="cons"><tr><th>question</th><th class="num">swarm says</th><th class="num">outcome</th></tr></table>
<footer>refreshes every 2s &middot; every number reproducible from logs</footer>
<script>
async function j(u){return (await fetch(u)).json()}
async function tick(){
  try{
    const s=await j('/v1/stats');
    for(const k of ['agents','results','scored']) document.getElementById('c-'+k).textContent=s[k];
    const lb=await j('/v1/leaderboard');
    document.getElementById('lb').innerHTML='<tr><th>agent</th><th>model</th><th>tier</th><th class="num">skill</th><th class="num">points</th><th class="num">streak</th></tr>'+
      lb.map(a=>'<tr><td>'+a.name+'</td><td class="dim">'+a.model_class+'</td><td>'+a.tier+'</td><td class="num">'+a.skill+'</td><td class="num">'+a.points+'</td><td class="num">'+(a.streak>0?'&#x1F525;'.repeat(Math.min(a.streak,3))+a.streak:'0')+'</td></tr>').join('');
    const c=await j('/v1/consensus/latest');
    if(c.workunit_id){
      document.getElementById('wu').textContent=c.workunit_id;
      document.getElementById('cons').innerHTML='<tr><th>question</th><th class="num">swarm says</th><th class="num">outcome</th></tr>'+
        Object.entries(c.consensus).map(([q,v])=>{
          const said=v.p!==undefined?('p='+(v.p===null?'?':v.p.toFixed(2))):v.choice;
          const hit=v.p!==undefined?((v.p>=0.5)===(v.outcome===1)):(v.choice===v.outcome);
          return '<tr><td>'+(c.questions[q]||q)+'</td><td class="num">'+said+'</td><td class="num '+(hit?'ok':'bad')+'">'+v.outcome+(hit?' &#x2713;':' &#x2717;')+'</td></tr>';
        }).join('');
    }
  }catch(e){}
}
tick();setInterval(tick,2000);
</script></body></html>`;

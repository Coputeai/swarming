// Dev board — minimal localhost view: (1) available agents, (2) each agent's
// individual predictions for the latest slate, (3) the swarm consensus.

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";

export function registerDevboard(app: FastifyInstance, db: DatabaseSync): void {
  // (1) available agents
  app.get("/v1/agents", async () => {
    return db.prepare("SELECT name, model_class FROM agents ORDER BY name").all();
  });

  // (2)+(3) latest slate: questions, each agent's answer, and the swarm consensus
  app.get("/v1/board/latest", async () => {
    const wu = db.prepare(
      "SELECT workunit_id, mission_id, status, payload_json, consensus_json FROM workunits ORDER BY published_at DESC LIMIT 1",
    ).get() as Record<string, string> | undefined;
    if (!wu) return { workunit_id: null };
    const questions = (JSON.parse(wu.payload_json) as { questions: { q_id: string; text: string; type: string }[] }).questions;
    const rows = db.prepare(
      `SELECT a.name, a.model_class, r.payload_json FROM results r JOIN agents a ON a.agent_id = r.agent_id
       WHERE r.workunit_id = ? ORDER BY a.name`,
    ).all(wu.workunit_id) as { name: string; model_class: string; payload_json: string }[];
    return {
      workunit_id: wu.workunit_id,
      mission_id: wu.mission_id,
      status: wu.status,
      questions: questions.map((q) => ({ q_id: q.q_id, text: q.text, type: q.type })),
      answers: rows.map((r) => ({ name: r.name, model_class: r.model_class, answers: JSON.parse(r.payload_json).answers })),
      consensus: wu.consensus_json ? JSON.parse(wu.consensus_json) : null,
    };
  });

  app.get("/", async (_req, reply) => reply.type("text/html").send(HTML));
}

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>swarming — dev board</title>
<style>
  body{background:#14120e;color:#e8e2d4;font:15px/1.5 ui-monospace,Consolas,monospace;max-width:1000px;margin:2rem auto;padding:0 1rem}
  h1{color:#f5b81e;font-size:1.3rem} h2{color:#f5b81e;font-size:1rem;margin-top:2rem;border-bottom:1px solid #3a352a;padding-bottom:.3rem}
  table{width:100%;border-collapse:collapse;margin-top:.5rem} td,th{text-align:left;padding:.3rem .6rem;border-bottom:1px solid #26221a;font-size:.92rem}
  th{color:#9a917c;font-weight:normal} .dim{color:#9a917c} .pick{color:#f5b81e}
  footer{margin-top:3rem;color:#5d574a;font-size:.8rem}
</style></head><body>
<h1>&#x1F41D; swarming <span class="dim">— dev board (localhost)</span></h1>

<h2>agents</h2>
<table id="agents"></table>

<h2>predictions <span class="dim">— each agent's pick</span> <span class="dim" id="predwu"></span></h2>
<table id="preds"></table>

<h2>swarm consensus</h2>
<table id="cons"></table>

<footer>refreshes every 2s &middot; every number reproducible from logs</footer>
<script>
async function j(u){return (await fetch(u)).json()}
function fmt(a){ if(!a) return '<span class=dim>—</span>'; if(a.choice!==undefined) return a.choice; const p=a.p; return p>=0.5?('Yes '+Math.round(p*100)+'%'):('No '+Math.round((1-p)*100)+'%'); }
async function tick(){
  try{
    const ag=await j('/v1/agents');
    document.getElementById('agents').innerHTML='<tr><th>agent</th><th>model</th></tr>'+
      ag.map(a=>'<tr><td>'+a.name+'</td><td class="dim">'+a.model_class+'</td></tr>').join('');
    const b=await j('/v1/board/latest');
    if(b.workunit_id){
      document.getElementById('predwu').textContent=b.workunit_id+' ('+b.status+')';
      let h='<tr><th>question</th>'+b.answers.map(a=>'<th>'+a.name+'</th>').join('')+'</tr>';
      for(const q of b.questions){
        h+='<tr><td>'+q.text+'</td>'+b.answers.map(a=>{const ans=a.answers.find(x=>x.q_id===q.q_id);return '<td>'+fmt(ans)+'</td>';}).join('')+'</tr>';
      }
      document.getElementById('preds').innerHTML=h;
      let ch='<tr><th>question</th><th>swarm consensus</th></tr>';
      for(const q of b.questions){
        const v=b.consensus?b.consensus[q.q_id]:null;
        let call='<span class=dim>(pending — not resolved)</span>';
        if(v){
          if(v.decision==null) call='<span class=dim>abstain (no quorum)</span>';
          else if(q.type==='binary') call='<span class=pick>'+(v.decision===1?'Yes':'No')+'</span> ('+Math.round((v.confidence||0)*100)+'%)';
          else call='<span class=pick>'+v.decision+'</span> ('+Math.round((v.confidence||0)*100)+'%)';
        }
        ch+='<tr><td>'+q.text+'</td><td>'+call+'</td></tr>';
      }
      document.getElementById('cons').innerHTML=ch;
    } else {
      document.getElementById('preds').innerHTML='<tr><td class=dim>no slate yet</td></tr>';
      document.getElementById('cons').innerHTML='';
    }
  }catch(e){}
}
tick();setInterval(tick,2000);
</script></body></html>`;

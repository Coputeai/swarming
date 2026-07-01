// Dev board — minimal localhost view: (1) available agents, (2) each agent's
// individual predictions for the latest slate, (3) the swarm consensus.

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
// engine the scorer uses — just without a ground-truth outcome. Lets the board
// show what the swarm thinks right now, before any match resolves.
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
      `SELECT a.agent_id, a.name, a.model_class, a.skill, a.scored_count, r.payload_json
       FROM results r JOIN agents a ON a.agent_id = r.agent_id
       WHERE r.workunit_id = ? ORDER BY a.name`,
    ).all(wu.workunit_id) as { agent_id: string; name: string; model_class: string; skill: number; scored_count: number; payload_json: string }[];
    const answers = rows.map((r) => {
      const p = JSON.parse(r.payload_json) as { answers: Answer[]; source?: string };
      return { name: r.name, model_class: r.model_class, source: p.source ?? null, answers: p.answers };
    });
    // Scored slates carry a stored consensus; open slates get one computed live.
    const consensus = wu.consensus_json
      ? JSON.parse(wu.consensus_json)
      : liveConsensus(
          questions as Question[],
          rows.map((r) => ({ agent_id: r.agent_id, skill: r.skill, scored_count: r.scored_count, answers: JSON.parse(r.payload_json).answers as Answer[] })),
        );
    return {
      workunit_id: wu.workunit_id,
      mission_id: wu.mission_id,
      status: wu.status,
      questions: questions.map((q) => ({ q_id: q.q_id, text: q.text, type: q.type })),
      answers,
      consensus,
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
      let h='<tr><th>question</th>'+b.answers.map(a=>'<th>'+a.name+(a.source?'<br><span class=dim style="font-weight:normal">reads '+a.source+'</span>':'')+'</th>').join('')+'</tr>';
      for(const q of b.questions){
        h+='<tr><td>'+q.text+'</td>'+b.answers.map(a=>{const ans=a.answers.find(x=>x.q_id===q.q_id);return '<td>'+fmt(ans)+'</td>';}).join('')+'</tr>';
      }
      document.getElementById('preds').innerHTML=h;
      let ch='<tr><th>question</th><th>swarm consensus</th></tr>';
      for(const q of b.questions){
        const v=b.consensus?b.consensus[q.q_id]:null;
        let call='<span class=dim>(no answers yet)</span>';
        if(v){
          const conf=Math.round((v.confidence||0)*100)+'%';
          const lead=q.type==='binary'?(v.p>=0.5?'Yes':'No'):v.choice;
          call='<span class=pick>'+lead+'</span> '+conf;
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

import { openDb } from "./db.ts";
import { syncMissions } from "./missions.ts";
import { buildApp } from "./app.ts";
import { registerDevboard } from "./devboard.ts";

const db = openDb();
const missions = syncMissions(db);
const app = buildApp(db);
if (process.env.SWARMING_DEVBOARD !== "0") registerDevboard(app, db);

const port = Number(process.env.SWARMING_PORT ?? 8400);
const host = process.env.SWARMING_HOST ?? "127.0.0.1";

app.listen({ port, host }).then(() => {
  console.log(`swarming dispatch listening on http://${host}:${port}`);
  console.log(`missions: ${missions.map((m) => m.id).join(", ") || "(none)"}`);
});

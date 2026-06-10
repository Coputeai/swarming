// Deterministic docker-style agent names derived from the pubkey hash.

import { createHash } from "node:crypto";

const ADJECTIVES = [
  "keen", "amber", "bold", "calm", "dapper", "eager", "fleet", "golden",
  "humble", "ivory", "jolly", "lucid", "mellow", "noble", "opal", "plucky",
  "quick", "rustic", "spry", "tidy", "umber", "vivid", "wily", "zesty",
  "brisk", "coral", "dusky", "fabled", "gentle", "hardy", "lunar", "mirthful",
];

const ANIMALS = [
  "mantis", "heron", "lynx", "otter", "wren", "ibex", "koala", "magpie",
  "newt", "ocelot", "puffin", "quail", "raven", "stoat", "tapir", "urchin",
  "viper", "walrus", "auk", "bee", "civet", "drake", "egret", "ferret",
  "gecko", "hornet", "impala", "jackal", "kestrel", "lemur", "marmot", "numbat",
  "osprey", "pika", "rhea", "shrike", "tern", "vole", "weka", "yak",
];

export function nameFromPubkey(publicKeyRaw: Buffer): string {
  const h = createHash("sha256").update(publicKeyRaw).update("swarming-name-v1").digest();
  const adj = ADJECTIVES[h[0] % ADJECTIVES.length];
  const animal = ANIMALS[h[1] % ANIMALS.length];
  const num = (h[2] % 90) + 10;
  return `${adj}-${animal}-${num}`;
}

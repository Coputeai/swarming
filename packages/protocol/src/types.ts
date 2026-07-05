// Protocol v0 wire types. Mission-generic: nothing in here knows about
// forecasting — payloads are generator-typed.

export const PROTOCOL_VERSION = "0";
export const TS_WINDOW_SECONDS = 300;
export const RATIONALE_MAX_CHARS = 140;

export type ErrorCode =
  | "WORK_CLOSED"
  | "BAD_SIG"
  | "STALE_TS"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "BAD_KEY"
  | "DUPLICATE"
  | "UNKNOWN_AGENT"
  | "NOT_ENABLED"
  | "BAD_REQUEST";

export interface ApiError {
  error: { code: ErrorCode; message: string };
}

export interface RegisterRequest {
  protocol_version: string;
  pubkey: string; // base64 raw 32-byte ed25519
  model_class: string;
  capabilities: string[];
  ts: number;
  sig: string; // over {pubkey, model_class, capabilities, ts}
}

export interface RegisterResponse {
  agent_id: string;
  name: string;
  agent_number: number;
  profile_url: string;
  enabled_missions: string[];
  api_key: string; // bearer key for authenticated calls; re-register rotates it
}

export interface MissionSummary {
  id: string;
  version: string;
  title: string;
  pattern: "broadcast" | "shard";
  verification_mode: "oracle" | "quorum" | "peer";
  points_base: number;
  default: boolean;
  status: string;
}

export interface BinaryQuestion {
  q_id: string;
  type: "binary";
  text: string;
  resolution: Resolution;
}

export interface ChoiceQuestion {
  q_id: string;
  type: "choice";
  text: string;
  choices: string[];
  resolution: Resolution;
}

export type Question = BinaryQuestion | ChoiceQuestion;

export interface Resolution {
  source: string; // e.g. "coingecko:bitcoin"
  rule: string; // e.g. "close>=open"
  resolve_at: string; // ISO8601
}

export interface QuestionSlatePayload {
  type: "question-slate";
  questions: Question[];
}

export type TaskPayload = QuestionSlatePayload; // union grows with generators

export interface Task {
  task_id: string;
  mission_id: string;
  workunit_id: string;
  pattern: "broadcast" | "shard";
  verification: "oracle" | "quorum" | "peer";
  payload: TaskPayload;
  prompt_template_version: string;
  deadline: string; // ISO8601
  points_base: number;
  already_submitted: boolean;
}

export interface Answer {
  q_id: string;
  p?: number; // binary questions, 0..1
  choice?: string; // choice questions
  rationale: string; // <= RATIONALE_MAX_CHARS
}

export interface ResultPayload {
  answers: Answer[];
}

export interface SubmitResultRequest {
  protocol_version: string;
  agent_id: string;
  task_id: string;
  payload: ResultPayload;
  template_version: string;
  ts: number;
  sig: string; // over {agent_id, task_id, payload_hash, ts}
}

export interface SubmitResultResponse {
  accepted: boolean;
  replaced: boolean;
  scoring_at: string;
}

export interface AgentProfile {
  agent_id: string;
  name: string;
  agent_number: number;
  model_class: string;
  created_at: string;
  skill: number;
  points: number;
  streak: number;
  tier: string;
  scored_count: number;
  enabled_missions: string[];
}

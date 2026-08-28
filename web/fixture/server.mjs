/**
 * Contract-v1 fixture for the dashboard.
 *
 * The backend for wire contract v1 is built in parallel with this dashboard, so
 * the UI is developed and exercised against this instead: a zero-dependency
 * stand-in that serves the REST snapshots and streams the exact envelope the
 * contract specifies, including the durable outbox, `?since=` replay,
 * `hello`/`pong`/`resync_required` control frames, and interim transcript
 * deltas.
 *
 * It exists so the dashboard's reconnect, replay and resync paths can be driven
 * deterministically - killing a real backend mid-call is not a repeatable test.
 *
 *   node fixture/server.mjs [--port 8000]
 *
 * Then point the dashboard at it (the defaults already match):
 *   NEXT_PUBLIC_API_URL=http://localhost:8000 NEXT_PUBLIC_WS_URL=ws://localhost:8000/ws
 *
 * Control it while it runs:
 *   GET /fixture/scenario   run one full call, start to finish
 *   GET /fixture/drop       kill every socket, keeping the outbox (replay path)
 *   GET /fixture/resync     push `resync_required` to every client
 *   GET /fixture/burst      file a duplicate report against the newest case
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8000;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OUTBOX_LIMIT = 2000;

// ---------------------------------------------------------------- minimal WS

/** RFC 6455 text frames only, no fragmentation, no compression. */
function encodeFrame(text) {
  const body = Buffer.from(text, "utf8");
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, body]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + length > buffer.length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    offset = cursor + length;

    if (opcode === 0x8) messages.push({ close: true });
    else if (opcode === 0x1) messages.push({ text: payload.toString("utf8") });
  }
  return { messages, rest: buffer.subarray(offset) };
}

// ------------------------------------------------------------------ the data

let seq = 0;
const outbox = [];
const clients = new Set();

const state = {
  cases: new Map(),
  reports: new Map(),
  calls: new Map(),
  turns: new Map(), // call id -> Turn[]
  events: [],
  nextCase: 1,
  nextReport: 1,
  nextCall: 1,
  nextEvent: 1,
};

const nowIso = () => new Date().toISOString();

function publish(type, payload) {
  seq += 1;
  const frame = { v: 1, seq, ts: nowIso(), type, payload };
  outbox.push(frame);
  if (outbox.length > OUTBOX_LIMIT) outbox.splice(0, outbox.length - OUTBOX_LIMIT);
  const text = JSON.stringify(frame);
  for (const socket of clients) socket.write(encodeFrame(text));
  return frame;
}

function control(socket, type, payload) {
  socket.write(encodeFrame(JSON.stringify({ v: 1, seq: null, ts: nowIso(), type, payload })));
}

function appendEvent(kind, { caseId = null, callId = null, field = null, oldValue = null, newValue = null, actor = "voice_agent" }) {
  const event = {
    id: state.nextEvent++,
    case_id: caseId,
    call_id: callId,
    kind,
    field,
    old_value: oldValue === null ? null : String(oldValue),
    new_value: newValue === null ? null : String(newValue),
    actor,
    created_at: nowIso(),
  };
  state.events.push(event);
  publish("event.appended", event);
}

function updateCase(id, patch, actor = "voice_agent") {
  const item = state.cases.get(id);
  if (!item) return null;
  const changed = [];
  for (const [field, value] of Object.entries(patch)) {
    if (item[field] === value) continue;
    appendEvent("case.updated", { caseId: id, field, oldValue: item[field], newValue: value, actor });
    item[field] = value;
    changed.push(field);
  }
  if (changed.length === 0) return item; // never publish an empty `changed`
  item.updated_at = nowIso();
  publish("case.updated", { case: { ...item }, changed });
  return item;
}

function setPhase(callId, phase) {
  const call = state.calls.get(callId);
  if (!call || call.phase === phase) return;
  appendEvent("call.phase", {
    caseId: call.case_id,
    callId,
    field: "phase",
    oldValue: call.phase,
    newValue: phase,
  });
  call.phase = phase;
  if (phase === "ended") {
    call.status = "completed";
    call.ended_at = nowIso();
  }
  publish("call.updated", { call: { ...call }, changed: ["phase"] });
}

// ------------------------------------------------------------------ scenario

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Speak one utterance as a run of deltas, then the durable final turn. */
async function speak(callId, role, text, { stepMs = stepDelayMs } = {}) {
  const call = state.calls.get(callId);
  const turns = state.turns.get(callId);
  const turnSeq = turns.length + 1;
  const words = text.split(" ");

  for (let index = 2; index < words.length; index += 2) {
    publish("transcript.delta", {
      call_id: callId,
      turn_seq: turnSeq,
      role,
      text: words.slice(0, index).join(" "),
      final: false,
    });
    await wait(stepMs);
  }

  const turn = {
    id: turns.length + 1 + callId * 1000,
    call_id: callId,
    turn_seq: turnSeq,
    role,
    text,
    created_at: nowIso(),
  };
  turns.push(turn);
  publish("transcript.turn", turn);
  void call;
  await wait(stepMs);
}

const SCENARIOS = [
  {
    location: "Elm St & 4th Ave",
    issue: "pothole",
    department: "public_works",
    caller: "Dana Whitfield",
    phone: "5105550142",
    description: "Deep pothole taking up most of the eastbound lane",
    lines: [
      ["agent", "Thanks for calling city services, what can I help you with today"],
      ["caller", "There is a huge pothole on Elm Street near Fourth Avenue"],
      ["agent", "Got it, can you tell me roughly how large it is"],
      ["caller", "It takes up most of the eastbound lane, a car ahead of me lost a hubcap"],
      ["agent", "That sounds like a hazard, I am filing it now under public works"],
      ["caller", "Thank you, my name is Dana Whitfield and my number is five one zero five five five zero one four two"],
      ["agent", "Filed as a high priority road hazard, a crew will be dispatched today"],
    ],
  },
  {
    location: "221 Baker Ln",
    issue: "missed_collection",
    department: "sanitation",
    caller: "Marcus Ito",
    phone: "5105550188",
    description: "Recycling was not collected on the scheduled Tuesday route",
    lines: [
      ["agent", "City services, how can I help"],
      ["caller", "Our recycling was not picked up again this week on Baker Lane"],
      ["agent", "Sorry about that, which day is your route normally"],
      ["caller", "Tuesdays, and this is the second week running"],
      ["agent", "I am logging this with sanitation now"],
    ],
  },
];

let scenarioIndex = 0;
let running = false;
/** Word-group cadence for interim deltas; raise it to watch a line stream. */
let stepDelayMs = 220;

async function runScenario() {
  if (running) return;
  running = true;
  try {
    const script = SCENARIOS[scenarioIndex % SCENARIOS.length];
    scenarioIndex += 1;

    // 1. The call exists before anything is known about it.
    const callId = state.nextCall++;
    const call = {
      id: callId,
      room: `intake-${String(callId).padStart(4, "0")}`,
      case_id: null,
      report_id: null,
      status: "active",
      phase: "greeting",
      caller_phone: null,
      summary: null,
      started_at: nowIso(),
      ended_at: null,
    };
    state.calls.set(callId, call);
    state.turns.set(callId, []);
    publish("call.started", { ...call });
    appendEvent("call.started", { callId });

    await speak(callId, script.lines[0][0], script.lines[0][1]);
    setPhase(callId, "gathering");
    await speak(callId, script.lines[1][0], script.lines[1][1]);

    // 2. The case opens with almost nothing filled in.
    const caseId = state.nextCase++;
    const item = {
      id: caseId,
      case_number: `C-2026-${String(1000 + caseId)}`,
      issue_type: null,
      issue_type_confidence: null,
      department: "unassigned",
      location: null,
      description: null,
      status: "new",
      priority: "normal",
      priority_score: 20,
      report_count: 1,
      escalated: false,
      escalation_reason: null,
      summary: null,
      notes: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.cases.set(caseId, item);
    call.case_id = caseId;

    const report = {
      id: state.nextReport++,
      case_id: caseId,
      call_id: callId,
      reporter_name: null,
      reporter_phone: null,
      description: null,
      created_at: nowIso(),
    };
    state.reports.set(report.id, report);
    call.report_id = report.id;

    publish("case.created", { ...item });
    appendEvent("case.created", { caseId, callId });
    publish("report.filed", { report: { ...report }, case: { ...item }, merged: false, similarity: 0 });
    publish("call.updated", { call: { ...call }, changed: ["case_id", "report_id"] });
    setPhase(callId, "filed");

    // 3. Fields arrive one at a time, the way the agent learns them.
    await speak(callId, script.lines[2][0], script.lines[2][1]);
    updateCase(caseId, { location: script.location });

    // A guess below the 0.6 gate: the dashboard shows "classifying", not empty.
    updateCase(caseId, { issue_type_confidence: 0.41 });
    await speak(callId, script.lines[3][0], script.lines[3][1]);

    // ... and then the confident classification, with the routing that follows.
    updateCase(caseId, { issue_type_confidence: 0.93, issue_type: script.issue });
    appendEvent("case.routed", {
      caseId,
      field: "department",
      oldValue: "unassigned",
      newValue: script.department,
    });
    updateCase(caseId, { department: script.department });
    updateCase(caseId, { description: script.description, priority_score: 58 });

    if (script.lines[4]) await speak(callId, script.lines[4][0], script.lines[4][1]);

    report.reporter_name = script.caller;
    report.reporter_phone = script.phone;
    publish("report.updated", {
      report: { ...report },
      case_id: caseId,
      changed: ["reporter_name", "reporter_phone"],
    });
    call.caller_phone = script.phone;
    publish("call.updated", { call: { ...call }, changed: ["caller_phone"] });

    if (script.lines[5]) await speak(callId, script.lines[5][0], script.lines[5][1]);

    // 4. Status and priority both move again before the call ends.
    updateCase(caseId, { status: "in_progress", priority: "high", priority_score: 81 });
    appendEvent("priority.changed", { caseId, field: "priority_score", oldValue: 58, newValue: 81 });

    if (script.issue === "pothole") {
      const escalated = state.cases.get(caseId);
      escalated.escalated = true;
      escalated.escalation_reason = "Road hazard reported in a travel lane";
      escalated.updated_at = nowIso();
      publish("case.escalated", { ...escalated });
      appendEvent("case.escalated", { caseId, newValue: escalated.escalation_reason });
    }

    setPhase(callId, "wrapping");
    if (script.lines[6]) await speak(callId, script.lines[6][0], script.lines[6][1]);

    updateCase(caseId, { summary: `${script.description}. Reported by ${script.caller}.` });
    call.summary = script.description;
    publish("call.updated", { call: { ...call }, changed: ["summary"] });
    setPhase(callId, "ended");
    appendEvent("call.ended", { caseId, callId });
  } finally {
    running = false;
  }
}

/** A second resident reporting the same incident: the merge path. */
function burst() {
  const latest = [...state.cases.values()].pop();
  if (!latest) return;
  const report = {
    id: state.nextReport++,
    case_id: latest.id,
    call_id: null,
    reporter_name: "Priya Raman",
    reporter_phone: "5105550117",
    description: "Same pothole, my rim was damaged this morning",
    created_at: nowIso(),
  };
  state.reports.set(report.id, report);
  latest.report_count += 1;
  latest.priority_score = Math.min(100, (latest.priority_score ?? 0) + 12);
  latest.updated_at = nowIso();
  publish("report.filed", { report: { ...report }, case: { ...latest }, merged: true, similarity: 0.86 });
  appendEvent("report.merged", { caseId: latest.id, newValue: "Merged into existing incident" });
}

// ---------------------------------------------------------------- HTTP + WS

function json(response, body, status = 200) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  });
  response.end(text);
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const path = url.pathname;

  if (request.method === "OPTIONS") return json(response, {});

  if (path === "/api/cases") return json(response, [...state.cases.values()]);
  if (path === "/api/calls") return json(response, [...state.calls.values()]);
  if (path === "/api/calls/active") {
    return json(response, [...state.calls.values()].filter((call) => call.status === "active"));
  }

  let match = /^\/api\/cases\/(\d+)(\/(reports|events|calls))?$/.exec(path);
  if (match) {
    const id = Number(match[1]);
    const item = state.cases.get(id);
    if (!item) return json(response, { detail: "not found" }, 404);
    if (match[3] === "reports") {
      return json(response, [...state.reports.values()].filter((row) => row.case_id === id));
    }
    if (match[3] === "events") return json(response, state.events.filter((row) => row.case_id === id));
    if (match[3] === "calls") return json(response, [...state.calls.values()].filter((row) => row.case_id === id));
    return json(response, item);
  }

  match = /^\/api\/calls\/(\d+)(\/turns)?$/.exec(path);
  if (match) {
    const id = Number(match[1]);
    const call = state.calls.get(id);
    if (!call) return json(response, { detail: "not found" }, 404);
    if (match[2]) {
      const turns = [...(state.turns.get(id) ?? [])].sort((a, b) => a.turn_seq - b.turn_seq);
      return json(response, turns);
    }
    return json(response, call);
  }

  if (path === "/fixture/scenario") {
    const step = Number(url.searchParams.get("step"));
    stepDelayMs = Number.isFinite(step) && step > 0 ? step : 220;
    void runScenario();
    return json(response, { started: true, step: stepDelayMs });
  }
  if (path === "/fixture/burst") {
    burst();
    return json(response, { merged: true });
  }
  if (path === "/fixture/drop") {
    // Kill every socket without losing the outbox: the client must come back
    // with `?since=` and be served a replay, not a resync.
    const dropped = clients.size;
    for (const socket of clients) socket.destroy();
    clients.clear();
    return json(response, { dropped });
  }
  if (path === "/fixture/resync") {
    for (const socket of clients) control(socket, "resync_required", { reason: "slow_consumer" });
    return json(response, { sent: clients.size });
  }

  return json(response, { detail: "not found" }, 404);
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (!key) return socket.destroy();

  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  clients.add(socket);

  const url = new URL(request.url, "http://localhost");
  const rawSince = url.searchParams.get("since");
  const since = rawSince === null ? null : Number(rawSince);
  const oldest = outbox.length > 0 ? outbox[0].seq : seq + 1;

  const canResume =
    since !== null && Number.isInteger(since) && since >= 0 && since <= seq && (since >= oldest - 1 || outbox.length === 0);

  if (canResume) {
    const replay = outbox.filter((frame) => frame.seq > since);
    control(socket, "hello", {
      latest_seq: seq,
      resume: true,
      from: replay.length > 0 ? replay[0].seq : since + 1,
      to: seq,
    });
    for (const frame of replay) socket.write(encodeFrame(JSON.stringify(frame)));
  } else {
    control(socket, "hello", { latest_seq: seq, resume: false });
  }

  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const { messages, rest } = decodeFrames(buffered);
    buffered = rest;
    for (const message of messages) {
      if (message.close) {
        clients.delete(socket);
        socket.destroy();
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(message.text);
      } catch {
        continue; // any other client text is ignored, never an error
      }
      if (parsed?.type === "ping") control(socket, "pong", {});
    }
  });

  const drop = () => clients.delete(socket);
  socket.on("close", drop);
  socket.on("error", drop);
});

server.listen(PORT, () => {
  console.log(`fixture listening on http://localhost:${PORT}`);
  console.log("  GET /fixture/scenario  run one call   GET /fixture/burst  merge a report");
  console.log("  GET /fixture/resync    force a resync");
});

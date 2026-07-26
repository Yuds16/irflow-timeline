// Regression tests for raw-EVTX TerminalServices ingest.
//
// The TerminalServices parse branch was written against EvtxECmd, which packs the
// session fields into PayloadData1/2/3. On a raw .evtx import those columns do not
// exist, so the "Source Network Address:" regex never matched and sourceHost stayed
// empty — and because EIDs 21/22/25/1149 are not in SESSION_ONLY_EVENTS, every one
// of them hit the `continue` guard. A raw TerminalServices-LocalSessionManager or
// RemoteConnectionManager log therefore produced zero RDP sessions, zero edges and
// zero findings.
//
// Raw EVTX carries those values in the UserData/EventXML leaves instead:
//   LocalSessionManager 21/22/24/25 -> User, SessionID, Address
//   RemoteConnectionManager 1149    -> Param1 (user), Param2 (domain), Param3 (source)

const test = require("node:test");
const assert = require("node:assert/strict");
const { getLateralMovement } = require("../electron/analyzers/lateral-movement");

// Raw-EVTX shape: `datetime` + `Provider` triggers isRawEvtx; `SessionID`/`Param1`
// additionally trigger isTermSvcEvtx. Deliberately no IpAddress/TargetUserName —
// a real TerminalServices channel has neither, which is the whole point.
const LSM_HEADERS = [
  "datetime", "RecordId", "EventID", "Provider", "Level", "Channel", "Computer", "Message",
  "User", "SessionID", "Address",
];

const RCM_HEADERS = [
  "datetime", "RecordId", "EventID", "Provider", "Level", "Channel", "Computer", "Message",
  "Param1", "Param2", "Param3",
];

// A tab holding both channels: the header union has Address *and* Param3. `detect()`
// returns the first match, so a single mapped source column can only ever serve one
// of the two record shapes — which is why the fix needs dedicated raw columns.
const MIXED_HEADERS = [
  "datetime", "RecordId", "EventID", "Provider", "Level", "Channel", "Computer", "Message",
  "User", "SessionID", "Address", "Param1", "Param2", "Param3",
];

const LSM_CHANNEL = "Microsoft-Windows-TerminalServices-LocalSessionManager/Operational";
const RCM_CHANNEL = "Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational";

function makeStub(headers, rows) {
  const colMap = {};
  headers.forEach((h, i) => { colMap[h] = `c${i}`; });

  const rowsByCN = rows.map((r, i) => {
    const out = { _rowid: i + 1 };
    headers.forEach((h) => { out[colMap[h]] = r[h] != null ? String(r[h]) : null; });
    return out;
  });

  function aliasRows(sql) {
    const aliasMatches = [...sql.matchAll(/c(\d+)\s+as\s+\[([a-zA-Z0-9_]+)\]/g)];
    return rowsByCN.map((r) => {
      const out = { _rowid: r._rowid };
      for (const [, idx, alias] of aliasMatches) out[alias] = r[`c${idx}`];
      return out;
    });
  }

  const db = {
    prepare(sql) {
      return {
        get() { if (/COUNT\(\*\)/i.test(sql)) return { cnt: rowsByCN.length || 1 }; return null; },
        all() {
          if (/^SELECT\s/i.test(sql) && /FROM\s+data/i.test(sql) && /\bas\s+\[/.test(sql)) return aliasRows(sql);
          return [];
        },
      };
    },
  };

  const meta = { db, headers, colMap, tabId: "lm-raw-termsvc-test" };
  const ctx = {
    applyStandardFilters() {},
    ensureIndex() {},
    isChainsawLogonDataset: () => false,
    isHayabusaDataset: () => false,
  };
  return { meta, ctx };
}

function lsmRow(eid, opts = {}) {
  return {
    datetime: opts.ts || "2026-03-10 08:00:00.000",
    RecordId: opts.recordId || "1",
    EventID: eid,
    Provider: "Microsoft-Windows-TerminalServices-LocalSessionManager",
    Level: "Information",
    Channel: LSM_CHANNEL,
    Computer: opts.computer || "WKS-TARGET",
    Message: opts.message || "",
    User: opts.user != null ? opts.user : "SEVENKINGDOMS\\cersei.lannister",
    SessionID: opts.sessionId || "3",
    Address: opts.address != null ? opts.address : "10.10.10.55",
  };
}

function rcmRow(eid, opts = {}) {
  return {
    datetime: opts.ts || "2026-03-10 08:00:00.000",
    RecordId: opts.recordId || "1",
    EventID: eid,
    Provider: "Microsoft-Windows-TerminalServices-RemoteConnectionManager",
    Level: "Information",
    Channel: RCM_CHANNEL,
    Computer: opts.computer || "WKS-TARGET",
    Message: opts.message || "",
    Param1: opts.user != null ? opts.user : "cersei.lannister",
    Param2: opts.domain || "SEVENKINGDOMS",
    Param3: opts.address != null ? opts.address : "10.10.10.55",
  };
}

// The analyzer's own default event list already covers the TerminalServices IDs, so
// these runs exercise the same set the fixed UI will send.
function run(headers, rows, options = {}) {
  const { meta, ctx } = makeStub(headers, rows);
  return getLateralMovement(meta, { excludeLocalLogons: true, excludeServiceAccounts: true, ...options }, ctx);
}

test("raw LocalSessionManager 21/22 builds an RDP session with the Address source", () => {
  const res = run(LSM_HEADERS, [
    lsmRow("21", { ts: "2026-03-10 08:00:00.000" }),
    lsmRow("22", { ts: "2026-03-10 08:00:02.000" }),
    lsmRow("24", { ts: "2026-03-10 08:45:00.000" }),
  ]);

  assert.ok(!res.error, `analyzer returned an error: ${res.error}`);
  assert.ok(res.rdpSessions.length >= 1, `expected at least one RDP session, got ${res.rdpSessions.length}`);

  const s = res.rdpSessions[0];
  assert.equal(s.source, "10.10.10.55");
  assert.equal(s.target, "WKS-TARGET");
  assert.match(s.user, /cersei\.lannister/i);

  // The session must also produce a graph edge — that is what puts it on the map.
  const edge = res.edges.find((e) => e.source === "10.10.10.55" && e.target === "WKS-TARGET");
  assert.ok(edge, `expected a 10.10.10.55 -> WKS-TARGET edge, got ${JSON.stringify(res.edges.map((e) => `${e.source}->${e.target}`))}`);
});

test("raw RemoteConnectionManager 1149 resolves user and source from Param1/Param3", () => {
  const res = run(RCM_HEADERS, [rcmRow("1149")]);

  assert.ok(!res.error, `analyzer returned an error: ${res.error}`);
  const edge = res.edges.find((e) => e.source === "10.10.10.55" && e.target === "WKS-TARGET");
  assert.ok(edge, `expected a 1149 edge, got ${JSON.stringify(res.edges.map((e) => `${e.source}->${e.target}`))}`);
  assert.ok(
    edge.users.some((u) => /cersei\.lannister/i.test(u)),
    `expected cersei.lannister on the edge, got ${JSON.stringify(edge.users)}`,
  );
});

test("a tab holding both channels resolves each record shape independently", () => {
  const res = run(MIXED_HEADERS, [
    // RCM announces the connection, then LSM logs the session. Different leaf names,
    // same tab — both must resolve even though detect() can only map one source column.
    { ...rcmRow("1149", { ts: "2026-03-10 09:00:00.000", address: "10.10.10.77" }), User: null, SessionID: null, Address: null },
    { ...lsmRow("21", { ts: "2026-03-10 09:00:01.000", address: "10.10.10.77", sessionId: "5" }), Param1: null, Param2: null, Param3: null },
    { ...lsmRow("22", { ts: "2026-03-10 09:00:03.000", address: "10.10.10.77", sessionId: "5" }), Param1: null, Param2: null, Param3: null },
  ]);

  assert.ok(!res.error, `analyzer returned an error: ${res.error}`);
  const edge = res.edges.find((e) => e.source === "10.10.10.77" && e.target === "WKS-TARGET");
  assert.ok(edge, `expected a 10.10.10.77 edge from the mixed tab, got ${JSON.stringify(res.edges.map((e) => `${e.source}->${e.target}`))}`);
  assert.ok(res.rdpSessions.length >= 1, "expected the LSM pair to still form a session in a mixed tab");
});

test("LOCAL and empty source addresses are still rejected", () => {
  const res = run(LSM_HEADERS, [
    lsmRow("21", { ts: "2026-03-10 10:00:00.000", address: "LOCAL" }),
    lsmRow("22", { ts: "2026-03-10 10:00:01.000", address: "" }),
  ]);

  assert.ok(!res.error, `analyzer returned an error: ${res.error}`);
  assert.equal(
    res.edges.filter((e) => e.target === "WKS-TARGET").length, 0,
    "console/local sessions must not create lateral edges",
  );
});

// Raw EVTX names the Kerberos failure code `Status`; only `SubStatus` was consulted,
// so ssTotal stayed 0 and the brute-force severity was permanently capped at medium.
test("raw-EVTX 4771 reads its failure code from Status, lifting brute force above medium", () => {
  const HEADERS = [
    "datetime", "RecordId", "EventID", "Provider", "Level", "Channel", "Computer", "Message",
    "IpAddress", "TargetUserName", "LogonType", "Status", "SessionID",
  ];
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push({
      datetime: `2026-03-10 13:0${i}:00.000`,
      RecordId: String(i + 1),
      EventID: "4771",
      Provider: "Microsoft-Windows-Security-Auditing",
      Level: "Information",
      Channel: "Security",
      Computer: "DC01",
      Message: "",
      IpAddress: "10.10.10.55",
      TargetUserName: "SEVENKINGDOMS\\jaime.lannister",
      LogonType: "3",
      Status: "0x18", // bad password — real guessing, not lockout/expiry noise
      SessionID: "",
    });
  }
  const { meta, ctx } = makeStub(HEADERS, rows);
  const res = getLateralMovement(meta, { excludeLocalLogons: true, excludeServiceAccounts: true }, ctx);

  assert.ok(!res.error, `analyzer returned an error: ${res.error}`);
  const bf = res.findings.find((f) => /brute force/i.test(f.category) || /brute force/i.test(f.title));
  assert.ok(bf, `expected a Brute Force finding, got ${JSON.stringify(res.findings.map((f) => f.category))}`);
  assert.equal(bf.severity, "high", "0x18 (bad password) bursts should not be dampened to medium");
});

test("raw session IDs are recovered so distinct sessions do not collapse", () => {
  const res = run(LSM_HEADERS, [
    lsmRow("21", { ts: "2026-03-10 11:00:00.000", sessionId: "3", address: "10.10.10.55" }),
    lsmRow("23", { ts: "2026-03-10 11:10:00.000", sessionId: "3", address: "10.10.10.55" }),
    lsmRow("21", { ts: "2026-03-10 12:00:00.000", sessionId: "9", address: "10.10.10.55" }),
    lsmRow("23", { ts: "2026-03-10 12:10:00.000", sessionId: "9", address: "10.10.10.55" }),
  ]);

  assert.ok(!res.error, `analyzer returned an error: ${res.error}`);
  assert.ok(
    res.rdpSessions.length >= 2,
    `two distinct session IDs should yield two sessions, got ${res.rdpSessions.length}`,
  );
});

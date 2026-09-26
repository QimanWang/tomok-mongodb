import test from "node:test";
import assert from "node:assert/strict";
import { buildSchedulePath, SCHEDULE_PATH_LIMITS } from "../apps/web/lib/tomok/schedule-path.ts";
import { buildProjectImport } from "../apps/web/lib/tomok/import-data.ts";

const scope = { projectId: "bp-tunnel", importVersion: "test-v1", sourceId: "schedule", snapshotId: "snapshot" };
function activity(id, overrides = {}) {
  return {
    ...scope, _id: `activity-${id}`, id, code: id, name: `Activity ${id}`, p6ProjectId: "p6",
    calendarId: "calendar-1", calendar: "Five day", status: "Not Started", type: "Task",
    floatHours: 16, originalHours: 40, remainingHours: 40, percent: 0, percentType: "Duration",
    longestPath: false, dates: { target_start_date: "2026-04-27 07:00", target_end_date: "2026-04-30 17:00" },
    constraints: ["Start On or After: 2026-04-27"], wbsId: "wbs", sourceLine: 20,
    raw: { canary: "private raw activity" }, href: "https://untrusted.invalid/ignored", ...overrides,
  };
}
function relationship(id, predecessor, successor, overrides = {}) {
  return {
    ...scope, _id: `edge-${id}`, id, predecessor, successor, type: "FS", lagHours: 0,
    sourceLine: 100, raw: { canary: "private raw relationship" }, ...overrides,
  };
}
function input(activities, relationships, overrides = {}) {
  return {
    activity: activities[0], target: activities.at(-1), activities, relationships,
    snapshot: {
      ...scope, _id: "snapshot", projects: [{ id: "p6", name: "Imported baseline", dataDate: "2026-04-27 07:00", baselineId: "" }],
      exportDate: "2026-07-06", calendarCount: 1, warnings: [], approvalStatus: "unconfirmed",
      counts: { activities: activities.length, relationships: relationships.length, wbs: 1, calendars: 1 },
      rawHeader: "private raw header", rawProjects: [], rawOtherTables: {}, rawTableCounts: {},
    },
    ...overrides,
  };
}

test("dependency path preserves typed links and schedule basis without raw data or inferred delay", () => {
  const activities = [activity("A"), activity("B"), activity("MS-260")];
  const relationships = [relationship("ab", "A", "B"), relationship("bt", "B", "MS-260", { type: "FF", lagHours: -8, sourceLine: 105 })];
  const result = buildSchedulePath(input(activities, relationships));
  assert.equal(result.status, "found");
  assert.deepEqual(result.nodes.map((node) => node.code), ["A", "B", "MS-260"]);
  assert.deepEqual(result.relationships.map((edge) => [edge.type, edge.lagHours]), [["FS", 0], ["FF", -8]]);
  assert.equal(result.target.calendarId, "calendar-1");
  assert.equal(result.target.calendar, "Five day");
  assert.deepEqual(result.target.constraints, activities[2].constraints);
  assert.equal(result.target.floatHours, 16);
  assert.equal(result.basis.dataDate, "2026-04-27 07:00");
  assert.equal(result.basis.exportDate, "2026-07-06");
  assert.match(result.relationships[1].citation.label, /FF.*XER line 105/);
  const url = new URL(result.relationships[1].citation.href, "https://tomok.invalid");
  assert.equal(url.pathname, "/files");
  assert.equal(url.searchParams.get("file"), "schedule");
  assert.equal(url.searchParams.get("activity"), "MS-260");
  assert.equal(result.coverage.truncated, false);
  assert.match(result.limitations.join(" "), /not a driving or critical path.*does not calculate milestone delay/);
  assert.match(result.limitations.join(" "), /does not establish an accepted project milestone/);
  assert.doesNotMatch(JSON.stringify(result), /private raw|untrusted\.invalid|rawHeader|rawOtherTables/);
});

test("cycles are safe and shuffled equal-length alternatives select the same deterministic shortest path", () => {
  const activities = [activity("A"), activity("B"), activity("C"), activity("D"), activity("MS-260")];
  const relationships = [
    relationship("ac", "A", "C"), relationship("ct", "C", "MS-260"),
    relationship("ab", "A", "B"), relationship("bt", "B", "MS-260"),
    relationship("ba", "B", "A"), relationship("cd", "C", "D"), relationship("dt", "D", "MS-260"),
    relationship("aa", "A", "A"),
  ];
  const base = input(activities, relationships);
  const first = buildSchedulePath(base);
  const reordered = buildSchedulePath({ ...base, activities: [...activities].reverse(), relationships: [...relationships].reverse() });
  assert.deepEqual(first, reordered);
  assert.deepEqual(first.nodes.map((node) => node.id), ["A", "B", "MS-260"]);
  assert.equal(first.relationships.length, 2);
});

test("directed unreachable target is distinct from incomplete traversal and zero-edge reachability", () => {
  const activities = [activity("A"), activity("MS-260")];
  const base = input(activities, [relationship("backwards", "MS-260", "A")]);
  const result = buildSchedulePath(base);
  assert.equal(result.status, "not-found");
  assert.deepEqual(result.nodes, []);
  assert.match(result.limitations.join(" "), /No directed successor path.*does not establish independence/);
  const same = buildSchedulePath({ ...base, target: activities[0] });
  assert.equal(same.status, "found");
  assert.deepEqual(same.nodes.map((node) => node.id), ["A"]);
  assert.deepEqual(same.relationships, []);
});

test("other projects, sources, snapshots, and imports cannot supply a path or expose their data", () => {
  const activities = [activity("A"), activity("MS-260")];
  const base = input(activities, []);
  const foreign = [
    { projectId: "other-project" }, { sourceId: "other-source" },
    { snapshotId: "other-snapshot" }, { importVersion: "other-import" },
  ];
  const result = buildSchedulePath({
    ...base,
    activities: [...activities, ...foreign.map((override, index) => activity(`foreign-${index}`, { ...override, name: "forbidden canary" }))],
    relationships: foreign.map((override, index) => relationship(`foreign-edge-${index}`, "A", "MS-260", override)),
  });
  assert.equal(result.status, "not-found");
  assert.equal(result.coverage.excludedScopeNodes, 4);
  assert.equal(result.coverage.excludedScopeRelationships, 4);
  assert.doesNotMatch(JSON.stringify(result), /forbidden canary|foreign-/);
  for (const override of foreign) {
    assert.throws(() => buildSchedulePath({ ...base, target: { ...base.target, ...override } }), /matching imported schedule snapshot/);
  }
});

test("missing endpoints and incomplete record sets disclose uncertainty instead of disconnection", () => {
  const activities = [activity("A"), activity("MS-260")];
  const base = input(activities, [relationship("missing", "A", "MISSING")]);
  const missing = buildSchedulePath(base);
  assert.equal(missing.status, "truncated");
  assert.equal(missing.coverage.missingEndpointRelationships, 1);
  assert.match(missing.limitations.join(" "), /absence of a path does not establish.*disconnected/);
  const incomplete = buildSchedulePath({ ...base, relationships: [], snapshot: { ...base.snapshot, counts: { ...base.snapshot.counts, activities: 3, relationships: 2 } } });
  assert.equal(incomplete.status, "truncated");
  assert.equal(incomplete.coverage.missingActivityCount, 1);
  assert.equal(incomplete.coverage.missingRelationshipCount, 2);
});

test("node and relationship bounds remain deterministic and mark any omitted graph as incomplete", () => {
  const activities = Array.from({ length: SCHEDULE_PATH_LIMITS.maxNodes + 1 }, (_, index) => activity(String(index).padStart(5, "0")));
  const relationships = activities.slice(1).map((item, index) => relationship(`edge-${index}`, activities[index].id, item.id));
  const base = input(activities, relationships);
  const limited = buildSchedulePath(base);
  assert.equal(limited.status, "truncated");
  assert.equal(limited.coverage.inspectedNodes, SCHEDULE_PATH_LIMITS.maxNodes);
  assert.equal(limited.coverage.truncated, true);
  assert.deepEqual(limited, buildSchedulePath({ ...base, activities: [...activities].reverse(), relationships: [...relationships].reverse() }));

  const edgeActivities = [activity("A"), activity("B"), activity("MS-260")];
  const manyEdges = Array.from({ length: SCHEDULE_PATH_LIMITS.maxRelationships }, (_, index) => relationship(`parallel-${index}`, "A", "B"));
  manyEdges.push(relationship("last", "B", "MS-260"));
  const edgeLimited = buildSchedulePath(input(edgeActivities, manyEdges));
  assert.equal(edgeLimited.status, "truncated");
  assert.equal(edgeLimited.coverage.inspectedRelationships, SCHEDULE_PATH_LIMITS.maxRelationships);
});

test("a found path still discloses incomplete coverage and returned arrays do not mutate source data", () => {
  const activities = [activity("A"), activity("MS-260")];
  const base = input(activities, [relationship("target", "A", "MS-260"), relationship("missing", "A", "MISSING")]);
  const result = buildSchedulePath(base);
  assert.equal(result.status, "found");
  assert.equal(result.coverage.truncated, true);
  result.nodes[0].constraints.push("test mutation");
  result.nodes[0].dates.target_start_date = "changed";
  assert.equal(activities[0].constraints.length, 1);
  assert.equal(activities[0].dates.target_start_date, "2026-04-27 07:00");
});

test("imported South Portal candidates retain exact path lengths and XER relationship citations", async () => {
  const imported = await buildProjectImport();
  const source = imported.activities.find((item) => item.code === "2A-SP01-GRND-710C-XP");
  assert.ok(source);
  for (const [code, length] of [["MS-260", 14], ["MS-280", 17]]) {
    const target = imported.activities.find((item) => item.code === code);
    assert.ok(target);
    const result = buildSchedulePath({ ...imported, activity: source, target });
    assert.equal(result.status, "found");
    assert.equal(result.relationships.length, length);
    assert.equal(result.coverage.truncated, false);
    assert.equal(result.nodes.at(-1).id, target.id);
    for (const edge of result.relationships) {
      const original = imported.relationships.find((item) => item.id === edge.id);
      assert.ok(original);
      assert.equal(edge.type, original.type);
      assert.equal(edge.lagHours, original.lagHours);
      assert.equal(edge.sourceLine, original.sourceLine);
      assert.equal(new URL(edge.citation.href, "https://tomok.invalid").searchParams.get("activity"), edge.successor);
    }
  }
});

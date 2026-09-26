import type { EveMessagePart } from "eve/react";

const localOrigin = "https://tomok.invalid";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function canonicalProjectHref(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return;
  try {
    const url = new URL(value, localOrigin);
    const path = `${url.pathname}${url.search}`;
    if (url.origin !== localOrigin || value !== path) return;
    if (url.pathname === "/files" && url.search) return value;
    if (/^\/investigations\/[a-f0-9]{32}$/.test(url.pathname)) return value;
    if (/^\/memory\/[a-f0-9]{32}$/.test(url.pathname)) return value;
  } catch {
    /* Malformed links cannot establish a citation target. */
  }
}

/** Read only the authored link fields of completed Tomok tools, never source text or raw cells. */
export function collectTomokProjectLinks(
  parts: readonly EveMessagePart[],
): ReadonlySet<string> {
  const hrefs = new Set<string>();
  const add = (value: unknown) => {
    const href = canonicalProjectHref(value);
    if (href) hrefs.add(href);
  };
  const addMemorySummary = (value: unknown) => {
    const summary = record(value);
    add(summary?.href);
    for (const citation of items(summary?.citations))
      add(record(citation)?.href);
  };
  const addMilestoneContext = (value: unknown) => {
    const context = record(value);
    add(record(context?.source)?.href);
    add(record(context?.target)?.href);
    for (const node of items(context?.nodes)) add(record(node)?.href);
    for (const relationship of items(context?.relationships))
      add(record(record(relationship)?.citation)?.href);
  };
  for (const part of parts) {
    if (
      part.type !== "dynamic-tool" ||
      part.state !== "output-available" ||
      part.partial
    )
      continue;
    const kind = part.toolMetadata?.eve?.kind;
    if (kind && kind !== "tool-call" && kind !== "unknown") continue;
    const metadataName = part.toolMetadata?.eve?.name;
    const name =
      metadataName && metadataName !== "unknown" ? metadataName : part.toolName;
    const output = record(part.output);
    if (!output || output.error) continue;
    if (name === "get_replay_context") {
      const investigation = record(output.investigation);
      if (typeof investigation?.id !== "string" || !/^[a-f0-9]{32}$/.test(investigation.id)) continue;
      const base = `/replays/${investigation.id}`;
      if (output.href === base) hrefs.add(base);
      const replay = record(investigation.replay);
      // Only exact targets represented by frozen exhibits/notes establish links.
      // Citations and source cell text cannot invent another stage or anchor.
      for (const value of items(replay?.exhibits)) {
        const exhibit = record(value);
        if (typeof exhibit?.id !== "string" || !/^(?:schedule|[a-f0-9]{16})$/.test(exhibit.id)) continue;
        const href = `${base}#exhibit-${exhibit.id}`;
        if (exhibit.href === href) hrefs.add(href);
      }
      for (const value of items(investigation.reviewedMemory)) {
        const memory = record(value);
        if (typeof memory?.id !== "string" || !/^[a-f0-9]{32}$/.test(memory.id)) continue;
        const href = `${base}#memory-${memory.id}`;
        if (memory.href === href) hrefs.add(href);
      }
    } else if (name === "investigate_jet_grouting") {
      const investigation = record(output.investigation);
      if (!investigation || typeof investigation.id !== "string") continue;
      add(output.href);
      for (const finding of items(investigation.findings)) {
        for (const citation of items(record(finding)?.citations))
          add(record(citation)?.href);
      }
      for (const memory of items(investigation.reviewedMemory))
        addMemorySummary(memory);
      add(record(investigation.selectedSource)?.href);
      addMilestoneContext(investigation.milestoneContext);
    } else if (name === "get_project_memory") {
      for (const memory of items(output.memories)) addMemorySummary(memory);
    } else if (name === "propose_project_memory") {
      add(output.href);
    } else if (name === "get_project_evidence") {
      for (const evidence of items(output.evidence))
        add(record(evidence)?.href);
      for (const memory of items(output.reviewedMemory)) addMemorySummary(memory);
    } else if (name === "get_schedule_context") {
      add(record(output.activity)?.href);
      for (const activity of items(output.neighbors))
        add(record(activity)?.href);
      addMilestoneContext(output.milestoneContext);
    }
  }
  return hrefs;
}

/** Repair an invented host only when its path, query, and fragment identify an actual tool-returned link. */
export function resolveProjectHref(
  href: string | undefined,
  authoritative: ReadonlySet<string>,
): string | undefined {
  if (!href || !/^(?:https?:)?\/\//i.test(href)) return href;
  try {
    const url = new URL(href, localOrigin);
    const path = `${url.pathname}${url.search}${url.hash}`;
    return authoritative.has(path) ? path : href;
  } catch {
    return href;
  }
}

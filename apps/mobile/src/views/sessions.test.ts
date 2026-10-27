import { describe, expect, it } from "vitest";
import { groupSessions, type SessionSummary } from "./sessions";

const NOW = new Date("2026-10-28T10:00:00+08:00").getTime();
const at = (iso: string): SessionSummary => ({ id: iso, title: iso, updatedAt: iso });

describe("session buckets", () => {
  it("puts each session in the bucket the desktop would", () => {
    const groups = groupSessions(
      [
        at("2026-10-28T09:00:00+08:00"),
        at("2026-10-27T23:00:00+08:00"),
        at("2026-10-24T12:00:00+08:00"),
        at("2026-10-01T12:00:00+08:00"),
      ],
      NOW,
    );

    expect(groups.map((group) => group.labelKey)).toEqual([
      "sessions.today",
      "sessions.yesterday",
      "sessions.week",
      "sessions.earlier",
    ]);
    expect(groups[1]?.items).toHaveLength(1);
  });

  it("drops empty buckets instead of drawing an empty heading", () => {
    const groups = groupSessions([at("2026-10-28T09:00:00+08:00")], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.labelKey).toBe("sessions.today");
  });

  it("keeps an undated session visible rather than hiding it", () => {
    const groups = groupSessions([{ id: "x", title: "no date" }], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.labelKey).toBe("sessions.earlier");
  });
});

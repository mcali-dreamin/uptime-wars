// Control groups: the player's own bookmarks, never part of the simulation.
// Ctrl (or Alt) + 1..9 saves the current selection; 1..9 brings it back,
// dropping anything that died since; the same number twice in a row centres
// the camera on it. Ctrl+1..8 is the browser's tab switch on Windows and
// Linux, which a page can't override, so Alt works too.

import type { Selection } from "./selection";

/** Within this many ms, pressing a group's number again centres on it. */
const DOUBLE_TAP_MS = 350;

export class ControlGroups {
  private readonly groups = new Map<number, Selection>();
  private lastRecall: { group: number; at: number } | null = null;

  reset(): void {
    this.groups.clear();
    this.lastRecall = null;
  }

  /** Save `selection` as group n. Only things that can be groups are kept. */
  assign(n: number, selection: Selection): boolean {
    if ((selection.kind === "army" || selection.kind === "spawners") && selection.ids.length > 0) {
      this.groups.set(n, { kind: selection.kind, ids: [...selection.ids] });
      return true;
    }
    if (selection.kind === "entity") {
      this.groups.set(n, { kind: "entity", id: selection.id });
      return true;
    }
    return false;
  }

  has(n: number): boolean {
    return this.groups.has(n);
  }

  /**
   * Group n with anything gone dropped (`alive` says what's still there), and
   * whether this press is the second of a double-tap. Null if the group is
   * empty or everything in it is gone (which also forgets it).
   */
  recall(n: number, alive: (id: number) => boolean, now: number): { selection: Selection; doubleTap: boolean } | null {
    const group = this.groups.get(n);
    if (!group) return null;
    let selection: Selection | null = null;
    if (group.kind === "army" || group.kind === "spawners") {
      const ids = group.ids.filter(alive);
      if (ids.length > 0) selection = group.kind === "spawners" && ids.length === 1 ? { kind: "entity", id: ids[0]! } : { kind: group.kind, ids };
    } else if (group.kind === "entity" && alive(group.id)) {
      selection = group;
    }
    if (!selection) {
      this.groups.delete(n);
      return null;
    }
    this.groups.set(n, selection);
    const doubleTap = this.lastRecall?.group === n && now - this.lastRecall.at <= DOUBLE_TAP_MS;
    this.lastRecall = { group: n, at: now };
    return { selection, doubleTap };
  }

  /** Which groups exist, for the HUD. */
  list(): number[] {
    return [...this.groups.keys()].sort((a, b) => a - b);
  }
}

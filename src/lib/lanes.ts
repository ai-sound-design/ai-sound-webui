/**
 * Track assignment of a hybrid run, as the Pro Tools plugin does it: the sounds
 * of a scene share at most `budget` tracks per kind (generated / database).
 * Every sound gets a lane of its own while the budget allows; pieces of the same
 * sound share its lane; once the budget is used up, a sound shares a lane with
 * others it does not overlap in time, preferring one of its own category.
 * Priority-0 items (the first layer) always get a lane; further layers are
 * dropped when no lane within the budget has room.
 */

export type LaneKind = 'gen' | 'db';

export interface LaneItem<T> {
  kind: LaneKind;
  label: string;
  category: string;
  start: number;
  end: number;
  /** 0 for a sound's first layer, the layer number for further library layers */
  priority: number;
  similarity: number;
  payload: T;
}

export interface Lane<T> {
  kind: LaneKind;
  index: number;
  labels: Set<string>;
  categories: Set<string>;
  items: LaneItem<T>[];
}

const EPS = 1e-3;

function free<T>(lane: Lane<T>, item: LaneItem<T>): boolean {
  return lane.items.every((o) => item.end <= o.start + EPS || item.start >= o.end - EPS);
}

export function assignLanes<T>(items: LaneItem<T>[], budget: number): Lane<T>[] {
  const order = { ambience: 0, foley: 1, sfx: 2, music: 3, dialogue: 4 } as Record<string, number>;
  const sorted = [...items].sort(
    (a, b) => a.priority - b.priority || b.similarity - a.similarity || (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.start - b.start,
  );
  const lanes: Lane<T>[] = [];
  const counts: Record<LaneKind, number> = { gen: 0, db: 0 };
  const dropped: LaneItem<T>[] = [];

  const newLane = (item: LaneItem<T>): Lane<T> => {
    const lane: Lane<T> = { kind: item.kind, index: ++counts[item.kind], labels: new Set([item.label]), categories: new Set([item.category]), items: [item] };
    lanes.push(lane);
    return lane;
  };

  for (const item of sorted) {
    const own = lanes.filter((l) => l.kind === item.kind);
    // Pieces of the same sound stay together
    const same = own.find((l) => l.labels.has(item.label) && free(l, item));
    if (same) {
      same.items.push(item);
      continue;
    }
    if (counts[item.kind] < budget) {
      newLane(item);
      continue;
    }
    const shared = own.filter((l) => free(l, item)).sort((a, b) => Number(b.categories.has(item.category)) - Number(a.categories.has(item.category)));
    if (shared.length) {
      shared[0].items.push(item);
      shared[0].labels.add(item.label);
      shared[0].categories.add(item.category);
    } else if (item.priority === 0) {
      newLane(item);
    } else {
      dropped.push(item);
    }
  }

  // Order: every gen lane followed by the db lane(s) that carry the same labels
  const gen = lanes.filter((l) => l.kind === 'gen');
  const db = lanes.filter((l) => l.kind === 'db');
  const out: Lane<T>[] = [];
  const used = new Set<Lane<T>>();
  for (const g of gen) {
    out.push(g);
    for (const d of db) {
      if (!used.has(d) && [...d.labels].some((x) => g.labels.has(x))) {
        out.push(d);
        used.add(d);
      }
    }
  }
  for (const d of db) if (!used.has(d)) out.push(d);
  return out;
}

// Pure helpers for Bricks Builder element trees.
//
// Bricks stores a page as a flat list. Each element names its parent (0 for a
// root element) and lists its children in order; root order is list order.

export interface BricksElement {
  id: string;
  name: string;
  parent: string | number;
  children: string[];
  settings: Record<string, unknown>;
  label?: string;
  [key: string]: unknown;
}

export interface ElementSpec {
  name: string;
  settings?: Record<string, unknown>;
  label?: string;
  children?: ElementSpec[];
}

export interface OutlineNode {
  id: string;
  name: string;
  label?: string;
  text?: string;
  classes?: string[];
  children?: OutlineNode[];
}

const isRoot = (el: BricksElement) => !el.parent || el.parent === "0";

/** PHP returns an empty settings map as [], and children may be missing. */
export function normalise(raw: unknown[]): BricksElement[] {
  return raw.map((item) => {
    const el = item as Partial<BricksElement>;
    return {
      ...el,
      id: String(el.id),
      name: String(el.name),
      parent: !el.parent || el.parent === "0" ? 0 : String(el.parent),
      children: Array.isArray(el.children) ? el.children.map(String) : [],
      settings: el.settings && !Array.isArray(el.settings) && typeof el.settings === "object" ? el.settings : {},
    } as BricksElement;
  });
}

function byId(elements: BricksElement[]): Map<string, BricksElement> {
  return new Map(elements.map((el) => [el.id, el]));
}

function need(map: Map<string, BricksElement>, id: string): BricksElement {
  const el = map.get(id);
  if (!el) throw new Error(`No element with id "${id}" on this page. Use bricks_get to see the current ids.`);
  return el;
}

/** Throws unless ids are unique and every parent/children link points both ways. */
export function validate(elements: BricksElement[]): void {
  const map = new Map<string, BricksElement>();
  for (const el of elements) {
    if (map.has(el.id)) throw new Error(`Duplicate element id "${el.id}".`);
    map.set(el.id, el);
  }
  for (const el of elements) {
    if (!isRoot(el)) {
      const parent = map.get(String(el.parent));
      if (!parent) throw new Error(`Element "${el.id}" has a parent "${el.parent}" that does not exist.`);
      if (!parent.children.includes(el.id)) throw new Error(`Element "${el.id}" is missing from the children of "${parent.id}".`);
    }
    for (const child of el.children) {
      if (String(map.get(child)?.parent) !== el.id) throw new Error(`Element "${el.id}" lists "${child}" as a child, but that element has a different parent.`);
    }
  }
}

function snippet(settings: Record<string, unknown>): string | undefined {
  for (const key of ["text", "title", "content", "label"]) {
    const value = settings[key];
    if (typeof value === "string" && value.trim()) {
      const plain = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
    }
  }
  return undefined;
}

function classesOf(settings: Record<string, unknown>, names: Record<string, string>): string[] | undefined {
  const out: string[] = [];
  const ids = settings._cssGlobalClasses;
  if (Array.isArray(ids)) out.push(...ids.map((id) => names[String(id)] ?? String(id)));
  if (typeof settings._cssClasses === "string" && settings._cssClasses.trim()) out.push(...settings._cssClasses.trim().split(/\s+/));
  return out.length ? out : undefined;
}

/** Compact nested view: structure, labels and a text snippet, without settings. */
export function outline(elements: BricksElement[], classNames: Record<string, string> = {}, rootId?: string): OutlineNode[] {
  const map = byId(elements);
  const build = (el: BricksElement): OutlineNode => {
    const node: OutlineNode = { id: el.id, name: el.name };
    if (el.label) node.label = el.label;
    const text = snippet(el.settings);
    if (text) node.text = text;
    const classes = classesOf(el.settings, classNames);
    if (classes) node.classes = classes;
    const children = el.children.map((id) => map.get(id)).filter((c): c is BricksElement => !!c);
    if (children.length) node.children = children.map(build);
    return node;
  };
  if (rootId) return [build(need(map, rootId))];
  return elements.filter(isRoot).map(build);
}

/** The element and everything nested under it, in document order. */
export function subtree(elements: BricksElement[], id: string): BricksElement[] {
  const map = byId(elements);
  const out: BricksElement[] = [];
  const walk = (el: BricksElement) => {
    out.push(el);
    for (const child of el.children) {
      const next = map.get(child);
      if (next) walk(next);
    }
  };
  walk(need(map, id));
  return out;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Bricks ids are six lowercase letters, unique within the page. */
export function newId(taken: Set<string>, random: () => number = Math.random): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < 6; i++) id += LETTERS[Math.floor(random() * LETTERS.length)];
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** Turns nested specs into flat elements with fresh ids, parents before children. */
export function flatten(specs: ElementSpec[], parent: string | number, taken: Set<string>): { flat: BricksElement[]; topIds: string[] } {
  const flat: BricksElement[] = [];
  const add = (spec: ElementSpec, parentId: string | number): string => {
    if (!spec.name) throw new Error("Every new element needs a name, e.g. section, container, heading, text-basic, button, image.");
    const el: BricksElement = { id: newId(taken), name: spec.name, parent: parentId, children: [], settings: spec.settings ?? {} };
    if (spec.label) el.label = spec.label;
    flat.push(el);
    for (const child of spec.children ?? []) el.children.push(add(child, el.id));
    return el.id;
  };
  const topIds = specs.map((spec) => add(spec, parent));
  return { flat, topIds };
}

function clampPosition(position: number | undefined, length: number): number {
  if (position === undefined || position > length) return length;
  return Math.max(0, position);
}

/** Places already-built elements under a parent (or at root) at a position among its children. */
function attach(elements: BricksElement[], added: BricksElement[], topIds: string[], parentId: string | undefined, position?: number): BricksElement[] {
  if (parentId) {
    const parent = need(byId(elements), parentId);
    parent.children.splice(clampPosition(position, parent.children.length), 0, ...topIds);
    return [...elements, ...added];
  }
  // Root order is list order, so the block goes in front of the root currently at that position.
  const roots = elements.filter(isRoot);
  const at = clampPosition(position, roots.length);
  if (at >= roots.length) return [...elements, ...added];
  const index = elements.indexOf(roots[at]);
  return [...elements.slice(0, index), ...added, ...elements.slice(index)];
}

export function addElements(elements: BricksElement[], specs: ElementSpec[], parentId?: string, position?: number) {
  const taken = new Set(elements.map((el) => el.id));
  if (parentId) need(byId(elements), parentId);
  const { flat, topIds } = flatten(specs, parentId ?? 0, taken);
  return { elements: attach(elements, flat, topIds, parentId, position), addedIds: flat.map((el) => el.id), topIds };
}

export function removeElement(elements: BricksElement[], id: string) {
  const map = byId(elements);
  const target = need(map, id);
  const gone = new Set(subtree(elements, id).map((el) => el.id));
  if (!isRoot(target)) {
    const parent = map.get(String(target.parent));
    if (parent) parent.children = parent.children.filter((child) => child !== id);
  }
  return { elements: elements.filter((el) => !gone.has(el.id)), removedIds: [...gone] };
}

export function moveElement(elements: BricksElement[], id: string, parentId?: string, position?: number): BricksElement[] {
  const moving = subtree(elements, id);
  const movingIds = new Set(moving.map((el) => el.id));
  if (parentId && movingIds.has(parentId)) throw new Error("An element cannot be moved inside itself or one of its own descendants.");
  const rest = removeElement(elements, id).elements;
  moving[0].parent = parentId ?? 0;
  return attach(rest, moving, [id], parentId, position);
}

export function updateElement(
  elements: BricksElement[],
  id: string,
  change: { settings?: Record<string, unknown>; label?: string; name?: string; replaceSettings?: boolean; removeSettings?: string[] },
): BricksElement {
  const el = need(byId(elements), id);
  if (change.settings) el.settings = change.replaceSettings ? change.settings : { ...el.settings, ...change.settings };
  for (const key of change.removeSettings ?? []) delete el.settings[key];
  if (change.label !== undefined) {
    if (change.label) el.label = change.label;
    else delete el.label;
  }
  if (change.name) el.name = change.name;
  return el;
}

import test from "node:test";
import assert from "node:assert/strict";
import { findMember, insertItem, insertMember, parseDoc, removeItem, removeMember, sameJson, styleOf } from "../src/jsonedit.mjs";

// A small seeded random generator, so a failure can be repeated.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["model", "env", "allow", "deny", "hooks", "permissions", "a b", "ü", "x\"y", "back\\slash", "tab\there", "Bash(npm test)", "", "0", "SessionStart"];

// A random JSON value.
function randomValue(r, depth = 0) {
  const k = Math.floor(r() * (depth > 3 ? 5 : 8));
  switch (k) {
    case 0: return null;
    case 1: return r() < 0.5;
    case 2: return Math.floor(r() * 1000) * (r() < 0.2 ? -1 : 1) + (r() < 0.2 ? 0.5 : 0);
    case 3: return WORDS[Math.floor(r() * WORDS.length)];
    case 4: return Math.floor(r() * 10) === 0 ? 1e21 : Math.floor(r() * 5);
    case 5: case 6: return Array.from({ length: Math.floor(r() * 5) }, () => randomValue(r, depth + 1));
    default: {
      const o = {};
      for (let i = Math.floor(r() * 5); i > 0; i--) o[WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.5 ? "" : String(i))] = randomValue(r, depth + 1);
      return o;
    }
  }
}

// The value as text with random spacing: some containers on one line, some spread out, random spaces around
// the punctuation, tabs or spaces for indentation, now and then a Windows line ending.
function format(value, r, style, level = 0) {
  const nl = style.crlf ? "\r\n" : "\n";
  const pad = (n) => style.unit.repeat(n);
  const sp = () => (r() < 0.5 ? " " : "");
  if (Array.isArray(value)) {
    if (!value.length) return r() < 0.8 ? "[]" : "[ ]";
    const inline = r() < 0.4;
    const parts = value.map((v) => format(v, r, style, level + 1));
    if (inline) return `[${sp()}${parts.join(`,${sp() || " "}`)}${sp()}]`;
    return `[${nl}${parts.map((p) => pad(level + 1) + p).join(`,${nl}`)}${nl}${pad(level)}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return r() < 0.8 ? "{}" : "{ }";
    const inline = r() < 0.4;
    const parts = keys.map((k) => `${JSON.stringify(k)}${sp()}:${sp() || " "}${format(value[k], r, style, level + 1)}`);
    if (inline) return `{${sp()}${parts.join(`,${sp() || " "}`)}${sp()}}`;
    return `{${nl}${parts.map((p) => pad(level + 1) + p).join(`,${nl}`)}${nl}${pad(level)}}`;
  }
  return JSON.stringify(value);
}

function randomDoc(seed) {
  const r = mulberry32(seed);
  const root = {};
  for (let i = 1 + Math.floor(r() * 4); i > 0; i--) root[WORDS[Math.floor(r() * WORDS.length)] + i] = randomValue(r, 1);
  const style = { crlf: r() < 0.2, unit: [" ", "  ", "    ", "\t"][Math.floor(r() * 4)] };
  const text = format(root, r, style) + (r() < 0.8 ? style.crlf ? "\r\n" : "\n" : "");
  return { text, value: root, r };
}

// Every container of the document with the path of keys and indexes that leads to it.
function containers(node, value, path = [], out = []) {
  if (node.type === "object") {
    out.push({ node, value, path });
    node.members.forEach((m) => containers(m.value, value[m.key], [...path, m.key], out));
  } else if (node.type === "array") {
    out.push({ node, value, path });
    node.items.forEach((n, i) => containers(n, value[i], [...path, i], out));
  }
  return out;
}
const at = (value, path) => path.reduce((v, k) => v[k], value);

test("nodes know where they start and end", () => {
  const text = '{ "a": [1, "two", {"b": null}], "c": true }';
  const doc = parseDoc(text);
  assert.ok(doc.ok);
  const [a, c] = doc.root.members;
  assert.equal(text.slice(doc.root.start, doc.root.end), text);
  assert.equal(text.slice(a.start, a.end), '"a": [1, "two", {"b": null}]');
  assert.equal(text.slice(a.value.start, a.value.end), '[1, "two", {"b": null}]');
  assert.deepEqual(a.value.items.map((n) => text.slice(n.start, n.end)), ["1", '"two"', '{"b": null}']);
  assert.equal(text.slice(c.value.start, c.value.end), "true");
  assert.equal(c.key, "c");
});

test("parseDoc accepts what JSON.parse accepts and rejects what it rejects", () => {
  const good = ["{}", "[]", "0", '"x"', "null", " [1, -2.5e+3, true, null, \"\\u00e9\\n\\\"\"] ", '{"a":{"b":[{}]}}', "\r\n{\r\n}\r\n", '{"a":1,"a":2}'];
  const bad = ["", "{", "[1,]", "{\"a\":1,}", "{'a':1}", "{a:1}", "01", "1.", ".5", "+1", "NaN", "Infinity", "[1 2]", '{"a" 1}', '"\\x"', '"\\u12G4"', '"tab\there"', "// c\n{}", "{} {}", "{}x", "[", '{"a":}', "tru", "[1,,2]"];
  for (const t of good) { assert.ok(parseDoc(t).ok, t); JSON.parse(t); }
  for (const t of bad) { assert.ok(!parseDoc(t).ok, JSON.stringify(t)); assert.throws(() => JSON.parse(t), undefined, t); }
  assert.ok(!parseDoc("[".repeat(300) + "]".repeat(300)).ok, "very deep nesting is refused, not a stack overflow");
});

test("500 random documents: parseDoc and JSON.parse agree, also after a random mutation", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const { text, r } = randomDoc(seed);
    assert.ok(parseDoc(text).ok, `seed ${seed}: ${text}`);
    const i = Math.floor(r() * text.length);
    const mutated = r() < 0.5 ? text.slice(0, i) + text.slice(i + 1) : text.slice(0, i) + ["{", "}", "[", "]", ",", ":", '"', "x", "1"][Math.floor(r() * 9)] + text.slice(i);
    let valid = true;
    try { const v = JSON.parse(mutated); valid = v !== undefined; } catch { valid = false; }
    const doc = parseDoc(mutated);
    assert.equal(doc.ok, valid && JSON.parse(mutated) !== undefined, `seed ${seed}: ${JSON.stringify(mutated)}`);
  }
});

test("styleOf reads the line ending and one level of indentation", () => {
  assert.deepEqual(styleOf('{\n  "a": 1\n}\n'), { eol: "\n", unit: "  " });
  assert.deepEqual(styleOf('{\r\n    "a": {\r\n        "b": 1\r\n    }\r\n}\r\n'), { eol: "\r\n", unit: "    " });
  assert.deepEqual(styleOf('{\n\t"a": {\n\t\t"b": 1\n\t}\n}'), { eol: "\n", unit: "\t" });
  assert.deepEqual(styleOf('{"a":1}'), { eol: "\n", unit: "  " }, "a one-line file gets the default");
  assert.deepEqual(styleOf("{}\n"), { eol: "\n", unit: "  " });
});

test("insertMember adds a member in the file's own style", () => {
  const doc = (t) => parseDoc(t).root;
  const t4 = '{\n    "model": "opus",\n    "env": { "A": "1" }\n}\n';
  assert.equal(insertMember(t4, doc(t4), "hooks", { x: [1] }), '{\n    "model": "opus",\n    "env": { "A": "1" },\n    "hooks": {\n        "x": [\n            1\n        ]\n    }\n}\n');
  const tab = '{\n\t"a": 1\n}';
  assert.equal(insertMember(tab, doc(tab), "b", [true]), '{\n\t"a": 1,\n\t"b": [\n\t\ttrue\n\t]\n}');
  const inline = '{ "a": 1, "b": [1, 2] }';
  assert.equal(insertMember(inline, doc(inline), "c", { d: 1 }), '{ "a": 1, "b": [1, 2], "c": {"d":1} }');
  const crlf = '{\r\n  "a": 1\r\n}\r\n';
  assert.equal(insertMember(crlf, doc(crlf), "b", 2), '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n');
  assert.equal(insertMember("{}", doc("{}"), "a", 1), '{\n  "a": 1\n}');
  assert.equal(insertMember("{}\n", doc("{}\n"), "a", { b: 1 }), '{\n  "a": {\n    "b": 1\n  }\n}\n');
  const nested = '{\n  "o": {}\n}\n';
  const inner = findMember(doc(nested), "o").member.value;
  assert.equal(insertMember(nested, inner, "k", 1), '{\n  "o": {\n    "k": 1\n  }\n}\n');
});

test("insertItem adds an item the same way, and removeItem / removeMember take it out again", () => {
  const doc = (t) => parseDoc(t).root;
  const t = '{\n  "list": [\n    "a",\n    "b"\n  ],\n  "short": ["x", "y"]\n}\n';
  const list = findMember(doc(t), "list").member.value;
  const short = findMember(doc(t), "short").member.value;
  assert.equal(insertItem(t, list, { n: 1 }), '{\n  "list": [\n    "a",\n    "b",\n    {\n      "n": 1\n    }\n  ],\n  "short": ["x", "y"]\n}\n');
  assert.equal(insertItem(t, short, 3), '{\n  "list": [\n    "a",\n    "b"\n  ],\n  "short": ["x", "y", 3]\n}\n');
  assert.equal(removeItem(t, list, 0), '{\n  "list": [\n    "b"\n  ],\n  "short": ["x", "y"]\n}\n');
  assert.equal(removeItem(t, list, 1), '{\n  "list": [\n    "a"\n  ],\n  "short": ["x", "y"]\n}\n');
  assert.equal(removeItem(t, short, 0), '{\n  "list": [\n    "a",\n    "b"\n  ],\n  "short": ["y"]\n}\n');
  assert.equal(removeMember(t, doc(t), 0), '{\n  "short": ["x", "y"]\n}\n');
  assert.equal(removeMember(t, doc(t), 1), '{\n  "list": [\n    "a",\n    "b"\n  ]\n}\n');
  const one = '{\n  "only": 1\n}\n';
  assert.equal(removeMember(one, doc(one), 0), "{}\n");
  assert.equal(removeItem("[\n  1\n]", doc("[\n  1\n]"), 0), "[]");
});

test("findMember returns the last of a repeated key, as JSON.parse reads it", () => {
  const doc = parseDoc('{"a":1,"b":2,"a":3}');
  const hit = findMember(doc.root, "a");
  assert.equal(hit.index, 2);
  assert.equal(findMember(doc.root, "zz"), null);
  assert.equal(findMember(parseDoc("[]").root, "a"), null);
});

test("300 random documents: inserting into a container and removing it again gives back the very same text", () => {
  let inserts = 0;
  for (let seed = 1000; seed < 1300; seed++) {
    const { text, value, r } = randomDoc(seed);
    const all = containers(parseDoc(text).root, value).filter((c) => (c.node.type === "object" ? c.node.members.length : c.node.items.length) > 0);
    const pick = all[Math.floor(r() * all.length)];
    if (!pick) continue;
    const extra = { hooks: [{ type: "command", args: ["a b", "--quiet"] }], n: 1 };
    const out = pick.node.type === "object" ? insertMember(text, pick.node, "zz-added", extra) : insertItem(text, pick.node, extra);
    inserts++;
    // it is valid JSON, and is the original plus the new child, nothing else
    const expected = structuredClone(value);
    const target = at(expected, pick.path);
    if (Array.isArray(target)) target.push(extra); else target["zz-added"] = extra;
    assert.ok(sameJson(JSON.parse(out), expected), `seed ${seed}: ${out}`);
    // and taking the child out restores the text byte for byte
    const doc = parseDoc(out);
    const again = containers(doc.root, JSON.parse(out)).find((c) => c.path.join("/") === pick.path.join("/") && c.node.type === pick.node.type);
    const back = pick.node.type === "object" ? removeMember(out, again.node, again.node.members.length - 1) : removeItem(out, again.node, again.node.items.length - 1);
    assert.equal(back, text, `seed ${seed}`);
  }
  assert.ok(inserts > 250, `${inserts} documents had something to insert into`);
});

test("200 random documents: removing any child leaves valid JSON without that child and with the rest untouched", () => {
  for (let seed = 5000; seed < 5200; seed++) {
    const { text, value, r } = randomDoc(seed);
    const all = containers(parseDoc(text).root, value).filter((c) => (c.node.type === "object" ? c.node.members.length : c.node.items.length) > 0);
    const pick = all[Math.floor(r() * all.length)];
    if (!pick) continue;
    const n = pick.node.type === "object" ? pick.node.members.length : pick.node.items.length;
    const k = Math.floor(r() * n);
    const out = pick.node.type === "object" ? removeMember(text, pick.node, k) : removeItem(text, pick.node, k);
    const expected = structuredClone(value);
    const target = at(expected, pick.path);
    if (Array.isArray(target)) target.splice(k, 1); else delete target[Object.keys(target)[k]];
    assert.ok(sameJson(JSON.parse(out), expected), `seed ${seed}: ${out}`);
  }
});

test("sameJson compares by value, ignoring key order", () => {
  assert.ok(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!sameJson({ a: 1 }, { a: 2 }));
  assert.ok(!sameJson([1, 2], [2, 1]));
  assert.ok(!sameJson({ a: undefined }, {}));
  assert.ok(!sameJson([], {}));
  assert.ok(!sameJson(null, {}));
  assert.ok(sameJson(null, null));
});

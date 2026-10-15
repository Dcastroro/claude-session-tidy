// Changing a JSON file by editing its text, so that nothing else in it moves: a settings.json keeps its
// indentation, its line endings, its one-line arrays and the order of its keys, and taking out what was put
// in gives back the very same bytes. (Parse, change, JSON.stringify would reformat the whole file.)
//
// parseDoc reads strict JSON (what Claude Code accepts) into nodes that know where they start and end:
//   { type: "object", start, end, members: [{ key, start, end, value }] }   start/end are character offsets, end is exclusive
//   { type: "array", start, end, items: [node] }
//   { type: "string" | "number" | "literal", start, end }
// The edit functions take the text and a node of that text and return new text.

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_DEPTH = 200;

export function parseDoc(text) {
  let i = 0;
  const n = text.length;
  const err = (message) => { throw new SyntaxError(`${message} at offset ${i}`); };
  const ws = () => { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };

  function string() {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= n) err("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 34) { i++; break; }
      if (c < 32) err("control character in string");
      if (c === 92) {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) err("bad \\u escape");
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else err("bad escape");
      } else i++;
    }
    return { type: "string", start, end: i };
  }

  function value(depth) {
    if (depth > MAX_DEPTH) err("nested too deeply");
    ws();
    const c = text[i];
    if (c === "{") {
      const node = { type: "object", start: i, end: 0, members: [] };
      i++;
      ws();
      if (text[i] === "}") { i++; node.end = i; return node; }
      for (;;) {
        ws();
        if (text[i] !== '"') err("expected a string key");
        const k = string();
        ws();
        if (text[i] !== ":") err("expected ':'");
        i++;
        const v = value(depth + 1);
        node.members.push({ key: JSON.parse(text.slice(k.start, k.end)), start: k.start, end: v.end, value: v });
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; node.end = i; return node; }
        err("expected ',' or '}'");
      }
    }
    if (c === "[") {
      const node = { type: "array", start: i, end: 0, items: [] };
      i++;
      ws();
      if (text[i] === "]") { i++; node.end = i; return node; }
      for (;;) {
        node.items.push(value(depth + 1));
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; node.end = i; return node; }
        err("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) { const start = i; i += word.length; return { type: "literal", start, end: i }; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m) { const start = i; i += m[0].length; return { type: "number", start, end: i }; }
    return err("unexpected character");
  }

  try {
    const root = value(0);
    ws();
    if (i < n) err("unexpected text after the value");
    return { ok: true, root };
  } catch (e) {
    return { ok: false, reason: e instanceof SyntaxError ? e.message : String(e && e.message) };
  }
}

// The member of an object node with this key (the last one, as JSON.parse reads a repeated key), or null.
export function findMember(obj, key) {
  if (!obj || obj.type !== "object") return null;
  for (let k = obj.members.length - 1; k >= 0; k--) if (obj.members[k].key === key) return { member: obj.members[k], index: k };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Style: the file's own line ending and indentation
// ---------------------------------------------------------------------------------------------

// { eol, unit }: "\r\n" when most line breaks are, and one level of indentation (a tab, or the smallest
// indentation found; two spaces for a file with none).
export function styleOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  let unit = "";
  let tabs = false;
  let least = Infinity;
  for (const m of text.matchAll(/^([ \t]+)\S/gm)) {
    if (m[1].includes("\t")) tabs = true;
    else least = Math.min(least, m[1].length);
  }
  if (tabs) unit = "\t";
  else unit = " ".repeat(Number.isFinite(least) ? Math.min(least, 8) : 2);
  return { eol: crlf > lf ? "\r\n" : "\n", unit };
}

const lineStart = (text, pos) => text.lastIndexOf("\n", pos - 1) + 1;
const lineIndent = (text, pos) => /^[ \t]*/.exec(text.slice(lineStart(text, pos)))[0];
const startsLine = (text, pos) => /^[ \t]*$/.test(text.slice(lineStart(text, pos), pos));

// A JSON value written in the file's style, its continuation lines starting with `indent`.
const pretty = (value, indent, st) => JSON.stringify(value, null, st.unit).replace(/\n/g, st.eol + indent);

// ---------------------------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------------------------

// Adds `"key": value` as the last member of an object. In a multi-line object the new member gets its own
// line, indented like the last one; in a one-line object it follows on the same line.
export function insertMember(text, obj, key, value, st = styleOf(text)) {
  const { members } = obj;
  if (members.length) {
    const first = members[0];
    const last = members[members.length - 1];
    if (text.slice(obj.start + 1, first.start).includes("\n")) {
      const indent = lineIndent(text, startsLine(text, last.start) ? last.start : first.start);
      return `${text.slice(0, last.end)},${st.eol}${indent}${JSON.stringify(key)}: ${pretty(value, indent, st)}${text.slice(last.end)}`;
    }
    return `${text.slice(0, last.end)}, ${JSON.stringify(key)}: ${JSON.stringify(value)}${text.slice(last.end)}`;
  }
  const parent = lineIndent(text, obj.start);
  const indent = parent + st.unit;
  return `${text.slice(0, obj.start)}{${st.eol}${indent}${JSON.stringify(key)}: ${pretty(value, indent, st)}${st.eol}${parent}}${text.slice(obj.end)}`;
}

// Adds a value as the last item of an array, the same way.
export function insertItem(text, arr, value, st = styleOf(text)) {
  const { items } = arr;
  if (items.length) {
    const first = items[0];
    const last = items[items.length - 1];
    if (text.slice(arr.start + 1, first.start).includes("\n")) {
      const indent = lineIndent(text, startsLine(text, last.start) ? last.start : first.start);
      return `${text.slice(0, last.end)},${st.eol}${indent}${pretty(value, indent, st)}${text.slice(last.end)}`;
    }
    return `${text.slice(0, last.end)}, ${JSON.stringify(value)}${text.slice(last.end)}`;
  }
  const parent = lineIndent(text, arr.start);
  const indent = parent + st.unit;
  return `${text.slice(0, arr.start)}[${st.eol}${indent}${pretty(value, indent, st)}${st.eol}${parent}]${text.slice(arr.end)}`;
}

// Removes the k-th child (member or item) of a container together with its comma, leaving the spacing of
// the others as it was. The only child leaves "{}" or "[]".
function removeChild(text, container, children, k) {
  const child = children[k];
  if (children.length === 1) return text.slice(0, container.start + 1) + text.slice(container.end - 1);
  if (k < children.length - 1) return text.slice(0, child.start) + text.slice(children[k + 1].start);
  return text.slice(0, children[k - 1].end) + text.slice(child.end);
}
export const removeMember = (text, obj, k) => removeChild(text, obj, obj.members, k);
export const removeItem = (text, arr, k) => removeChild(text, arr, arr.items, k);

// Structural equality of two parsed JSON values (key order does not matter, array order does).
export function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}

// Mockingbird: paste an OpenAPI spec and get realistic mock responses, a try-it console, and a free local mock server to run.
import { useMemo, useState } from "react";
import * as yaml from "js-yaml";
import { download, useCopy, useStored } from "./lib/store";
import { Section, Stat, Stats } from "./ui/kit";

const T = "mockingbird";
type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; example?: unknown; enum?: unknown[]; format?: string; $ref?: string; required?: string[]; allOf?: Schema[]; oneOf?: Schema[]; anyOf?: Schema[] };
type Op = { method: string; path: string; summary: string; status: string; schema?: Schema; example?: unknown; params: string[] };
const SAMPLE = `openapi: 3.0.3
info: { title: Shop API, version: "1.0" }
paths:
  /products:
    get:
      summary: List products
      parameters: [{ name: category, in: query }]
      responses:
        "200":
          description: OK
          content: { application/json: { schema: { type: array, items: { $ref: "#/components/schemas/Product" } } } }
    post:
      summary: Create a product
      responses:
        "201": { description: Created, content: { application/json: { schema: { $ref: "#/components/schemas/Product" } } } }
  /products/{id}:
    get:
      summary: Get one product
      parameters: [{ name: id, in: path }]
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Product" } } } }
  /orders/{id}:
    get:
      summary: Get an order
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Order" } } } }
components:
  schemas:
    Product:
      type: object
      properties:
        id: { type: string, format: uuid }
        name: { type: string, example: "Handmade mug" }
        price: { type: number, example: 42 }
        currency: { type: string, enum: [TND, EUR, USD] }
        inStock: { type: boolean }
        createdAt: { type: string, format: date-time }
    Order:
      type: object
      properties:
        id: { type: string }
        email: { type: string, format: email }
        status: { type: string, enum: [pending, paid, shipped] }
        items: { type: array, items: { $ref: "#/components/schemas/Product" } }
        total: { type: number }`;

function resolve(s: Schema | undefined, root: Record<string, unknown>, depth = 0): Schema | undefined {
  if (!s || depth > 8) return s;
  if (s.$ref) { const parts = s.$ref.replace(/^#\//, "").split("/"); let cur: unknown = root; for (const p of parts) cur = (cur as Record<string, unknown>)?.[p]; return resolve(cur as Schema, root, depth + 1); }
  if (s.allOf) return { type: "object", properties: Object.assign({}, ...s.allOf.map(x => resolve(x, root, depth + 1)?.properties ?? {})) };
  if (s.oneOf || s.anyOf) return resolve((s.oneOf ?? s.anyOf)![0], root, depth + 1);
  return s;
}
/** Invent a believable value from the schema, the field name and the format. */
function fake(s: Schema | undefined, root: Record<string, unknown>, name = "", seed = 1, depth = 0): unknown {
  const r = resolve(s, root); if (!r || depth > 6) return null;
  if (r.example !== undefined) return r.example;
  if (r.enum) return r.enum[seed % r.enum.length];
  const n = name.toLowerCase();
  switch (r.type ?? (r.properties ? "object" : r.items ? "array" : "string")) {
    case "object": return Object.fromEntries(Object.entries(r.properties ?? {}).map(([k, v]) => [k, fake(v, root, k, seed, depth + 1)]));
    case "array": return Array.from({ length: 3 }, (_, i) => fake(r.items, root, name, seed + i, depth + 1));
    case "integer": return n.includes("age") ? 20 + seed * 7 : n.includes("count") || n.includes("qty") ? seed + 1 : 100 + seed * 17;
    case "number": return n.includes("price") || n.includes("total") || n.includes("amount") ? Math.round((19.9 + seed * 13.5) * 100) / 100 : seed * 3.5;
    case "boolean": return seed % 2 === 1;
    default:
      if (r.format === "uuid" || n === "id" || n.endsWith("_id") || n.endsWith("id")) return `${["3f2a", "9b1c", "c7d4", "51e8"][seed % 4]}c1e2-7a1b-4c3d-9e0f-${String(100000000000 + seed * 7919).slice(-12)}`;
      if (r.format === "date-time" || n.endsWith("at") || n.includes("date")) return new Date(Date.UTC(2026, 8, seed + 1, 10, 30)).toISOString();
      if (r.format === "date") return `2026-09-${String(seed + 1).padStart(2, "0")}`;
      if (r.format === "email" || n.includes("email")) return ["amira", "karim", "lina"][seed % 3] + "@example.com";
      if (n.includes("name")) return ["Amira Haddad", "Karim Ben Ali", "Lina Trabelsi"][seed % 3];
      if (n.includes("url") || r.format === "uri") return `https://example.com/${name}/${seed}`;
      if (n.includes("phone")) return `+216 22 ${String(100000 + seed * 4321).slice(-6)}`;
      if (n.includes("city")) return ["Tunis", "Sfax", "Sousse"][seed % 3];
      return `${name || "text"} ${seed}`;
  }
}

function parseSpec(text: string): { ops: Op[]; root: Record<string, unknown>; title: string; err?: string } {
  try {
    const root = (text.trim().startsWith("{") ? JSON.parse(text) : yaml.load(text)) as Record<string, unknown>;
    const paths = (root.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
    const ops: Op[] = [];
    Object.entries(paths).forEach(([path, methods]) => Object.entries(methods).forEach(([method, op]) => {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) return;
      const responses = (op.responses ?? {}) as Record<string, { content?: Record<string, { schema?: Schema; example?: unknown }> }>;
      const status = Object.keys(responses).find(s => s.startsWith("2")) ?? "200";
      const content = responses[status]?.content?.["application/json"];
      ops.push({ method: method.toUpperCase(), path, summary: String(op.summary ?? ""), status, schema: content?.schema, example: content?.example, params: ((op.parameters ?? []) as { name: string }[]).map(p => p.name) });
    }));
    return { ops, root, title: String((root.info as { title?: string })?.title ?? "API") };
  } catch (e) { return { ops: [], root: {}, title: "", err: (e as Error).message }; }
}

export default function Mockingbird() {
  const [spec, setSpec] = useStored(T, "spec", SAMPLE);
  const [sel, setSel] = useState(0);
  const [seed, setSeed] = useState(1);
  const [path, setPath] = useState("");
  const { copy, copied } = useCopy();
  const { ops, root, title, err } = useMemo(() => parseSpec(spec), [spec]);
  const op = ops[sel];
  const body = op ? (op.example ?? fake(op.schema, root, "", seed)) : null;
  const mocks = ops.map(o => ({ ...o, body: o.example ?? fake(o.schema, root, "", 1) }));
  const serverJs = `// Mock server for ${title}. Run with: node mock-server.mjs  (needs Node 18+, no installs)
import http from "node:http";
const routes = ${JSON.stringify(mocks.map(m => ({ method: m.method, path: m.path, status: +m.status || 200, body: m.body })), null, 2)};
const match = (p, u) => new RegExp("^" + p.replace(/\\{[^}]+\\}/g, "[^/]+") + "/?$").test(u);
http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const r = routes.find(x => x.method === req.method && match(x.path, url));
  res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Headers", "*"); res.setHeader("Access-Control-Allow-Methods", "*");
  if (req.method === "OPTIONS") return res.end();
  res.writeHead(r ? r.status : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(r ? r.body : { error: "No mock for " + req.method + " " + url }));
}).listen(4010, () => console.log("Mock ${title} on http://localhost:4010"));
`;
  const mswJs = `// MSW handlers for ${title}. Add to your mocks/handlers.js
import { http, HttpResponse } from "msw";
export const handlers = [
${mocks.map(m => `  http.${m.method.toLowerCase()}("*${m.path.replace(/\{([^}]+)\}/g, ":$1")}", () => HttpResponse.json(${JSON.stringify(m.body)}, { status: ${+m.status || 200} })),`).join("\n")}
];
`;

  return (
    <div className="stack">
      <Section title={title || "Your API"} aside={<><button className="btn small primary" disabled={!ops.length} onClick={() => download("mock-server.mjs", serverJs, "text/javascript")}>Download mock server</button><button className="btn small" disabled={!ops.length} onClick={() => download("handlers.js", mswJs, "text/javascript")}>MSW handlers</button></>}>
        <Stats><Stat value={ops.length} label="Endpoints" /><Stat value={[...new Set(ops.map(o => o.path))].length} label="Paths" /><Stat value={Object.keys(((root.components as { schemas?: object })?.schemas) ?? {}).length} label="Schemas" /></Stats>
        {err && <p className="pill bad" style={{ marginTop: 10 }}>Could not read the spec: {err}</p>}
        <p className="note" style={{ marginTop: 10 }}>The mock server is a single file with no dependencies. Run it on your own machine for free: <code>node mock-server.mjs</code>, then point your frontend at http://localhost:4010.</p>
      </Section>
      <div className="grid2">
        <Section title="OpenAPI spec"><textarea id="mb-spec" className="input" rows={18} value={spec} onChange={e => setSpec(e.target.value)} style={{ fontFamily: "var(--mono)", fontSize: 12 }} aria-label="OpenAPI spec in YAML or JSON" /></Section>
        <Section title="Try it">
          <div className="stack" style={{ gap: 6 }}>{ops.map((o, i) => <button key={i} className={"mk-op" + (i === sel ? " on" : "")} onClick={() => { setSel(i); setPath(o.path); }}><b className={"mk-m " + o.method.toLowerCase()}>{o.method}</b><code>{o.path}</code><span className="note">{o.summary}</span></button>)}</div>
          {op && <>
            <div className="row" style={{ marginTop: 12, alignItems: "center" }}><code className="mk-url">{op.method} {path || op.path}</code><button className="btn small" onClick={() => setSeed(seed + 1)}>New sample</button><button className="btn small" onClick={() => copy(JSON.stringify(body, null, 2))}>{copied ? "Copied" : "Copy"}</button></div>
            <p className="note" style={{ marginTop: 6 }}>Status {op.status}{op.params.length ? ` · params: ${op.params.join(", ")}` : ""}</p>
            <pre className="mk-pre">{JSON.stringify(body, null, 2)}</pre>
          </>}
        </Section>
      </div>
      <style>{`.mk-op{display:flex;gap:10px;align-items:center;text-align:left;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:8px 10px;cursor:pointer;flex-wrap:wrap}.mk-op.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}.mk-op code{font-family:var(--mono);font-size:13px}
      .mk-m{font-family:var(--mono);font-size:11px;padding:2px 6px;border-radius:4px;color:#fff;min-width:52px;text-align:center}.mk-m.get{background:#0E7A4F}.mk-m.post{background:#3255A4}.mk-m.put,.mk-m.patch{background:#A26500}.mk-m.delete{background:#C0343F}
      .mk-url{font-family:var(--mono);font-size:13px;background:var(--sunk);padding:6px 10px;border-radius:6px;flex:1}.mk-pre{background:#0B0D18;color:#D7DBF2;padding:14px;border-radius:10px;font-size:12.5px;max-height:420px;overflow:auto;margin:10px 0 0}`}</style>
    </div>
  );
}

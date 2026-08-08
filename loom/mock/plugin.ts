import type { Plugin } from "vite";
import { TABLES, catalogue, toCsv } from "./tables.js";
import { RESEARCH, researchCatalogue } from "./research.js";

/**
 * Serves the mock tables over HTTP during development.
 *
 *   GET /api/mock                 → JSON catalogue of available tables
 *   GET /api/mock/:table?rows=N   → text/csv
 *
 * Deliberately a real HTTP endpoint rather than an imported fixture: the agent reaches
 * it exactly the way it reaches context.dev, so the mock path exercises the same
 * fetch-parse-render pipeline the live path uses. Only the data source is fake.
 */
export function mockApi(): Plugin {
  return {
    name: "loom-mock-api",
    configureServer(server) {
      server.middlewares.use("/api/mock", (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const name = url.pathname.replace(/^\/+|\/+$/g, "");

        if (!name) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ tables: catalogue(), research: researchCatalogue() }, null, 2));
          return;
        }

        // Pre-researched datasets arrive whole, in the shape the research pipeline
        // produces — sources, typed fields, records and findings — rather than as CSV
        // that would have to be re-inferred.
        if (name.startsWith("research/")) {
          const topic = name.slice("research/".length);
          const dataset = RESEARCH[topic];
          if (!dataset) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: `No research dataset "${topic}".`, available: Object.keys(RESEARCH) }));
            return;
          }
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(dataset));
          return;
        }

        const table = TABLES[name];
        if (!table) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: `No mock table named "${name}".`,
              available: Object.keys(TABLES),
            }),
          );
          return;
        }

        const requested = Number(url.searchParams.get("rows"));
        const rows = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 1000) : table.defaultRows;

        res.setHeader("content-type", "text/csv; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(toCsv(table, rows));
      });
    },
  };
}

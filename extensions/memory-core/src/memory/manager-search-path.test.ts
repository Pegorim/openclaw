import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { bm25RankToScore } from "./keyword-query.js";
import { searchPathKeyword } from "./manager-search.js";
import { createMemorySearchDb, insertKeywordFixture } from "./manager-search.test-support.js";

type PathSearchOptions = Omit<Parameters<typeof searchPathKeyword>[0], "db" | "query">;

function searchPath(db: DatabaseSync, query: string, options: Partial<PathSearchOptions> = {}) {
  return searchPathKeyword({
    db,
    pathFtsTable: "memory_index_paths_fts",
    query,
    ftsTokenizer: "unicode61",
    limit: 1,
    snippetMaxChars: 200,
    sourceFilter: { sql: "", params: [] },
    ...options,
  });
}

function insertPaths(db: DatabaseSync, paths: Record<string, string>) {
  for (const [id, path] of Object.entries(paths)) {
    insertKeywordFixture(db, { id, path });
  }
}

describe("searchPathKeyword", () => {
  function createDb(options: Parameters<typeof createMemorySearchDb>[0] = {}) {
    const { db, schema } = createMemorySearchDb(options);
    try {
      expect(schema.ftsAvailable, schema.ftsError).toBe(true);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  it("keeps filename token matching strict so foo.md does not match unrelated .md paths", async () => {
    using db = createDb({ ftsTokenizer: "unicode61" });
    insertPaths(db, {
      target: "memory/notes/foo.md",
      "other-1": "memory/notes/bar.md",
      "other-2": "memory/notes/baz.md",
    });

    const results = await searchPath(db, "foo.md", { limit: 10 });

    expect(results.map((entry) => entry.id)).toEqual(["target"]);
  });

  it.each([
    ["unicode61", "common"],
    ["trigram", "README.md"],
    ["trigram", "成语"],
  ] as const)(
    "bounds first-chunk work with stale statistics for %s query %s",
    async (ftsTokenizer, query) => {
      using db = createDb({ ftsTokenizer });
      insertKeywordFixture(db, { id: "seed", path: "seed.md" });
      // Analyze an almost-empty index before it grows, as during an upgrade.
      db.exec("PRAGMA analysis_limit=1000; ANALYZE main");
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', '', 0, 0)",
      ).run("memory/common/成语/00-empty/README.md");
      for (let index = 0; index < 64; index++) {
        for (let chunk = 2; chunk >= 0; chunk--) {
          insertKeywordFixture(db, {
            id: `path-${index}-chunk-${chunk}`,
            path: `memory/common/成语/${String(index).padStart(3, "0")}/README.md`,
            source: index % 2 === 0 ? "memory" : "sessions",
            startLine: chunk * 5 + 1,
            endLine: chunk * 5 + 4,
            text: `body ${index}/${chunk} ` + "x".repeat(8_000),
          });
        }
      }
      let examinedChunkLines = 0;
      db.function("observe_path_chunk_line", (line) => {
        examinedChunkLines++;
        return line;
      });

      const queryPlans: string[] = [];
      let fetchedTextBytes = 0;
      const prepare = db.prepare.bind(db);
      using prepareSpy = vi.spyOn(db, "prepare");
      prepareSpy.mockImplementation((sql) => {
        // Observe sorting work without replacing the indexed chunks table.
        const statement = prepare(
          sql.replaceAll("candidate.start_line", "observe_path_chunk_line(candidate.start_line)"),
        );
        const observePlan = (values: SQLInputValue[]) => {
          for (const row of prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values)) {
            queryPlans.push(String(row.detail));
          }
        };
        function* observed(
          values: SQLInputValue[],
          read: () => Iterable<ReturnType<typeof statement.all>[number]>,
        ) {
          observePlan(values);
          for (const row of read()) {
            if (typeof row.text === "string") {
              fetchedTextBytes += Buffer.byteLength(row.text);
            }
            yield row;
          }
        }
        statement.all = new Proxy(statement.all.bind(statement), {
          apply: (all, _receiver, values: SQLInputValue[]) => [
            ...observed(values, () => all(...values)),
          ],
        });
        statement.iterate = new Proxy(statement.iterate.bind(statement), {
          apply: (iterate, _receiver, values: SQLInputValue[]) =>
            observed(values, () => iterate(...values)),
        });
        return statement;
      });
      const results = await searchPath(db, query, {
        ftsTokenizer,
        limit: 2,
        sourceFilter: {
          sql: " AND memory_index_paths_fts.source IN (?)",
          params: ["memory"],
        },
      });

      expect(results.map(({ id, snippet }) => ({ id, snippet }))).toEqual([
        { id: "path-0-chunk-0", snippet: "body 0/0 " + "x".repeat(191) },
        { id: "path-2-chunk-0", snippet: "body 2/0 " + "x".repeat(191) },
      ]);
      expect(queryPlans.length).toBeGreaterThan(0);
      expect(queryPlans.filter((detail) => /\bSCAN (?:c|candidate)\b/.test(detail))).toEqual([]);
      expect(examinedChunkLines).toBeGreaterThan(0);
      expect(examinedChunkLines).toBeLessThanOrEqual(16);
      expect(fetchedTextBytes).toBeLessThanOrEqual(4 * 200 * 4);
    },
  );

  it("applies short CJK trigram substring matching to the path table", async () => {
    using db = createDb({ ftsTokenizer: "trigram" });
    insertPaths(db, {
      "cjk-path": "memory/成语-notes.md",
      "cjk-exact": "memory/成语.md",
      "readme-exact": "memory/README.md",
      "normalized-exact": "memory/Cafe\u0301.md",
      "tokenless-exact": "memory/🧠.md",
    });

    const results = await searchPath(db, "成语", {
      ftsTokenizer: "trigram",
      limit: 10,
    });

    expect(results.map((entry) => entry.id)).toEqual(["cjk-exact", "cjk-path"]);
    for (const [query, id, exactPathSpecificity] of [
      ["成语.md", "cjk-exact", 2],
      ["README.md", "readme-exact", 2],
      ["CAFÉ", "normalized-exact", 1],
      ["🧠", "tokenless-exact", 1],
    ] as const) {
      await expect(searchPath(db, query, { ftsTokenizer: "trigram" })).resolves.toMatchObject([
        { id, exactPathSpecificity },
      ]);
    }
  });

  it.each([
    { tokenizer: "trigram", path: "memory/Cafe\u0301-notes.md", queries: ["Café", "fé"] },
    { tokenizer: "unicode61", path: "memory/Café.md", queries: ["afé", "AFE\u0301", "memory afé"] },
  ] as const)(
    "matches partial Unicode paths with $tokenizer",
    async ({ tokenizer, path, queries }) => {
      const options = tokenizer === "trigram" ? { ftsTokenizer: tokenizer, limit: 10 } : {};
      using db = createDb(options);
      insertPaths(db, { partial: path });
      for (const query of queries) {
        await expect(searchPath(db, query, options)).resolves.toMatchObject([
          { id: "partial", exactPathSpecificity: 0 },
        ]);
      }
      if (tokenizer === "unicode61") {
        await expect(searchPath(db, "emory afé")).resolves.toEqual([]);
      }
    },
  );

  it("bounds exact-path headroom independently from lexical candidates", async () => {
    const exactPath = (index: number) =>
      `memory/duplicates/${String(index).padStart(3, "0")}/README.md`;
    const partialPath = (index: number) => `memory/partial/${index}/notes-README.md.bak`;
    using db = createDb();
    for (let index = 0; index < 1_000; index += 1) {
      insertKeywordFixture(db, { id: `duplicate-${index}`, path: exactPath(index) });
    }
    for (let index = 0; index < 6; index += 1) {
      insertKeywordFixture(db, {
        id: `partial-${index}`,
        path: partialPath(index),
      });
    }
    for (const path of ["a/README.md", "a/notes-README.md.bak"]) {
      insertKeywordFixture(db, { id: path, path, source: "sessions" });
    }

    for (const query of ["README.md", "README"]) {
      const ranks = db
        .prepare(
          "SELECT path, bm25(memory_index_paths_fts) AS rank FROM memory_index_paths_fts WHERE memory_index_paths_fts MATCH ? AND source = 'memory'",
        )
        .all(query === "README.md" ? '"README" AND "md"' : '"README"');
      const scores = new Map(
        ranks.map((row) => {
          if (typeof row.path !== "string" || typeof row.rank !== "number") {
            throw new Error("invalid SQLite path rank");
          }
          return [row.path, bm25RankToScore(row.rank)];
        }),
      );
      const results = await searchPath(db, query, {
        exactPathLimit: 200,
        limit: 4,
        sourceFilter: {
          sql: " AND memory_index_paths_fts.source IN (?)",
          params: ["memory"],
        },
      });
      const expected = Array.from({ length: 204 }, (_, index) => {
        const exact = index < 200;
        const path = exact ? exactPath(index) : partialPath(index - 200);
        const score = scores.get(path);
        expect(score).toBeTypeOf("number");
        return {
          id: exact ? `duplicate-${index}` : `partial-${index - 200}`,
          path,
          source: "memory",
          startLine: 1,
          endLine: 2,
          snippet: "unrelated body",
          score,
          textScore: 0,
          pathScore: score,
          hasBodyMatch: false,
          exactPathSpecificity: exact ? (query === "README.md" ? 2 : 1) : 0,
        };
      });
      expect(results).toEqual(expected);
    }
  });
});

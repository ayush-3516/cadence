// Minimal API endpoint required by `ponder start` (this Ponder version
// requires this file to exist even when the app doesn't yet expose a custom
// HTTP API). Not part of the Task 7 test surface itself — this just satisfies
// Ponder's build requirement so the indexer process can run at all. Exposes
// Ponder's standard SQL-over-HTTP and GraphQL middleware against the schema
// built in Task 3, which is a reasonable default until a real API layer
// (a later sub-project per the PRD) replaces it.
import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";

const app = new Hono();

app.use("/sql/*", client({ db, schema }));

app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

export default app;

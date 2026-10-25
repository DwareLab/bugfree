// Initialize bugfree before anything else so process-level handlers are in place.
import * as Bugfree from "@bugfree/express";

Bugfree.init({
  dsn: process.env.BUGFREE_DSN,
  release: process.env.BUGFREE_RELEASE,
  environment: process.env.NODE_ENV ?? "development",
  debug: true,
});

import express from "express";
import { findUser } from "./users.js";

const app = express();
app.use(Bugfree.requestHandler());
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("html").send(`<h1>express-demo</h1><ul>
    <li><a href="/users/42">/users/42</a> — TypeError in a route</li>
    <li><a href="/async">/async</a> — rejected promise in an async handler</li>
    <li><a href="/next-error">/next-error</a> — error passed to next() with a cause</li>
    <li><a href="/handled">/handled</a> — manually captured error, request continues</li>
    <li><a href="/message">/message</a> — captureMessage</li>
    <li><a href="/not-found">/not-found</a> — 404 (not reported)</li>
    <li><a href="/unhandled-rejection">/unhandled-rejection</a> — unhandled rejection outside a request</li>
  </ul>`);
});

app.get("/users/:id", (req, res) => {
  Bugfree.setUser({ id: req.params.id, email: `user${req.params.id}@example.com` });
  Bugfree.addBreadcrumb({ category: "auth", message: `Loaded session for user ${req.params.id}` });
  const user = findUser(req.params.id);
  res.json({ name: user.profile.name });
});

app.get("/async", async () => {
  await new Promise((r) => setTimeout(r, 10));
  await fetch("https://example.invalid/never").catch(() => {});
  throw new RangeError("Payment amount must be positive, got -5");
});

app.get("/next-error", (_req, _res, next) => {
  const dbError = new Error("connect ECONNREFUSED 127.0.0.1:6543");
  next(new Error("Could not load orders", { cause: dbError }));
});

app.get("/handled", (_req, res) => {
  try {
    JSON.parse("{not json");
  } catch (err) {
    const eventId = Bugfree.captureException(err, { tags: { feature: "import" } });
    res.json({ ok: false, eventId });
    return;
  }
  res.json({ ok: true });
});

app.get("/message", (_req, res) => {
  Bugfree.captureMessage("Inventory sync took longer than 30s", "warning");
  res.json({ ok: true });
});

app.get("/unhandled-rejection", (_req, res) => {
  setTimeout(() => Promise.reject(new Error("Background job failed: quota exceeded")), 5);
  res.json({ ok: true, note: "a rejection will happen in the background" });
});

app.get("/not-found", (_req, res) => {
  const err = Object.assign(new Error("Nothing here"), { status: 404 });
  throw err;
});

// Report errors, then fall through to your own error handler.
Bugfree.setupExpressErrorHandler(app);

app.use((err, _req, res, _next) => {
  res.status(err.status ?? 500).json({ error: err.message, eventId: res.locals.bugfreeEventId });
});

const port = Number(process.env.PORT ?? 5050);
app.listen(port, () => console.log(`express-demo on http://localhost:${port}`));

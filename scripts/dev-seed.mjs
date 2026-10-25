#!/usr/bin/env node
// Local development only: creates the dev account, the two demo projects, and writes the
// examples' env files with their DSNs. Safe to re-run.
import { writeFileSync } from "node:fs";

const API = process.env.API_URL ?? "http://localhost:4100";
const APP = process.env.APP_URL ?? "http://localhost:3100";
// Test credentials for the local dev database. Never use these anywhere else.
const EMAIL = process.env.DEV_EMAIL ?? "dev@bugfree.test";
const PASSWORD = process.env.DEV_PASSWORD ?? "devpassword123";

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { origin: APP, cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const state = await call("GET", "/api/auth/state");
if (state.setupRequired) {
  await call("POST", "/api/auth/setup", { email: EMAIL, password: PASSWORD });
  console.log(`Created dev account ${EMAIL}`);
} else {
  await call("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
}

const existing = await call("GET", "/api/projects");
async function project(name, platform) {
  const found = existing.find((p) => p.name === name);
  return found ? call("GET", `/api/projects/${found.id}`) : call("POST", "/api/projects", { name, platform });
}

const express = await project("Demo Express", "express");
writeFileSync("examples/express-demo/.env", `BUGFREE_DSN=${express.dsn}\nBUGFREE_RELEASE=express-demo@0.1.0\nPORT=5050\n`);

const next = await project("Demo Next.js", "nextjs");
writeFileSync(
  "examples/next-demo/.env.local",
  `NEXT_PUBLIC_BUGFREE_DSN=${next.dsn}\nBUGFREE_RELEASE=next-demo@0.1.0\nBUGFREE_URL=${API}\nBUGFREE_AUTH_TOKEN=${next.secret_key}\n`,
);

console.log(`Projects ready. Sign in at ${APP} with ${EMAIL} (see scripts/dev-seed.mjs).`);
console.log("Wrote examples/express-demo/.env and examples/next-demo/.env.local");

import assert from "node:assert/strict";
import test from "node:test";

import { createHandler } from "../netlify/functions/api.mjs";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  FLASK_SECRET_KEY: "a-test-secret-for-cookie-signing",
  COOKIE_SECURE: "true",
};

const hubRows = [
  { name: "Batangas City", latitude: 13.7565, longitude: 121.0583 },
  { name: "Bulacan Baliwag", latitude: 14.9547, longitude: 120.9003 },
  { name: "Cabuyao Laguna", latitude: 14.2726, longitude: 121.1262 },
  { name: "Lucban Quezon", latitude: 14.1136, longitude: 121.555 },
  { name: "Bauan Batangas", latitude: 13.7917, longitude: 121.0085 },
];

const edgeRows = [
  { hub_a: "Batangas City", hub_b: "Bauan Batangas", distance: 10 },
  { hub_a: "Batangas City", hub_b: "Cabuyao Laguna", distance: 63 },
  { hub_a: "Cabuyao Laguna", hub_b: "Lucban Quezon", distance: 61 },
  { hub_a: "Bulacan Baliwag", hub_b: "Cabuyao Laguna", distance: 100 },
  { hub_a: "Bulacan Baliwag", hub_b: "Lucban Quezon", distance: 130 },
];

function createSupabaseMock({ requests = [], audits = [] } = {}) {
  const store = {
    requests: structuredClone(requests),
    profiles: [],
    audits: structuredClone(audits).map((data, index) => ({ id: String(index + 1), data })),
    nextAuditId: audits.length + 1,
    hubs: structuredClone(hubRows),
    edges: structuredClone(edgeRows),
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/auth/v1/token")) {
      const { email } = JSON.parse(init.body);
      const isAdmin = email.startsWith("admin");
      const id = isAdmin ? "admin-id" : "user-id";
      return Response.json({
        access_token: "test-access-token",
        user: { id },
      });
    }

    const table = url.pathname.split("/").at(-1);
    if (table === "hubs") {
      if (init.method === "DELETE") {
        const name = url.searchParams.get("name")?.slice(3);
        store.hubs = store.hubs.filter((hub) => hub.name !== name);
        return new Response(null, { status: 204 });
      }
      return Response.json(store.hubs);
    }
    if (table === "hub_edges") return Response.json(store.edges);
    if (table === "profiles") {
      if (init.method === "PATCH") return new Response(null, { status: 204 });
      const id = url.searchParams.get("id")?.slice(3);
      return Response.json([{
        id,
        name: id === "admin-id" ? "Test Admin" : "Test Resident",
        role: id === "admin-id" ? "admin" : "user",
        phone: "",
      }]);
    }
    if (table === "requests") {
      if (init.method === "POST") {
        const row = JSON.parse(init.body);
        const existingIndex = store.requests.findIndex((item) => item.id === row.id);
        if (existingIndex < 0) store.requests.push(row);
        else store.requests[existingIndex] = row;
        return new Response(null, { status: 204 });
      }
      if (init.method === "DELETE") {
        const id = url.searchParams.get("id")?.slice(3);
        store.requests = store.requests.filter((item) => item.id !== id);
        return new Response(null, { status: 204 });
      }
      return Response.json(store.requests);
    }
    if (table === "audit_log") {
      if (init.method === "POST") {
        store.audits.push({ id: String(store.nextAuditId++), ...JSON.parse(init.body) });
        return new Response(null, { status: 204 });
      }
      if (init.method === "DELETE") {
        const id = url.searchParams.get("id")?.slice(3);
        store.audits = store.audits.filter((entry) => entry.id !== id);
        return new Response(null, { status: 204 });
      }
      const id = url.searchParams.get("id")?.slice(3);
      if (id) return Response.json(store.audits.filter((entry) => entry.id === id));
      return Response.json(store.audits);
    }
    throw new Error(`Unexpected Supabase request: ${url}`);
  };
  return { fetchImpl, store };
}

function makeRequest(path, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  return new Request(`https://ecoroute.netlify.app${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(handler, email = "resident@example.com") {
  const result = await handler(makeRequest("/api/login", {
    method: "POST",
    body: { email, password: "example-password" },
  }));
  assert.equal(result.status, 200);
  return result.headers.get("set-cookie").split(";")[0];
}

test("API rejects missing production configuration instead of using volatile storage", async () => {
  const handler = createHandler({ env: {}, fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  const result = await handler(makeRequest("/api/config"));
  assert.equal(result.status, 503);
  assert.match((await result.json()).error, /SUPABASE_URL/);
});

test("protected API routes require a valid session", async () => {
  const { fetchImpl } = createSupabaseMock();
  const handler = createHandler({ env, fetchImpl });
  const result = await handler(makeRequest("/api/my-requests"));
  assert.equal(result.status, 401);
  assert.deepEqual(await result.json(), { error: "Login required" });
});

test("login issues a signed cookie that authorizes the user's request list", async () => {
  const { fetchImpl } = createSupabaseMock();
  const handler = createHandler({ env, fetchImpl });
  const cookie = await login(handler);
  const result = await handler(makeRequest("/api/my-requests", { cookie }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), []);
});

test("configuration loads hubs and route algorithms return the same shortest distance", async () => {
  const { fetchImpl } = createSupabaseMock();
  const handler = createHandler({ env, fetchImpl });
  const configResult = await handler(makeRequest("/api/config"));
  assert.equal(configResult.status, 200);
  const config = await configResult.json();
  assert.equal(config.hubs.length, 5);
  assert.ok(config.categories["Batteries & Energy Storage"]);

  const cookie = await login(handler, "admin@example.com");
  const result = await handler(makeRequest(
    "/api/admin/hub-route?start=Batangas%20City&end=Lucban%20Quezon",
    { cookie },
  ));
  assert.equal(result.status, 200);
  const routes = await result.json();
  assert.equal(routes.greedy.distance, 124);
  assert.equal(routes.exhaustive.distance, 124);
  assert.equal(routes.divide_and_conquer.distance, 124);
});

test("request submission validates contact numbers and stores valid requests", async () => {
  const { fetchImpl, store } = createSupabaseMock();
  const handler = createHandler({ env, fetchImpl });
  const cookie = await login(handler);

  const invalid = await handler(makeRequest("/api/e-waste", {
    method: "POST",
    cookie,
    body: {
      category: "Batteries & Energy Storage",
      item: "Lithium-ion laptop/phone batteries",
      method: "pickup",
      phone: "call me",
      latitude: 14.25,
      longitude: 121.15,
    },
  }));
  assert.equal(invalid.status, 400);

  const valid = await handler(makeRequest("/api/e-waste", {
    method: "POST",
    cookie,
    body: {
      category: "Batteries & Energy Storage",
      item: "Lithium-ion laptop/phone batteries",
      method: "pickup",
      phone: "+63 912-345-6789",
      save_phone_default: true,
      latitude: 14.25,
      longitude: 121.15,
    },
  }));
  assert.equal(valid.status, 200);
  const saved = await valid.json();
  assert.equal(typeof saved.id, "string");
  assert.equal(store.requests.length, 1);
  assert.equal(store.requests[0].owner_id, "user-id");
  assert.equal(store.requests[0].data.status, "Pending");
  assert.equal(store.requests[0].data.request_number, "PU-0001");
  assert.equal(valid.headers.get("set-cookie").includes("Secure"), true);
});

test("admin rejection requires and stores a reason", async () => {
  const { fetchImpl, store } = createSupabaseMock({
    requests: [{
      id: "reject-me",
      owner_id: "user-id",
      data: {
        id: "reject-me",
        name: "Test Resident",
        category: "Small Peripherals & Electronics",
        item: "Keyboard",
        method: "pickup",
        status: "Pending",
        created_at: "2026-11-20T10:00:00",
      },
    }],
  });
  const handler = createHandler({ env, fetchImpl });
  const cookie = await login(handler, "admin@example.com");

  const missingReason = await handler(makeRequest("/api/admin/requests/reject-me", {
    method: "POST",
    cookie,
    body: { action: "reject" },
  }));
  assert.equal(missingReason.status, 400);

  const rejected = await handler(makeRequest("/api/admin/requests/reject-me", {
    method: "POST",
    cookie,
    body: { action: "reject", reason: "The pickup location is outside our service area." },
  }));
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).request.rejection_reason, "The pickup location is outside our service area.");
  assert.equal(store.requests[0].data.rejection_reason, "The pickup location is outside our service area.");
});

test("admins can permanently delete audit-history entries", async () => {
  const { fetchImpl } = createSupabaseMock({
    audits: [{
      request_id: "deleted-request",
      action: "deleted",
      admin: "Test Admin",
      timestamp: "2026-11-20T10:00:00",
    }],
  });
  const handler = createHandler({ env, fetchImpl });
  const residentCookie = await login(handler);
  const cookie = await login(handler, "admin@example.com");

  const listed = await handler(makeRequest("/api/admin/audit", { cookie }));
  assert.equal((await listed.json())[0].audit_id, "1");

  const forbidden = await handler(makeRequest("/api/admin/audit/1", {
    method: "DELETE",
    cookie: residentCookie,
  }));
  assert.equal(forbidden.status, 403);

  const deleted = await handler(makeRequest("/api/admin/audit/1", { method: "DELETE", cookie }));
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { status: "success", audit_id: "1" });
  const remaining = await handler(makeRequest("/api/admin/audit", { cookie }));
  assert.deepEqual(await remaining.json(), []);
});

test("audit history resolves request numbers for stored and legacy requests", async () => {
  const { fetchImpl } = createSupabaseMock({
    requests: [{
      id: "request-13",
      owner_id: "user-id",
      data: {
        id: "request-13",
        method: "pickup",
        request_number: "PU-0013",
      },
    }, {
      id: "legacy",
      owner_id: "user-id",
      data: { id: "legacy", method: "dropoff" },
    }],
    audits: [{
      request_id: "request-13",
      action: "rejected",
      admin: "Test Admin",
      timestamp: "2026-11-20T10:00:00",
    }, {
      request_id: "legacy",
      action: "approved",
      admin: "Test Admin",
      timestamp: "2026-11-20T10:01:00",
    }],
  });
  const handler = createHandler({ env, fetchImpl });
  const cookie = await login(handler, "admin@example.com");
  const result = await handler(makeRequest("/api/admin/audit", { cookie }));

  assert.equal(result.status, 200);
  const entries = await result.json();
  assert.equal(entries[0].request_number, "PU-0013");
  assert.equal(entries[1].request_number, "ER-LEGACY");
});

test("request deletion preserves its request number in audit history", async () => {
  const { fetchImpl } = createSupabaseMock({
    requests: [{
      id: "request-42",
      owner_id: "user-id",
      data: {
        id: "request-42",
        method: "pickup",
        request_number: "PU-0042",
        status: "Completed",
      },
    }],
  });
  const handler = createHandler({ env, fetchImpl });
  const cookie = await login(handler, "admin@example.com");

  const deleted = await handler(makeRequest("/api/admin/requests/request-42", {
    method: "DELETE",
    cookie,
  }));
  assert.equal(deleted.status, 200);

  const audit = await handler(makeRequest("/api/admin/audit", { cookie }));
  assert.equal((await audit.json())[0].request_number, "PU-0042");
});

test("admin request filters apply together and reject invalid date ranges", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { fetchImpl } = createSupabaseMock({
    requests: [
      {
        id: "matching",
        owner_id: "user-id",
        data: {
          id: "matching",
          name: "Test Resident",
          category: "Displays & CRT Glass",
          item: "CRT monitor",
          method: "dropoff",
          hazard: 4,
          priority_score: 12,
          status: "Completed",
          created_at: `${today}T09:00:00`,
        },
      },
      {
        id: "other",
        owner_id: "user-id",
        data: {
          id: "other",
          name: "Test Resident",
          category: "Small Peripherals & Electronics",
          item: "Keyboard",
          method: "pickup",
          hazard: 2,
          priority_score: 6,
          status: "Pending",
          created_at: `${today}T10:00:00`,
        },
      },
    ],
  });
  const handler = createHandler({ env, fetchImpl });
  const cookie = await login(handler, "admin@example.com");
  const query = new URLSearchParams({
    status: "Completed",
    method: "dropoff",
    hazard: "4",
    from_date: today,
    to_date: today,
  });
  const result = await handler(makeRequest(`/api/admin/requests?${query}`, { cookie }));
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).map((item) => item.id), ["matching"]);

  const invalid = await handler(makeRequest(
    "/api/admin/requests?from_date=2026-11-19&to_date=2026-11-18",
    { cookie },
  ));
  assert.equal(invalid.status, 400);
});

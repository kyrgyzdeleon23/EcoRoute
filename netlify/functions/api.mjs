import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "ecoroute_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const ITEMS = {
  "Batteries & Energy Storage": {
    hazard: 5,
    weight: 2,
    items: [
      "Lithium-ion laptop/phone batteries",
      "Lead-acid UPS batteries",
      "NiMH rechargeable batteries",
      "Alkaline/Lithium button cells",
    ],
  },
  "Displays & CRT Glass": {
    hazard: 4,
    weight: 12,
    items: [
      "CRT computer monitors",
      "CRT televisions",
      "Flat-panel LCD/LED monitors",
      "Plasma screens",
    ],
  },
  "Circuit Boards & Core IT": {
    hazard: 4,
    weight: 4,
    items: [
      "Computer motherboards",
      "RAM & expansion cards",
      "CPU processors & GPUs",
      "Hard disk drives (HDDs/SSDs)",
    ],
  },
  "Large Appliances & Chassis": {
    hazard: 3,
    weight: 20,
    items: [
      "Desktop computer towers (chassis with components)",
      "Office printers & scanners",
      "Copiers & fax machines",
      "Server racks & power supplies",
    ],
  },
  "Small Peripherals & Electronics": {
    hazard: 2,
    weight: 1.5,
    items: [
      "Power adapters & laptop chargers",
      "Network routers, switches, & modems",
      "Webcams & digital microphones",
      "External hard drive enclosures",
    ],
  },
  "Inert / Non-Hazardous Items": {
    hazard: 1,
    weight: 1,
    items: [
      "Computer keyboards & optical mice",
      "Ethernet, USB, & audio patch cables",
      "Empty desktop computer towers / chassis",
      "Plastic printer trays & scanner covers",
    ],
  },
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function response(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}

function requireEnvironment(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    throw new ApiError(503, `Missing required environment variables: ${missing.join(", ")}`);
  }
}

function supabaseBaseUrl(env) {
  requireEnvironment(env, [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "FLASK_SECRET_KEY",
  ]);
  return env.SUPABASE_URL.replace(/\/+$/, "");
}

async function supabaseRequest(fetchImpl, env, table, {
  method = "GET",
  query = {},
  body,
  prefer,
} = {}) {
  const url = new URL(`${supabaseBaseUrl(env)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  const result = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await result.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      console.error("Supabase returned an unreadable response", error);
      throw new ApiError(502, "Supabase returned an unreadable response");
    }
  }
  if (!result.ok) {
    const message = data?.message || data?.msg || data?.error || "request failed";
    console.error(`Supabase ${method} ${table} failed (${result.status}): ${message}`);
    throw new ApiError(502, "A Supabase data request failed");
  }
  return data;
}

async function supabaseAuth(fetchImpl, env, endpoint, payload) {
  const result = await fetchImpl(
    `${supabaseBaseUrl(env)}/auth/v1/${endpoint}`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const text = await result.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      console.error("Supabase Auth returned an unreadable response", error);
      throw new ApiError(502, "Supabase Auth returned an unreadable response");
    }
  }
  if (!result.ok) {
    const message = data.msg || data.message || data.error_description || data.error;
    throw new ApiError(result.status, message || "Supabase Auth rejected the request");
  }
  return data;
}

function cookieValue(request, name) {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function signSession(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readSession(request, secret) {
  const value = cookieValue(request, COOKIE_NAME);
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const encoded = value.slice(0, separator);
  const signature = Buffer.from(value.slice(separator + 1), "base64url");
  const expected = createHmac("sha256", secret).update(encoded).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      typeof session.user_id !== "string"
      || typeof session.name !== "string"
      || !["user", "admin"].includes(session.role)
      || !Number.isInteger(session.expires_at)
      || session.expires_at <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function sessionCookie(session, env) {
  const token = signSession({
    user_id: session.user_id,
    name: session.name,
    role: session.role,
    phone: session.phone || "",
    expires_at: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }, env.FLASK_SECRET_KEY);
  const secure = env.COOKIE_SECURE?.toLowerCase() === "true" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

function expiredSessionCookie(env) {
  const secure = env.COOKIE_SECURE?.toLowerCase() === "true" ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

async function jsonBody(request) {
  try {
    const data = await request.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ApiError(400, "A valid JSON object is required");
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "A valid JSON object is required");
  }
}

function currentUser(session) {
  if (!session) return null;
  return {
    id: session.user_id,
    name: session.name,
    role: session.role,
    phone: session.phone || "",
  };
}

function requireUser(session, role) {
  if (!session) throw new ApiError(401, "Login required");
  if (role && session.role !== role) {
    throw new ApiError(403, "Administrator access required");
  }
}

async function loadHubs(fetchImpl, env) {
  const [hubRows, edgeRows] = await Promise.all([
    supabaseRequest(fetchImpl, env, "hubs", {
      query: { select: "name,latitude,longitude" },
    }),
    supabaseRequest(fetchImpl, env, "hub_edges", {
      query: { select: "hub_a,hub_b,distance" },
    }),
  ]);
  if (!hubRows?.length) {
    throw new ApiError(503, "No recycling hubs exist in Supabase; run supabase_schema.sql first.");
  }
  const hubs = new Map(hubRows.map((row) => [
    row.name,
    { latitude: row.latitude, longitude: row.longitude },
  ]));
  const graph = createGraph();
  for (const row of edgeRows || []) {
    addEdge(graph, row.hub_a, row.hub_b, row.distance);
  }
  return { hubs, graph };
}

function createGraph() {
  return { adj: new Map() };
}

function addEdge(graph, first, second, weight) {
  if (!graph.adj.has(first)) graph.adj.set(first, []);
  if (!graph.adj.has(second)) graph.adj.set(second, []);
  graph.adj.get(first).push([second, weight]);
  graph.adj.get(second).push([first, weight]);
}

function distanceKm(latitude, longitude, hubLatitude, hubLongitude) {
  const latitudeScale = 111;
  const longitudeScale = 111 * Math.cos((latitude * Math.PI) / 180);
  const latitudeDistance = (latitude - hubLatitude) * latitudeScale;
  const longitudeDistance = (longitude - hubLongitude) * longitudeScale;
  return Math.sqrt(latitudeDistance ** 2 + longitudeDistance ** 2);
}

function nearestHub(latitude, longitude, hubs) {
  const candidates = [...hubs.entries()];
  if (!candidates.length) throw new ApiError(503, "No recycling hubs are configured");

  function closestInRange(entries) {
    if (entries.length === 1) return entries[0];
    const midpoint = Math.floor(entries.length / 2);
    const left = closestInRange(entries.slice(0, midpoint));
    const right = closestInRange(entries.slice(midpoint));
    const leftDistance = distanceKm(latitude, longitude, left[1].latitude, left[1].longitude);
    const rightDistance = distanceKm(latitude, longitude, right[1].latitude, right[1].longitude);
    return leftDistance <= rightDistance ? left : right;
  }

  const [name, coordinates] = closestInRange(candidates);
  return {
    name,
    distance: Number(distanceKm(latitude, longitude, coordinates.latitude, coordinates.longitude).toFixed(2)),
  };
}

function greedyShortestPath(graph, start, end) {
  const queue = [{ distance: 0, node: start, path: [start] }];
  const visited = new Set();
  while (queue.length) {
    queue.sort((first, second) => first.distance - second.distance);
    const current = queue.shift();
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    if (current.node === end) {
      return { distance: current.distance, path: current.path };
    }
    for (const [neighbor, weight] of graph.adj.get(current.node) || []) {
      if (!visited.has(neighbor)) {
        queue.push({
          distance: current.distance + weight,
          node: neighbor,
          path: [...current.path, neighbor],
        });
      }
    }
  }
  return { distance: null, path: [] };
}

function exhaustiveShortestPath(graph, start, end) {
  if (graph.adj.size > 10) {
    throw new ApiError(400, "Exhaustive route search supports networks with at most 10 hubs");
  }
  if (!graph.adj.has(start) || !graph.adj.has(end)) {
    return { distance: null, path: [] };
  }
  let shortest = { distance: Infinity, path: [] };

  function visit(current, visited, path, distance) {
    if (current === end) {
      if (distance < shortest.distance) shortest = { distance, path: [...path] };
      return;
    }
    for (const [neighbor, weight] of graph.adj.get(current) || []) {
      if (!visited.has(neighbor) && distance + weight < shortest.distance) {
        visited.add(neighbor);
        path.push(neighbor);
        visit(neighbor, visited, path, distance + weight);
        path.pop();
        visited.delete(neighbor);
      }
    }
  }

  visit(start, new Set([start]), [start], 0);
  return Number.isFinite(shortest.distance) ? shortest : { distance: null, path: [] };
}

function divideAndConquerShortestPath(graph, start, end) {
  const vertices = [...graph.adj.keys()];
  if (!graph.adj.has(start) || !graph.adj.has(end)) {
    return { distance: null, path: [] };
  }
  const cache = new Map();
  function shortestWithLimit(source, destination, edgeLimit) {
    const key = `${source}\u0000${destination}\u0000${edgeLimit}`;
    if (cache.has(key)) return cache.get(key);
    if (edgeLimit === 0) {
      const base = source === destination ? { distance: 0, path: [source] } : null;
      cache.set(key, base);
      return base;
    }
    if (edgeLimit === 1) {
      if (source === destination) {
        const base = { distance: 0, path: [source] };
        cache.set(key, base);
        return base;
      }
      const direct = (graph.adj.get(source) || [])
        .filter(([neighbor]) => neighbor === destination)
        .map(([, distance]) => ({ distance, path: [source, destination] }))
        .sort((first, second) => first.distance - second.distance)[0] || null;
      cache.set(key, direct);
      return direct;
    }

    const leftLimit = Math.floor(edgeLimit / 2);
    const rightLimit = edgeLimit - leftLimit;
    let best = null;
    for (const midpoint of vertices) {
      const left = shortestWithLimit(source, midpoint, leftLimit);
      const right = shortestWithLimit(midpoint, destination, rightLimit);
      if (left && right && (!best || left.distance + right.distance < best.distance)) {
        best = {
          distance: left.distance + right.distance,
          path: [...left.path, ...right.path.slice(1)],
        };
      }
    }
    cache.set(key, best);
    return best;
  }

  return shortestWithLimit(start, end, Math.max(vertices.length - 1, 0))
    || { distance: null, path: [] };
}

function priorityScore(item) {
  return item.urgency * 3 + item.hazard * 2 + item.weight / 10;
}

async function roadRoute(latitude, longitude, destination, hubs, fetchImpl) {
  const hub = hubs.get(destination);
  const fallback = {
    distance: Number(distanceKm(latitude, longitude, hub.latitude, hub.longitude).toFixed(2)),
    duration: null,
    source: "geographic estimate",
  };
  const url = new URL(
    `https://router.project-osrm.org/route/v1/driving/${longitude},${latitude};${hub.longitude},${hub.latitude}`,
  );
  url.searchParams.set("overview", "false");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const result = await fetchImpl(url, { signal: controller.signal });
    if (!result.ok) return fallback;
    const route = (await result.json()).routes?.[0];
    if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) {
      return fallback;
    }
    return {
      distance: Number((route.distance / 1000).toFixed(2)),
      duration: Math.round(route.duration / 60),
      source: "OSRM road route",
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

async function allRequests(fetchImpl, env) {
  const rows = await supabaseRequest(fetchImpl, env, "requests", {
    query: { select: "id,owner_id,data" },
  });
  return (rows || []).map((row) => ({ ...row.data, user: row.owner_id }));
}

async function getRequest(fetchImpl, env, itemId) {
  const rows = await supabaseRequest(fetchImpl, env, "requests", {
    query: {
      select: "id,owner_id,data",
      id: `eq.${itemId}`,
      limit: "1",
    },
  });
  if (!rows?.length) return null;
  return { ...rows[0].data, user: rows[0].owner_id };
}

async function saveRequest(fetchImpl, env, item) {
  const data = { ...item };
  delete data.user;
  await supabaseRequest(fetchImpl, env, "requests", {
    method: "POST",
    query: { on_conflict: "id" },
    body: { id: item.id, owner_id: item.user, data },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

async function removeRequest(fetchImpl, env, itemId) {
  const existing = await getRequest(fetchImpl, env, itemId);
  if (existing) {
    await supabaseRequest(fetchImpl, env, "requests", {
      method: "DELETE",
      query: { id: `eq.${itemId}` },
    });
  }
  return existing;
}

function publicRequest(item) {
  const visible = { ...item };
  delete visible.user;
  return visible;
}

function requestReference(item) {
  return item.request_number || `ER-${String(item.id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase()}`;
}

async function addAudit(fetchImpl, env, session, requestId, action, requestNumber) {
  const entry = {
    request_id: requestId,
    request_number: requestNumber,
    action,
    admin: session.name,
    admin_username: session.user_id,
    timestamp: localIsoSeconds(),
  };
  await supabaseRequest(fetchImpl, env, "audit_log", {
    method: "POST",
    body: { data: entry },
    prefer: "return=minimal",
  });
}

function localIsoSeconds() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

async function requestRoute(item, hubData, fetchImpl) {
  const destination = nearestHub(item.latitude, item.longitude, hubData.hubs);
  const graphRoute = greedyShortestPath(hubData.graph, destination.name, destination.name);
  const road = await roadRoute(item.latitude, item.longitude, destination.name, hubData.hubs, fetchImpl);
  return {
    type: item.method,
    destination: destination.name,
    distance: road.distance,
    duration: road.duration,
    source: road.source,
    path: ["Your pinned location", ...graphRoute.path],
  };
}

function filterAndSortRequests(requests, search, sortBy, hubs) {
  const term = search.trim().toLowerCase();
  const filtered = requests.filter((item) => !term
    || item.name.toLowerCase().includes(term)
    || item.category.toLowerCase().includes(term)
    || item.item.toLowerCase().includes(term));
  if (sortBy === "item") {
    return filtered.sort((first, second) =>
      first.category.toLowerCase().localeCompare(second.category.toLowerCase())
      || first.item.toLowerCase().localeCompare(second.item.toLowerCase()));
  }
  if (sortBy === "shortest") {
    return filtered.sort((first, second) =>
      nearestHub(first.latitude, first.longitude, hubs).distance
        - nearestHub(second.latitude, second.longitude, hubs).distance
      || second.hazard - first.hazard);
  }
  return filtered.sort((first, second) =>
    second.hazard - first.hazard
    || second.priority_score - first.priority_score
    || first.created_at.localeCompare(second.created_at));
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function finiteNumber(value) {
  if (
    (typeof value !== "number" && typeof value !== "string")
    || (typeof value === "string" && !value.trim())
  ) {
    return Number.NaN;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function handleApi(request, fetchImpl, env) {
  requireEnvironment(env, [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "FLASK_SECRET_KEY",
  ]);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const session = readSession(request, env.FLASK_SECRET_KEY);

  if (path === "/api/config" && method === "GET") {
    const hubData = await loadHubs(fetchImpl, env);
    const user = currentUser(session);
    return response({
      categories: ITEMS,
      hubs: [...hubData.hubs].map(([name, coordinates]) => ({
        name,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
      })),
      user: user && { name: user.name, role: user.role, phone: user.phone },
    });
  }

  if (path === "/api/route-preview" && method === "GET") {
    requireUser(session, "user");
    const latitude = finiteNumber(url.searchParams.get("latitude"));
    const longitude = finiteNumber(url.searchParams.get("longitude"));
    if (
      !url.searchParams.has("latitude")
      || !url.searchParams.has("longitude")
      || !Number.isFinite(latitude)
      || !Number.isFinite(longitude)
    ) {
      throw new ApiError(400, "A valid pinned location is required");
    }
    const hubData = await loadHubs(fetchImpl, env);
    const destination = nearestHub(latitude, longitude, hubData.hubs);
    const road = await roadRoute(latitude, longitude, destination.name, hubData.hubs, fetchImpl);
    return response({ destination: destination.name, ...road });
  }

  if (path === "/api/admin/hub-route" && method === "GET") {
    requireUser(session, "admin");
    const hubData = await loadHubs(fetchImpl, env);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (!hubData.hubs.has(start) || !hubData.hubs.has(end)) {
      throw new ApiError(400, "Choose two valid hubs");
    }
    return response({
      greedy: greedyShortestPath(hubData.graph, start, end),
      exhaustive: exhaustiveShortestPath(hubData.graph, start, end),
      divide_and_conquer: divideAndConquerShortestPath(hubData.graph, start, end),
    });
  }

  if (path === "/api/admin/hubs" && method === "POST") {
    requireUser(session, "admin");
    const hubData = await loadHubs(fetchImpl, env);
    const data = await jsonBody(request);
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const latitude = finiteNumber(data.latitude);
    const longitude = finiteNumber(data.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new ApiError(400, "A valid latitude and longitude are required");
    }
    if (!name || hubData.hubs.has(name)) {
      throw new ApiError(400, "A unique hub name is required");
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new ApiError(400, "The coordinates are outside valid GPS bounds");
    }
    const nearestName = nearestHub(latitude, longitude, hubData.hubs).name;
    const nearestCoordinates = hubData.hubs.get(nearestName);
    await supabaseRequest(fetchImpl, env, "hubs", {
      method: "POST",
      body: { name, latitude, longitude },
      prefer: "return=minimal",
    });
    const [hubA, hubB] = [nearestName, name].sort();
    await supabaseRequest(fetchImpl, env, "hub_edges", {
      method: "POST",
      body: {
        hub_a: hubA,
        hub_b: hubB,
        distance: distanceKm(latitude, longitude, nearestCoordinates.latitude, nearestCoordinates.longitude),
      },
      prefer: "return=minimal",
    });
    return response({ status: "success", hub: { name, latitude, longitude } });
  }

  const deleteHubMatch = path.match(/^\/api\/admin\/hubs\/(.+)$/);
  if (deleteHubMatch && method === "DELETE") {
    requireUser(session, "admin");
    const hubName = decodeURIComponent(deleteHubMatch[1]);
    const hubData = await loadHubs(fetchImpl, env);
    if (!hubData.hubs.has(hubName)) throw new ApiError(404, "Hub not found");
    if (hubData.hubs.size <= 1) throw new ApiError(400, "At least one hub must remain");
    await supabaseRequest(fetchImpl, env, "hubs", {
      method: "DELETE",
      query: { name: `eq.${hubName}` },
    });
    return response({ status: "success" });
  }

  if (path === "/api/signup" && method === "POST") {
    const data = await jsonBody(request);
    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const password = typeof data.password === "string" ? data.password : "";
    if (!email || !name || password.length < 6) {
      throw new ApiError(400, "Name, valid email, and a password of at least 6 characters are required");
    }
    const result = await supabaseAuth(fetchImpl, env, "signup", {
      email,
      password,
      data: { name },
    });
    const authUser = result.user || result;
    if (!authUser.id) throw new ApiError(502, "Supabase signup did not return a user");
    await supabaseRequest(fetchImpl, env, "profiles", {
      method: "POST",
      query: { on_conflict: "id" },
      body: { id: authUser.id, name, role: "user", phone: "" },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    if (!result.access_token) {
      return response({
        status: "confirmation_required",
        message: "Check your email to confirm your account, then log in.",
      });
    }
    const userSession = { user_id: authUser.id, name, role: "user", phone: "" };
    return response(
      { status: "success", role: "user", name },
      200,
      { "Set-Cookie": sessionCookie(userSession, env) },
    );
  }

  if (path === "/api/login" && method === "POST") {
    const data = await jsonBody(request);
    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    const password = typeof data.password === "string" ? data.password : "";
    if (!email || !password) throw new ApiError(400, "Email and password are required");
    const result = await supabaseAuth(fetchImpl, env, "token?grant_type=password", {
      email,
      password,
    });
    const userId = result.user?.id;
    if (!userId) throw new ApiError(502, "Supabase login did not return a user");
    const rows = await supabaseRequest(fetchImpl, env, "profiles", {
      query: {
        select: "name,role,phone",
        id: `eq.${userId}`,
        limit: "1",
      },
    });
    if (!rows?.length) {
      throw new ApiError(403, "Your account profile is missing. Contact an administrator.");
    }
    const profile = rows[0];
    const userSession = {
      user_id: userId,
      name: profile.name,
      role: profile.role,
      phone: profile.phone || "",
    };
    return response(
      { status: "success", role: profile.role, name: profile.name },
      200,
      { "Set-Cookie": sessionCookie(userSession, env) },
    );
  }

  if (path === "/api/logout" && method === "POST") {
    return response(
      { status: "success" },
      200,
      { "Set-Cookie": expiredSessionCookie(env) },
    );
  }

  if (path === "/api/e-waste" && method === "POST") {
    requireUser(session, "user");
    const data = await jsonBody(request);
    const details = ITEMS[data.category];
    if (typeof data.phone !== "string") {
      throw new ApiError(400, "A contact phone number is required");
    }
    const phone = data.phone.trim();
    const digits = phone.replace(/[^0-9]/g, "");
    if (!/^\+?[0-9\s().-]{7,20}$/.test(phone) || digits.length < 7 || digits.length > 15) {
      throw new ApiError(400, "Enter a valid phone number with 7 to 15 digits");
    }
    const latitude = finiteNumber(data.latitude);
    const longitude = finiteNumber(data.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new ApiError(400, "A valid pinned location is required");
    }
    if (
      latitude < -90 || latitude > 90
      || longitude < -180 || longitude > 180
      || !details
      || !details.items.includes(data.item)
      || !["pickup", "dropoff"].includes(data.method)
    ) {
      throw new ApiError(400, "Choose an item and pickup or drop-off");
    }
    if (data.save_phone_default === true) {
      await supabaseRequest(fetchImpl, env, "profiles", {
        method: "PATCH",
        query: { id: `eq.${session.user_id}` },
        body: { phone },
        prefer: "return=minimal",
      });
      session.phone = phone;
    }
    const methodCount = (await allRequests(fetchImpl, env))
      .filter((item) => item.method === data.method).length;
    const requestPrefix = data.method === "pickup" ? "PU" : "DO";
    const item = {
      id: randomUUID(),
      user: session.user_id,
      name: session.name,
      category: data.category,
      item: data.item,
      method: data.method,
      request_number: `${requestPrefix}-${String(methodCount + 1).padStart(4, "0")}`,
      phone,
      latitude,
      longitude,
      weight: details.weight,
      hazard: details.hazard,
      urgency: details.hazard,
      status: "Pending",
      priority_score: 0,
      created_at: localIsoSeconds(),
    };
    item.priority_score = Number(priorityScore(item).toFixed(2));
    await saveRequest(fetchImpl, env, item);
    const headers = data.save_phone_default === true
      ? { "Set-Cookie": sessionCookie(session, env) }
      : {};
    return response({ status: "success", id: item.id }, 200, headers);
  }

  if (path === "/api/my-requests" && method === "GET") {
    requireUser(session, "user");
    const requests = await allRequests(fetchImpl, env);
    return response(requests
      .filter((item) => item.user === session.user_id)
      .map(publicRequest));
  }

  if (path === "/api/admin/requests" && method === "GET") {
    requireUser(session, "admin");
    const hubData = await loadHubs(fetchImpl, env);
    const requests = filterAndSortRequests(
      await allRequests(fetchImpl, env),
      url.searchParams.get("search") || "",
      url.searchParams.get("sort") || "risk",
      hubData.hubs,
    );
    const status = url.searchParams.get("status") || "";
    const methodFilter = url.searchParams.get("method") || "";
    const hazard = url.searchParams.get("hazard") || "";
    const fromDate = url.searchParams.get("from_date") || "";
    const toDate = url.searchParams.get("to_date") || "";
    if (status && !["Pending", "Approved", "Rejected", "Completed"].includes(status)) {
      throw new ApiError(400, "Choose a valid request status");
    }
    if (methodFilter && !["pickup", "dropoff"].includes(methodFilter)) {
      throw new ApiError(400, "Choose a valid collection method");
    }
    if (hazard && !["1", "2", "3", "4", "5"].includes(hazard)) {
      throw new ApiError(400, "Choose a valid hazard level");
    }
    if ((fromDate && !validDate(fromDate)) || (toDate && !validDate(toDate))) {
      throw new ApiError(400, "Enter valid date filters");
    }
    if (fromDate && toDate && fromDate > toDate) {
      throw new ApiError(400, "Start date must be on or before end date");
    }
    const filtered = requests.filter((item) =>
      (!status || item.status === status)
      && (!methodFilter || item.method === methodFilter)
      && (!hazard || item.hazard === Number(hazard))
      && (!fromDate || item.created_at.slice(0, 10) >= fromDate)
      && (!toDate || item.created_at.slice(0, 10) <= toDate));
    return response(filtered.map(publicRequest));
  }

  const requestMatch = path.match(/^\/api\/admin\/requests\/([^/]+)$/);
  if (requestMatch && ["POST", "DELETE"].includes(method)) {
    requireUser(session, "admin");
    const itemId = decodeURIComponent(requestMatch[1]);
    if (method === "DELETE") {
      const item = await removeRequest(fetchImpl, env, itemId);
      if (!item) throw new ApiError(404, "Request not found");
      await addAudit(fetchImpl, env, session, itemId, "deleted", requestReference(item));
      return response({ status: "success", id: itemId });
    }

    const item = await getRequest(fetchImpl, env, itemId);
    if (!item) throw new ApiError(404, "Request not found");
    const data = await jsonBody(request);
    if (!["approve", "reject", "complete"].includes(data.action)) {
      throw new ApiError(400, "Invalid action");
    }
    if (data.action === "reject") {
      if (typeof data.reason !== "string" || !data.reason.trim()) {
        throw new ApiError(400, "A rejection reason is required");
      }
      item.rejection_reason = data.reason.trim();
      if (item.rejection_reason.length > 500) {
        throw new ApiError(400, "The rejection reason must be 500 characters or fewer");
      }
    }
    if (data.action === "complete") {
      if (item.status !== "Approved") {
        throw new ApiError(400, "Only approved requests can be completed");
      }
      item.status = "Completed";
      item.completed_at = localIsoSeconds();
      await saveRequest(fetchImpl, env, item);
      await addAudit(fetchImpl, env, session, itemId, "completed", requestReference(item));
      return response({ status: "success", request: publicRequest(item) });
    }

    item.status = data.action === "approve" ? "Approved" : "Rejected";
    const timestamp = localIsoSeconds();
    if (data.action === "approve") item.approved_at = timestamp;
    else item.rejected_at = timestamp;
    if (data.action === "approve") {
      const hubData = await loadHubs(fetchImpl, env);
      item.route = await requestRoute(item, hubData, fetchImpl);
      if (item.method === "pickup") {
        const requests = await allRequests(fetchImpl, env);
        item.queue_number = requests.filter((other) =>
          other.id !== itemId
          && other.method === "pickup"
          && other.status === "Approved").length + 1;
      }
    }
    await saveRequest(fetchImpl, env, item);
    await addAudit(
      fetchImpl,
      env,
      session,
      itemId,
      data.action === "approve" ? "approved" : "rejected",
      requestReference(item),
    );
    return response({ status: "success", request: publicRequest(item) });
  }

  if (path === "/api/inventory" && method === "GET") {
    requireUser(session, "admin");
    const requests = await allRequests(fetchImpl, env);
    const grouped = new Map();
    for (const item of requests) {
      if (item.status !== "Completed") continue;
      if (!grouped.has(item.category)) grouped.set(item.category, []);
      grouped.get(item.category).push({
        id: item.id,
        item: item.item,
        name: item.name,
        weight: item.weight,
        hazard: item.hazard,
      });
    }
    return response([...grouped]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([category, items]) => ({ category, items })));
  }

  if (path === "/api/admin/inventory-summary" && method === "GET") {
    requireUser(session, "admin");
    const requests = await allRequests(fetchImpl, env);
    const grouped = new Map();
    for (const item of requests) {
      if (item.status !== "Completed") continue;
      if (!grouped.has(item.category)) grouped.set(item.category, []);
      grouped.get(item.category).push(item);
    }
    const categories = [...grouped]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([category, items]) => ({
        category,
        item_count: items.length,
        total_weight: Number(items.reduce((sum, item) => sum + item.weight, 0).toFixed(2)),
        hazard_total: items.reduce((sum, item) => sum + item.hazard, 0),
      }));
    return response({
      categories,
      total_items: categories.reduce((sum, category) => sum + category.item_count, 0),
      total_weight: Number(categories.reduce((sum, category) => sum + category.total_weight, 0).toFixed(2)),
    });
  }

  const auditMatch = path.match(/^\/api\/admin\/audit\/([^/]+)$/);
  if (auditMatch && method === "DELETE") {
    requireUser(session, "admin");
    const auditId = decodeURIComponent(auditMatch[1]);
    if (!/^[1-9]\d*$/.test(auditId)) {
      throw new ApiError(404, "Audit entry not found");
    }
    const query = { select: "id", id: `eq.${auditId}`, limit: "1" };
    const existing = await supabaseRequest(fetchImpl, env, "audit_log", { query });
    if (!existing?.length) throw new ApiError(404, "Audit entry not found");
    await supabaseRequest(fetchImpl, env, "audit_log", {
      method: "DELETE",
      query: { id: `eq.${auditId}` },
    });
    return response({ status: "success", audit_id: auditId });
  }

  if (path === "/api/admin/audit" && method === "GET") {
    requireUser(session, "admin");
    const [rows, requests] = await Promise.all([
      supabaseRequest(fetchImpl, env, "audit_log", {
        query: { select: "id,data", order: "created_at.desc" },
      }),
      allRequests(fetchImpl, env),
    ]);
    const requestNumbers = new Map(requests.map((item) => [item.id, requestReference(item)]));
    return response((rows || []).map((row) => ({
      ...row.data,
      request_number: row.data.request_number
        || requestNumbers.get(row.data.request_id)
        || requestReference({ id: row.data.request_id }),
      audit_id: String(row.id),
    })));
  }

  const categoryMatch = path.match(/^\/api\/inventory\/(.+)$/);
  if (categoryMatch && method === "GET") {
    requireUser(session, "admin");
    const category = decodeURIComponent(categoryMatch[1]);
    const requests = await allRequests(fetchImpl, env);
    const items = requests
      .filter((item) => item.status === "Completed" && item.category === category)
      .map((item) => ({
        id: item.id,
        item: item.item,
        name: item.name,
        weight: item.weight,
        hazard: item.hazard,
      }));
    if (!items.length) throw new ApiError(404, "Category not found");
    return response({ category, items });
  }

  if (path === "/api/priority-queue/peek" && method === "GET") {
    requireUser(session, "admin");
    const requests = await allRequests(fetchImpl, env);
    const item = requests
      .filter((requestItem) => requestItem.status === "Pending")
      .map((requestItem, index) => ({
        id: requestItem.id,
        donor: requestItem.name,
        category: requestItem.category,
        weight: requestItem.weight,
        hazard: requestItem.hazard,
        urgency: requestItem.urgency,
        station: "Pending",
        priority_score: priorityScore(requestItem),
        index,
      }))
      .sort((first, second) =>
        second.priority_score - first.priority_score || first.index - second.index)[0];
    if (item) delete item.index;
    return response(item || {});
  }

  throw new ApiError(404, "Not found");
}

export function createHandler({
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  return async function handler(request) {
    try {
      return await handleApi(request, fetchImpl, env);
    } catch (error) {
      if (error instanceof ApiError) {
        return response({ error: error.message }, error.status);
      }
      console.error("EcoRoute API request failed", error);
      return response({ error: "Internal server error" }, 500);
    }
  };
}

export const config = {
  path: "/api/*",
};

export default createHandler();

// End-to-end check of the API against a running server.
// Usage: API=http://localhost:3000 npm test   (uses a fresh database)
const API = process.env.API || "http://localhost:3000";
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log("  ok  " + label); } else { fail++; console.log("  FAIL " + label); } }

async function call(method, path, token, body, isForm) {
  const headers = {};
  if (token) headers.authorization = "Bearer " + token;
  if (body && !isForm) headers["content-type"] = "application/json";
  const r = await fetch(API + path, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const rnd = Math.random().toString(36).slice(2, 8);

const ownerEmail = process.env.OWNER_EMAIL;
const o = await call("POST", "/auth/signup", null, { email: ownerEmail, password: "password123" });
ok(o.status === 201 && o.json.token, "owner signs up");
const T = o.json.token;
const m = await call("POST", "/auth/signup", null, { email: "maya" + rnd + "@test.com", password: "password123" });
const M = m.json.token;
ok((await call("POST", "/auth/signup", null, { email: ownerEmail, password: "password123" })).status === 400, "duplicate email rejected");
ok((await call("POST", "/auth/login", null, { email: ownerEmail, password: "wrong-pass" })).status === 401, "wrong password rejected");
ok((await call("GET", "/crews", T)).status === 403, "terms required before using the app");

ok((await call("POST", "/me/consent", T, { adult: true, terms: true, health: true })).status === 200, "owner consents with health on");
ok((await call("POST", "/me/consent", M, { adult: true, terms: true, health: false })).status === 200, "member consents, health off");
let me = (await call("PATCH", "/me", T, { name: "LG", onboarded: true })).json;
ok(me.isOwner === true && me.consentCurrent, "owner flagged as owner");
await call("PATCH", "/me", M, { name: "Maya", onboarded: true });

const c = await call("POST", "/crews", T, { name: "Test Crew " + rnd, blurb: "Testing", weeklyGoal: 10 });
ok(c.status === 201, "owner creates a crew");
ok((await call("POST", "/crews", M, { name: "Nope " + rnd, weeklyGoal: 5 })).status === 403, "member can't create a crew");
const crewId = c.json.id;
await call("POST", "/crews/" + crewId + "/join", T);
await call("POST", "/crews/" + crewId + "/join", M);
ok((await call("PATCH", "/crews/" + crewId, T, { name: "Renamed " + rnd, blurb: "", weeklyGoal: 12 })).json.name === "Renamed " + rnd, "owner renames crew");

const day = new Date().toISOString().slice(0, 10);
ok((await call("PUT", "/me/days/" + day, M, { steps: 5000 })).status === 403, "health data blocked when health tracking is off");
ok((await call("PUT", "/me/days/" + day, M, { intention: "Push" })).status === 200, "intention allowed without health");
ok((await call("PUT", "/me/days/" + day, T, { steps: 8123, water: 3, weight: 82.4 })).json.steps === 8123, "owner logs steps, water, weight");
const fd = await call("POST", "/me/food", T, { date: day, meal: "breakfast", items: [{ name: "Oats", kcal: 166, p: 6, c: 28, f: 4 }] });
ok(fd.status === 201 && fd.json.items[0].meal === "breakfast", "food logged to breakfast");
ok((await call("PATCH", "/me/food/" + fd.json.items[0].id, T, { meal: "snack" })).json.meal === "snack", "food moved to snacks");
const s = await call("POST", "/me/sessions", M, { date: day, type: "Run", minutes: 30, why: "clear head", feeling: "Calmer", shared: true });
ok(s.status === 201 && s.json.why === "", "session shared; why/feeling stripped with health off");
const days = (await call("GET", "/me/days?from=" + day + "&to=" + day, T)).json;
ok(days.days[day].food.length === 1 && days.days[day].steps === 8123, "days endpoint returns log");

const feed = (await call("GET", "/crews/" + crewId + "/feed", T)).json;
ok(feed.length === 1 && feed[0].name === "Maya", "crew feed shows shared session");
ok((await call("POST", "/crews/sessions/" + feed[0].id + "/cheer", T)).status === 200, "owner cheers Maya");
ok((await call("POST", "/crews/sessions/" + feed[0].id + "/cheer", M)).status === 400, "can't cheer own session");

const msg = await call("POST", "/crews/" + crewId + "/messages", M, { text: "Morning all" });
ok(msg.status === 201 && msg.json.name === "Maya", "message posted");
ok((await call("GET", "/crews/" + crewId + "/messages", T)).json.length === 1, "messages listed");
ok((await call("DELETE", "/crews/messages/" + msg.json.id, T)).status === 200, "owner removes a message");

ok((await call("PUT", "/me/answer", M, { text: "Two walks" })).status === 200, "weekly answer saved");
ok((await call("GET", "/crews/" + crewId + "/answers", T)).json[0].text === "Two walks", "answer on crew wall");

const when = new Date(Date.now() + 86400000).toISOString();
const ev = await call("POST", "/events", T, { title: "Test walk", when, place: "Albert Park", capacity: 2 });
ok(ev.status === 201 && ev.json.canManage, "owner creates event");
ok((await call("POST", "/events/" + ev.json.id + "/rsvp", M)).status === 403, "RSVP needs event terms");
await call("POST", "/me/event-terms", M);
ok((await call("POST", "/events/" + ev.json.id + "/rsvp", M)).status === 200, "RSVP after terms");
const open = await call("POST", "/events/" + ev.json.id + "/checkin/open", T);
ok(open.json.code && open.json.code.length === 5, "host gets a check-in code");
ok((await call("POST", "/events/" + ev.json.id + "/checkin/open", M)).status === 403, "member can't open check-in");
ok((await call("POST", "/events/" + ev.json.id + "/checkin", M, { code: "ZZZZZ" })).status === 400, "wrong code rejected");
ok((await call("POST", "/events/" + ev.json.id + "/checkin", M, { code: open.json.code.toLowerCase() })).status === 200, "right code checks in");
await call("POST", "/me/event-terms", T);
await call("POST", "/events/" + ev.json.id + "/checkin", T, { code: open.json.code });
const sum = (await call("GET", "/me/summary", M)).json;
ok(sum.checkins === 1 && sum.movedWith.length === 1 && sum.movedWith[0].name === "LG", "summary counts check-ins and moved-with");

ok((await call("PATCH", "/me", T, { body: { goal: "lose", height: 170, weight: 50, sex: "male", safeConfirmed: true } })).status === 400, "no weight-loss goal when underweight");
ok((await call("PATCH", "/me", T, { body: { goal: "lose", height: 170, weight: 82, sex: "male", age: 34, activity: "light", pace: "gentle", safeConfirmed: true } })).status === 200, "healthy weight-loss goal saved");

ok((await call("POST", "/reports", M, { about: me.id, kind: "post", reason: "Spam or selling" })).status === 201, "member reports something");
ok((await call("GET", "/admin/reports", M)).status === 403, "member can't read reports");
ok((await call("GET", "/admin/reports", T)).json.length === 1, "owner reads reports");
const members = (await call("GET", "/admin/members", T)).json;
const mayaId = members.find((x) => x.name === "Maya").id;
ok((await call("POST", "/admin/ambassadors/" + mayaId, T)).status === 200, "owner makes Maya an ambassador");
ok((await call("POST", "/crews", M, { name: "Maya Crew " + rnd, weeklyGoal: 5 })).status === 201, "ambassador can create a crew");

// tiny valid PNG
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const fdForm = new FormData(); fdForm.append("kind", "avatar"); fdForm.append("file", new Blob([png], { type: "image/png" }), "a.png");
const up = await call("POST", "/uploads", M, fdForm, true);
ok(up.status === 201 && up.json.url.startsWith("/media/"), "avatar upload");
const img = await fetch(API + up.json.url);
ok(img.status === 200 && img.headers.get("content-type") === "image/png", "signed media link serves the file");
ok((await fetch(API + "/media/" + up.json.id + "?exp=1&sig=x")).status === 403, "bad media signature refused");
const fake = new FormData(); fake.append("kind", "chat"); fake.append("file", new Blob([Buffer.from("not an image")], { type: "image/png" }), "x.png");
ok((await call("POST", "/uploads", M, fake, true)).status === 400, "fake image rejected by content check");

ok((await call("POST", "/ai/coach", T, { messages: [{ role: "user", content: "hi" }] })).status === 503 || !!process.env.ANTHROPIC_API_KEY, "coach off without API key");

ok((await call("DELETE", "/me", M)).status === 200, "member deletes account");
ok((await call("GET", "/me", M)).status === 401, "deleted account can't log in");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

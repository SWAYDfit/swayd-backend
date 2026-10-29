// Live updates for crew chat and feed using Server-Sent Events.
// Single-server hub: fine for one Railway instance. Swap for Redis pub/sub if you scale out.
const rooms = new Map(); // crewId -> Set of { res, userId }

export function subscribe(crewId, userId, res) {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  const entry = { res, userId };
  if (!rooms.has(crewId)) rooms.set(crewId, new Set());
  rooms.get(crewId).add(entry);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  res.on("close", () => {
    clearInterval(ping);
    const set = rooms.get(crewId);
    if (set) { set.delete(entry); if (!set.size) rooms.delete(crewId); }
  });
}

export function publish(crewId, type, data) {
  const set = rooms.get(crewId);
  if (!set) return;
  const line = "event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const { res } of set) res.write(line);
}

// Remove a user from a crew's stream (e.g. they switched crews)
export function kick(crewId, userId) {
  const set = rooms.get(crewId);
  if (!set) return;
  for (const e of set) if (e.userId === userId) { e.res.end(); set.delete(e); }
}

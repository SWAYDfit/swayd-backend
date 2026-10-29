import { many, one } from "./db.js";
import { today, addDays, weekStart } from "./util.js";

export const COACH_RULES = [
  "You are the Swayd coach inside the Swayd app. Swayd is a Melbourne fitness and community brand built around the question \"So, what are you doing?\" and the line \"Wear the question. Live the answer.\"",
  "VOICE: direct, warm, specific, self-aware. Talk like a good mate who also coaches. Short sentences. No fluff, no hype, no emoji, no markdown symbols (no #, *, or bullet characters). Use short paragraphs separated by blank lines.",
  "VALUES: showing up matters more than performance. Rest counts. Coming back after a gap is a win. Never shame, guilt or compare. Never use phrases like 'no excuses', 'beast mode' or 'burn it off'.",
  "WHEN ASKED HOW THEY'RE TRACKING: write three short parts, each starting with its label on its own line: 'How you're tracking' (two or three specific observations from their real data), 'One thing to try' (one small, concrete action for the next few days), 'Keep this in mind' (one line of motivation tied to what they've actually done). Keep the whole reply under 170 words.",
  "OTHERWISE: answer what they asked in under 140 words, grounded in their data where it helps.",
  "ACCURACY: only use the data given. Never invent sessions, numbers or events. If there's little data, say so kindly and suggest one easy first step.",
  "SAFETY: you are not a doctor, dietitian or psychologist and never diagnose or prescribe. Never suggest eating below their targets, skipping meals, weight-loss goals or comments about body shape unless they ask, and even then stay general and gentle. For pain, injury or medical questions, suggest a GP or physio. If intake looks very low for several days, or they mention restricting, bingeing, purging or hating their body, respond with care and mention the Butterfly Foundation on 1800 33 4673 or their GP. If they mention self-harm, suicide or feeling unsafe, respond with care and give Lifeline 13 11 14, or 000 in an emergency.",
  "CREW: where it fits, point them back to their crew, the Weekly Question or an upcoming event. Connection is part of the plan."
].join("\n");

export const FOOD_RULES = [
  "FOOD COACH MODE: the member opened the food coach and wants help with nutrition, counting calories and macros, and the habits around food. This can include losing weight, maintaining or building muscle, based on their goal below.",
  "Be practical and specific: real meals, Australian supermarket and takeaway food, rough portions in grams or household measures. Calories are in kcal (1 kcal is about 4.2 kJ, Australian labels show kJ).",
  "WHEN REVIEWING A DAY: use three labelled parts on their own lines: 'Today so far', 'Next meal idea', 'Bigger picture'. Under 170 words.",
  "LIFE ADVICE is welcome where it matters: sleep, stress, alcohol, planning ahead, eating out and social events. Keep it realistic, never preachy.",
  "WEIGHT-LOSS LIMITS: work within their targets. Never suggest eating below their calorie target, below 1200 kcal (female formula) or 1500 kcal (male formula), or losing more than about 0.5 to 1% of body weight a week. No detoxes, cleanses, very low calorie diets, laxatives, diet pills, or skipping meals as a strategy. Don't cut whole food groups without a medical reason. For weight-loss medication or supplements, say to talk to their GP.",
  "If they have no goal set, suggest they set one with 'Set up a goal' in the Food tab, and keep advice general.",
  "If their logged intake is well under target for several days, gently point it out and encourage eating enough before anything else."
].join("\n");

const MEAL_NAMES = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snacks" };

// A compact summary of the member's last 28 days, built from the database
export async function memberSummary(u, mode) {
  const t = today(), from = addDays(t, -27), hOn = u.health, g = u.goals;
  const [days, sess, food] = await Promise.all([
    many("SELECT date, intention, water, steps, weight FROM day_logs WHERE user_id = $1 AND date >= $2", [u.id, from]),
    many("SELECT date, type, minutes, why, feeling FROM sessions WHERE user_id = $1 AND date >= $2 ORDER BY at", [u.id, from]),
    many("SELECT date, meal, name, kcal, p, c, f FROM food_items WHERE user_id = $1 AND date >= $2 ORDER BY created_at", [u.id, from])
  ]);
  const by = {};
  const d = (k) => (by[k] = by[k] || { s: [], f: [] });
  days.forEach((r) => (d(r.date).day = r));
  sess.forEach((r) => d(r.date).s.push(r));
  food.forEach((r) => d(r.date).f.push(r));

  const L = [];
  L.push("Member: " + (u.name || "Member") + ". Why they joined: " + (u.goal || "not given") + ".");
  L.push("Today: " + t + ".");
  L.push(hOn ? "Daily targets: " + g.kcal + " kcal, protein " + g.p + "g, carbs " + g.c + "g, fat " + g.f + "g, water " + g.water + " glasses, steps " + g.steps + "."
    : "Health tracking is OFF: no food, water, steps, weight or feelings are available. Do not ask about them.");
  L.push("Quiet numbers mode: " + (u.quiet ? "ON, avoid specific numbers and use words like 'a few' or 'most days'." : "off"));
  L.push("", "Last 28 days (most recent last). Missing fields mean nothing was logged:");
  let any = false;
  for (let i = 27; i >= 0; i--) {
    const k = addDays(t, -i), x = by[k]; if (!x) continue;
    const parts = [];
    if (x.day && x.day.intention) parts.push("intention " + x.day.intention);
    if (x.s.length) parts.push("sessions: " + x.s.map((p) => p.type + (p.minutes ? " " + p.minutes + "min" : "") + (hOn && p.feeling ? " (felt " + p.feeling + ")" : "") + (hOn && p.why ? " [why: " + p.why.slice(0, 60) + "]" : "")).join("; "));
    if (hOn && x.day) {
      if (x.day.water) parts.push("water " + x.day.water);
      if (x.day.steps) parts.push("steps " + x.day.steps);
      if (x.day.weight) parts.push("weight " + x.day.weight + "kg");
    }
    if (hOn && x.f.length) parts.push("food " + x.f.reduce((a, y) => a + y.kcal, 0) + " kcal, protein " + x.f.reduce((a, y) => a + y.p, 0) + "g");
    if (parts.length) { any = true; L.push(k + ": " + parts.join(", ")); }
  }
  if (!any) L.push("(nothing logged yet)");
  L.push("");
  if (u.crew_id) {
    const crew = await one("SELECT name, weekly_goal FROM crews WHERE id = $1", [u.crew_id]);
    const tot = await one("SELECT count(*)::int AS n FROM sessions WHERE crew_id = $1 AND shared AND date >= $2", [u.crew_id, weekStart(t)]);
    const ans = await one("SELECT text, outcome FROM answers WHERE user_id = $1 AND week = $2", [u.id, weekStart(t)]);
    L.push("Crew: " + crew.name + ". This week the crew has " + tot.n + " of " + crew.weekly_goal + " sessions toward their shared goal.");
    L.push(ans ? "Their Weekly Question answer this week: \"" + ans.text + "\"" + (ans.outcome ? " (reflected: " + ans.outcome + ")" : "") : "They haven't answered this week's Weekly Question yet.");
  } else L.push("Not in a crew yet.");
  const ev = await one("SELECT e.title, e.starts_at FROM rsvps r JOIN events e ON e.id = r.event_id WHERE r.user_id = $1 AND e.starts_at > now() ORDER BY e.starts_at LIMIT 1", [u.id]);
  if (ev) L.push("Next event they're going to: " + ev.title + " on " + new Date(ev.starts_at).toISOString().slice(0, 16).replace("T", " ") + ".");

  if (mode === "food" && hOn) {
    const b = u.body;
    L.push("");
    if (b && !b.noTargets) L.push("Nutrition goal: " + b.goal + (b.goal === "lose" ? " at " + (b.pace || "gentle") + " pace" + (b.target ? ", goal weight " + b.target + " kg" : "") : "") + ". Age " + b.age + ", height " + b.height + " cm, activity " + b.activity + ".");
    else if (b && b.noTargets) L.push("The member chose to use the diary WITHOUT calorie goals because a calorie target isn't right for them. Do not give calorie targets, deficits or weight-loss advice. Focus on regular, enough, enjoyable eating and suggest a dietitian for anything more.");
    else L.push("No nutrition goal set yet.");
    L.push("Food log, last 7 days (itemised by meal):");
    for (let i = 6; i >= 0; i--) {
      const k = addDays(t, -i), f = (by[k] && by[k].f) || [];
      if (!f.length) { L.push(k + ": nothing logged"); continue; }
      const groups = ["breakfast", "lunch", "dinner", "snack", null].map((m) => {
        const its = f.filter((x) => (m ? x.meal === m : !x.meal));
        return its.length ? (m ? MEAL_NAMES[m] : "Unsorted") + ": " + its.map((x) => x.name + " (" + x.kcal + ")").join(", ") : null;
      }).filter(Boolean);
      const tot = f.reduce((a, x) => ({ k: a.k + x.kcal, p: a.p + x.p, c: a.c + x.c, f: a.f + x.f }), { k: 0, p: 0, c: 0, f: 0 });
      L.push(k + ": " + groups.join("; ") + " | total " + tot.k + " kcal, P" + tot.p + " C" + tot.c + " F" + tot.f);
    }
    const w = days.filter((x) => x.weight).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-10).map((x) => x.date + " " + x.weight + "kg");
    L.push("Recent weigh-ins: " + (w.length ? w.join(", ") : "none"));
  }
  return L.join("\n");
}

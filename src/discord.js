// Discord webhook alerts.
//
// Alerting philosophy: a hunt alert that fires every day is a notification you learn to
// swipe away, which makes it worse than no alert. So this fires only when a slot crosses
// a configurable score threshold, dedupes per date/slot/kind, and by default stays inside
// the 7-day window where NWS forecasts are actually reliable.

import { getDb } from './db.js';
import { nowIso, weekday } from './timeutil.js';

const COLORS = { buck: 0xf0b429, general: 0x16c784, test: 0x5ac8fa, error: 0xea3943, heartbeat: 0x8a9a6b };

/**
 * The single exit point for every Discord post, which is why the send is logged here
 * rather than at each call site: a sender added later is counted without remembering to.
 * A skipped post writes nothing, so a disabled webhook never looks like a successful send.
 */
export async function post(cfg, payload, kind = 'other', detail = null) {
  if (!cfg.discord?.enabled) return { skipped: 'discord disabled in config' };
  const url = cfg.discord.webhookUrl;
  if (!url || url.includes('YOUR_WEBHOOK')) return { skipped: 'no webhook configured' };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.discord.username ?? 'DeerHunter', ...payload }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text().catch(() => '')}`);

  // Logging failure must not turn a delivered message into a thrown error: the post has
  // already landed in the channel by this point and cannot be taken back.
  try {
    getDb().prepare('INSERT INTO webhook_log (kind, detail, sent_at) VALUES (?,?,?)')
      .run(kind, detail, nowIso());
  } catch { /* the message went out; the bookkeeping is best-effort */ }

  return { ok: true };
}

/** Days since anything at all was posted, or null if nothing ever has been. */
export function daysSinceLastPost() {
  const row = getDb().prepare('SELECT MAX(sent_at) AS t FROM webhook_log').get();
  if (!row?.t) return null;
  return (Date.now() - Date.parse(row.t)) / 86400000;
}

const bar = (score) => {
  const filled = Math.round(score);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
};

function describeSlot(s, cfg) {
  const wx = s.weather ?? {};
  const lines = [];
  lines.push(`**Buck** ${s.buckScore.toFixed(1)}  \`${bar(s.buckScore)}\``);
  lines.push(`**Deer** ${s.generalScore.toFixed(1)}  \`${bar(s.generalScore)}\``);
  lines.push('');
  lines.push(`${s.rut.phaseLabel} · day ${s.rut.offset >= 0 ? '+' : ''}${s.rut.offset} from peak`);

  const bits = [];
  if (wx.tempF != null) {
    const dep = wx.tempNormalF != null ? ` (${wx.tempF - wx.tempNormalF >= 0 ? '+' : ''}${Math.round(wx.tempF - wx.tempNormalF)} vs normal)` : '';
    bits.push(`${Math.round(wx.tempF)}°F${dep}`);
  }
  if (wx.windMph != null) bits.push(`wind ${Math.round(wx.windMph)} mph ${s.windCompass ?? ''}`.trim());
  if (wx.precipProb != null) bits.push(`${Math.round(wx.precipProb)}% precip`);
  if (bits.length) lines.push(bits.join(' · '));

  if (s.recommendedStands?.length) {
    const safe = s.recommendedStands.filter((x) => x.verdict === 'safe');
    const caution = s.recommendedStands.filter((x) => x.verdict === 'caution');
    if (safe.length) lines.push(`\n**Scent-safe:** ${safe.map((x) => `${x.label} (${x.buckScore.toFixed(1)})`).join(', ')}`);
    else if (caution.length) lines.push(`\n**Nothing fully clear.** Best available: ${caution.map((x) => x.label).join(', ')}`);
    else lines.push('\n**No scent-safe stand** on this wind.');
  }

  if (s.confidence === 'climatology') lines.push('\n_Outlook only: past the NWS forecast horizon, this is rut curve plus climate normals._');
  return lines.join('\n');
}

export async function sendAlerts(cfg, slots) {
  if (!slots.length) return { sent: 0 };
  const db = getDb();
  const embeds = slots.slice(0, 6).map((s) => ({
    title: `${weekday(s.date)} ${s.date} ${s.slot} · ${s.kind === 'buck' ? 'Buck' : 'Deer activity'} ${s[s.kind === 'buck' ? 'buckScore' : 'generalScore'].toFixed(1)}`,
    description: describeSlot(s, cfg),
    color: COLORS[s.kind] ?? COLORS.buck,
  }));

  const n = slots.length;
  const bt = cfg.alerts.buckThreshold ?? cfg.alerts.scoreThreshold;
  const gt = cfg.alerts.generalThreshold ?? cfg.alerts.scoreThreshold;
  await post(cfg, {
    content: n === 1
      ? `One slot crossed your threshold (buck ${bt} / deer ${gt}).`
      : `${n} slots crossed your thresholds in the next ${cfg.alerts.windowDaysUsed ?? cfg.forecast.forecastConfidenceDays} days (buck ${bt} / deer ${gt}).`,
    embeds,
  }, 'alert', `${n} slot${n === 1 ? '' : 's'}`);

  const mark = db.prepare(`
    INSERT INTO alerts_sent (key, date, slot, kind, score, sent_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET score = excluded.score, sent_at = excluded.sent_at
  `);
  for (const s of slots) {
    mark.run(`${s.date}|${s.slot}|${s.kind}`, s.date, s.slot, s.kind,
      s.kind === 'buck' ? s.buckScore : s.generalScore, nowIso());
  }
  return { sent: slots.length };
}

// Suppress anything already announced inside the cooldown, so a high Saturday does not
// get posted again every morning for the rest of the week.
export function filterAlreadySent(slots, cooldownHours) {
  const db = getDb();
  const cutoff = new Date(Date.now() - cooldownHours * 3600000).toISOString();
  return slots.filter((s) => {
    const row = db.prepare('SELECT sent_at FROM alerts_sent WHERE key = ?').get(`${s.date}|${s.slot}|${s.kind}`);
    return !row || row.sent_at < cutoff;
  });
}

export async function testWebhook(cfg) {
  return post(cfg, {
    content: null,
    embeds: [{
      title: 'DeerHunter connected',
      description: `Watching **${cfg.property.name}** (${cfg.property.county}).\nSeason ${cfg.season.start} to ${cfg.season.end}.`
        + `\nAlerting above **${cfg.alerts.buckThreshold ?? cfg.alerts.scoreThreshold} buck** / **${cfg.alerts.generalThreshold ?? cfg.alerts.scoreThreshold} deer**`
        + ` inside the ${cfg.forecast.forecastConfidenceDays}-day forecast window.`,
      color: COLORS.test,
    }],
  }, 'test');
}

/**
 * Quiet-period check-in.
 *
 * The tool runs as a hand-started process on a laptop, so silence is ambiguous: it means
 * either nothing crossed the thresholds or nothing is running. This resolves that. A
 * message that arrives says the refresh ran and the webhook works; one that stops
 * arriving is the signal something needs restarting.
 *
 * It carries the best slot it can see so it is worth opening rather than purely a ping.
 */
export async function sendHeartbeat(cfg, { quietDays, best, scored } = {}) {
  const lines = [];
  const quiet = quietDays == null ? null : Math.floor(quietDays);
  lines.push(quiet == null
    ? 'First check-in since the webhook was configured.'
    : `Nothing has crossed your thresholds in ${quiet} day${quiet === 1 ? '' : 's'}, so this is a liveness check rather than a hunt alert.`);

  if (best) {
    lines.push('');
    lines.push(`**Best ahead:** ${weekday(best.date)} ${best.date} ${best.slot} · buck **${best.buckScore.toFixed(1)}** / deer **${best.generalScore.toFixed(1)}**`);
    lines.push(`_Still under your ${cfg.alerts.buckThreshold ?? cfg.alerts.scoreThreshold} buck / ${cfg.alerts.generalThreshold ?? cfg.alerts.scoreThreshold} deer thresholds._`);
  } else {
    lines.push('');
    lines.push('_No scored slots in the forecast window right now._');
  }

  if (scored != null) lines.push(`\nRefresh scored ${scored} slots.`);

  return post(cfg, {
    content: null,
    embeds: [{ title: 'DeerHunter still running', description: lines.join('\n'), color: COLORS.heartbeat }],
  }, 'heartbeat', quiet == null ? 'first' : `${quiet}d quiet`);
}

#!/usr/bin/env node

// cc-session-stats — See how much time you spend with Claude Code
// Zero dependencies. Scans ~/.claude/projects/ session transcripts.

import { readdir, stat, open } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// ── Config ──────────────────────────────────────────────────────

const SESSION_GAP_HOURS = 0.5; // 30min gap = new session within a file
const HEALTH_WARN_SESSION_HOURS = 3;
const HEALTH_WARN_CONSECUTIVE_DAYS = 7;
// Sessions >8h are likely autonomous/continuous runs (cc-loop etc), not single interactive sessions
const MAX_INTERACTIVE_SESSION_HOURS = 8;

// ── Color helpers ───────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
};

function bar(pct, width = 20) {
  const filled = Math.round(pct * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Read first and last line of a file ──────────────────────────

async function readFirstLastLine(filePath) {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    // Read first line
    const { bytesRead: firstBytes } = await fh.read(buf, 0, 8192, 0);
    if (firstBytes === 0) return null;
    const firstChunk = buf.toString('utf8', 0, firstBytes);
    const firstNewline = firstChunk.indexOf('\n');
    const firstLine = firstNewline >= 0 ? firstChunk.substring(0, firstNewline) : firstChunk;

    // Read last line — seek to end
    const fileStat = await fh.stat();
    const fileSize = fileStat.size;
    if (fileSize < 2) return { firstLine, lastLine: firstLine };

    const readSize = Math.min(65536, fileSize);
    const tailBuf = Buffer.alloc(readSize);
    const { bytesRead: tailBytes } = await fh.read(tailBuf, 0, readSize, fileSize - readSize);
    const tailChunk = tailBuf.toString('utf8', 0, tailBytes);
    const lines = tailChunk.split('\n').filter(l => l.trim());
    const lastLine = lines[lines.length - 1] || firstLine;

    return { firstLine, lastLine };
  } finally {
    await fh.close();
  }
}

function parseTimestamp(jsonLine) {
  try {
    const data = JSON.parse(jsonLine);
    const ts = data.timestamp || data.ts;
    if (ts) return new Date(ts);
  } catch {}
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────

function cleanProjectName(dirName) {
  // "-home-namakusa-projects-cc-loop" → "cc-loop"
  // "-home-namakusa" → "~"
  // "-tmp-something" → "/tmp/..."
  if (dirName.startsWith('-tmp')) {
    return '/tmp';
  }
  const parts = dirName.split('-').filter(Boolean);
  if (parts[0] === 'home' && parts.length >= 2) {
    const rest = parts.slice(2);
    if (rest.length === 0) return '~';
    if (rest[0] === 'projects') rest.shift();
    return rest.join('-') || '~';
  }
  return dirName;
}

// ── Scan sessions ───────────────────────────────────────────────

async function scanSessions(claudeDir) {
  const projectsDir = join(claudeDir, 'projects');
  const sessions = [];

  let projectDirs;
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return sessions;
  }

  async function addSession(filePath, project, sessions) {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.size < 50) return;
    try {
      const result = await readFirstLastLine(filePath);
      if (!result) return;
      const startTs = parseTimestamp(result.firstLine);
      const endTs = parseTimestamp(result.lastLine);
      if (startTs && endTs) {
        const durationMs = endTs - startTs;
        if (durationMs >= 0 && durationMs < 7 * 24 * 60 * 60 * 1000) {
          sessions.push({ project, start: startTs, end: endTs, durationHours: durationMs / (1000 * 60 * 60), sizeBytes: fileStat.size });
        }
      }
    } catch {}
  }

  for (const projDir of projectDirs) {
    const projPath = join(projectsDir, projDir);
    const projStat = await stat(projPath).catch(() => null);
    if (!projStat?.isDirectory()) continue;

    let files;
    try {
      files = await readdir(projPath);
    } catch { continue; }

    // Scan main session files
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(projPath, file);
      await addSession(filePath, cleanProjectName(projDir), sessions);
    }

    // Scan subagent sessions
    for (const file of files) {
      const subPath = join(projPath, file, 'subagents');
      const subStat = await stat(subPath).catch(() => null);
      if (!subStat?.isDirectory()) continue;
      try {
        const subFiles = await readdir(subPath);
        for (const sf of subFiles) {
          if (!sf.endsWith('.jsonl')) continue;
          await addSession(join(subPath, sf), cleanProjectName(projDir), sessions);
        }
      } catch {}
    }
  }

  return sessions.sort((a, b) => a.start - b.start);
}

// ── Analyze ─────────────────────────────────────────────────────

function analyze(sessions) {
  if (sessions.length === 0) return null;

  const totalHours = sessions.reduce((s, x) => s + x.durationHours, 0);
  const avgDuration = totalHours / sessions.length;
  // For "Longest Session", prefer sessions under MAX_INTERACTIVE_SESSION_HOURS.
  // Very long sessions (>8h) are typically continuous autonomous runs, not a human sitting still.
  const interactiveSessions = sessions.filter(s => s.durationHours <= MAX_INTERACTIVE_SESSION_HOURS);
  const maxSessionBase = interactiveSessions.length > 0 ? interactiveSessions : sessions;
  const maxSession = maxSessionBase.reduce((max, s) => s.durationHours > max.durationHours ? s : max, maxSessionBase[0]);
  // Track whether we filtered out any very long sessions
  const hasAutonomousSessions = sessions.some(s => s.durationHours > MAX_INTERACTIVE_SESSION_HOURS);

  // Group by date (local)
  const byDate = {};
  for (const s of sessions) {
    const day = s.start.toLocaleDateString('en-CA'); // YYYY-MM-DD
    if (!byDate[day]) byDate[day] = { sessions: [], hours: 0 };
    byDate[day].sessions.push(s);
    byDate[day].hours += s.durationHours;
  }

  const activeDays = Object.keys(byDate).sort();
  const firstDay = activeDays[0];
  const lastDay = activeDays[activeDays.length - 1];
  const totalDaysSpan = Math.ceil((new Date(lastDay) - new Date(firstDay)) / (1000 * 60 * 60 * 24)) + 1;

  // Hours by day of week
  const dowHours = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const s of sessions) {
    dowHours[s.start.getDay()] += s.durationHours;
  }

  // Hours by hour of day
  const hourBuckets = new Array(24).fill(0);
  for (const s of sessions) {
    hourBuckets[s.start.getHours()] += s.durationHours;
  }

  // Project breakdown
  const projectHours = {};
  for (const s of sessions) {
    const p = s.project;
    projectHours[p] = (projectHours[p] || 0) + s.durationHours;
  }

  // Consecutive days streak
  let maxStreak = 1;
  let currentStreak = 1;
  for (let i = 1; i < activeDays.length; i++) {
    const prev = new Date(activeDays[i - 1]);
    const curr = new Date(activeDays[i]);
    const diffDays = (curr - prev) / (1000 * 60 * 60 * 24);
    if (diffDays === 1) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }

  // Health warnings
  const warnings = [];
  const longSessions = sessions.filter(s => s.durationHours >= HEALTH_WARN_SESSION_HOURS);
  if (longSessions.length > 0) {
    warnings.push({
      level: 'warn',
      msg: `${longSessions.length} session(s) over ${HEALTH_WARN_SESSION_HOURS}h without a break. Your spine has opinions.`,
    });
  }
  if (maxStreak >= HEALTH_WARN_CONSECUTIVE_DAYS) {
    warnings.push({
      level: 'warn',
      msg: `${maxStreak} consecutive days of AI usage. Rest days exist for a reason.`,
    });
  }
  if (avgDuration > 2) {
    warnings.push({
      level: 'info',
      msg: `Average session is ${avgDuration.toFixed(1)}h. The 90-minute focus/break cycle is backed by research.`,
    });
  }
  const avgDailyHours = totalHours / activeDays.length;
  if (avgDailyHours > 6) {
    warnings.push({
      level: 'alert',
      msg: `${avgDailyHours.toFixed(1)}h/day average. That's a full workday of sitting. Stretch. Now.`,
    });
  }

  // Recent 7 days
  const today = new Date().toLocaleDateString('en-CA');
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA');
  const recent7 = activeDays.filter(d => d > sevenDaysAgo && d <= today);
  const recent7Hours = recent7.reduce((sum, d) => sum + byDate[d].hours, 0);

  return {
    totalSessions: sessions.length,
    totalHours,
    avgDuration,
    maxSession,
    hasAutonomousSessions,
    activeDays,
    totalDaysSpan,
    byDate,
    dowHours,
    dowNames,
    hourBuckets,
    projectHours,
    maxStreak,
    warnings,
    firstDay,
    lastDay,
    recent7Days: recent7.length,
    recent7Hours,
    avgDailyHours,
  };
}

// ── JSON output ─────────────────────────────────────────────────

function buildJsonOutput(stats) {
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hoursByDayOfWeek = {};
  for (let i = 0; i < 7; i++) {
    hoursByDayOfWeek[dowNames[i]] = Math.round(stats.dowHours[i] * 100) / 100;
  }

  const topProjects = Object.entries(stats.projectHours)
    .sort((a, b) => b[1] - a[1])
    .map(([name, hours]) => ({ name, hours: Math.round(hours * 100) / 100 }));

  const ms = stats.maxSession;

  return {
    version: '1.0',
    totalSessions: stats.totalSessions,
    totalHours: Math.round(stats.totalHours * 100) / 100,
    activeDays: stats.activeDays.length,
    totalDaysSpan: stats.totalDaysSpan,
    firstSeen: stats.firstDay,
    lastSeen: stats.lastDay,
    averages: {
      perSession: Math.round(stats.avgDuration * 100) / 100,
      perDay: Math.round(stats.avgDailyHours * 100) / 100,
    },
    longestSession: {
      hours: Math.round(ms.durationHours * 100) / 100,
      date: ms.start.toLocaleDateString('en-CA'),
      project: ms.project,
    },
    hoursByDayOfWeek,
    topProjects,
    streak: stats.maxStreak,
    healthWarnings: stats.warnings.map(w => w.msg),
    last7Days: {
      hours: Math.round(stats.recent7Hours * 100) / 100,
      activeDays: stats.recent7Days,
    },
  };
}

// ── Display ─────────────────────────────────────────────────────

function display(stats) {
  const { bold, dim, reset, red, green, yellow, blue, cyan, white, bgRed } = C;

  console.log('');
  console.log(`  ${bold}${cyan}Claude Code Session Stats v1.0.1${reset}`);
  console.log(`  ${'═'.repeat(39)}`);
  console.log(`  ${dim}Scanning: ~/.claude/projects/${reset}`);
  console.log('');

  // Overview
  console.log(`  ${bold}▸ Overview${reset}`);
  console.log(`    Sessions:     ${bold}${stats.totalSessions}${reset}`);
  console.log(`    Total hours:  ${bold}${stats.totalHours.toFixed(1)}h${reset}`);
  console.log(`    Active days:  ${bold}${stats.activeDays.length}${reset} / ${stats.totalDaysSpan} days`);
  console.log(`    First seen:   ${stats.firstDay}`);
  console.log(`    Last seen:    ${stats.lastDay}`);
  console.log('');

  // Averages
  console.log(`  ${bold}▸ Averages${reset}`);
  console.log(`    Per session:  ${stats.avgDuration.toFixed(1)}h`);
  console.log(`    Per day:      ${stats.avgDailyHours.toFixed(1)}h`);
  console.log(`    Last 7 days:  ${stats.recent7Hours.toFixed(1)}h across ${stats.recent7Days} days`);
  console.log('');

  // Longest session
  const ms = stats.maxSession;
  console.log(`  ${bold}▸ Longest Session${reset}`);
  console.log(`    ${yellow}${ms.durationHours.toFixed(1)}h${reset} on ${ms.start.toLocaleDateString('en-CA')} — ${dim}${ms.project}${reset}`);
  if (stats.hasAutonomousSessions) {
    console.log(`    ${dim}(sessions >8h excluded — likely continuous autonomous runs)${reset}`);
  }
  console.log('');

  // Day of week
  console.log(`  ${bold}▸ Hours by Day of Week${reset}`);
  const maxDow = Math.max(...stats.dowHours);
  for (let i = 0; i < 7; i++) {
    const pct = maxDow > 0 ? stats.dowHours[i] / maxDow : 0;
    const hrs = stats.dowHours[i].toFixed(1).padStart(6);
    console.log(`    ${stats.dowNames[i]}  ${bar(pct, 15)} ${hrs}h`);
  }
  console.log('');

  // Hour of day (compact)
  console.log(`  ${bold}▸ Active Hours${reset}`);
  const maxHour = Math.max(...stats.hourBuckets);
  const hourLine = stats.hourBuckets.map(h => {
    if (maxHour === 0) return '░';
    const pct = h / maxHour;
    if (pct > 0.75) return '█';
    if (pct > 0.5) return '▓';
    if (pct > 0.25) return '▒';
    if (pct > 0) return '░';
    return ' ';
  }).join('');
  console.log(`    ${hourLine}`);
  console.log(`    ${dim}0  2  4  6  8  10 12 14 16 18 20 22${reset}`);
  console.log('');

  // Top projects
  console.log(`  ${bold}▸ Top Projects${reset}`);
  const sorted = Object.entries(stats.projectHours).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const maxProj = sorted[0]?.[1] || 1;
  for (const [proj, hrs] of sorted) {
    const pct = hrs / maxProj;
    const label = proj.length > 25 ? proj.substring(0, 22) + '...' : proj.padEnd(25);
    console.log(`    ${label} ${bar(pct, 12)} ${hrs.toFixed(1)}h`);
  }
  console.log('');

  // Streak
  console.log(`  ${bold}▸ Streak${reset}`);
  console.log(`    Longest consecutive days: ${bold}${stats.maxStreak}${reset}`);
  console.log('');

  // Health warnings
  if (stats.warnings.length > 0) {
    console.log(`  ${bold}${yellow}▸ Health Warnings${reset}`);
    for (const w of stats.warnings) {
      const icon = w.level === 'alert' ? `${bgRed}${white} ! ${reset}` :
                   w.level === 'warn' ? `${yellow} ⚠ ${reset}` :
                   `${blue} ℹ ${reset}`;
      console.log(`   ${icon} ${w.msg}`);
    }
    console.log('');
  }

  // Tips
  console.log(`  ${bold}▸ Tips${reset}`);
  if (stats.avgDuration > 1.5) {
    console.log(`    → Set a timer for 90-minute focus blocks with 10-minute breaks.`);
  }
  if (stats.maxStreak >= 5) {
    console.log(`    → Schedule at least one AI-free day per week.`);
  }
  if (stats.avgDailyHours > 4) {
    console.log(`    → Standing desk or walking meetings for non-AI tasks.`);
  }
  console.log(`    → Stretch your hip flexors. They're angry. Trust me.`);
  console.log('');

  // Shareable
  const shareText = `My Claude Code Stats: ${stats.totalSessions} sessions / ${stats.totalHours.toFixed(0)}h total / ${stats.activeDays.length} active days / longest streak: ${stats.maxStreak} days\n#ClaudeCode`;
  console.log(`  ${dim}─── Share ───${reset}`);
  console.log(`  ${dim}${shareText}${reset}`);
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const jsonMode = process.argv.includes('--json');
  const claudeDir = join(homedir(), '.claude');

  // In JSON mode, suppress the spinner to keep stdout clean
  if (!jsonMode) {
    process.stdout.write(`  Scanning sessions...`);
  }
  const sessions = await scanSessions(claudeDir);
  if (!jsonMode) {
    process.stdout.write(`\r                        \r`);
  }

  if (sessions.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: 'No sessions found' }, null, 2));
    } else {
      console.log('  No Claude Code sessions found in ~/.claude/projects/');
      console.log('  Run Claude Code at least once to generate session data.');
    }
    process.exit(1);
  }

  const stats = analyze(sessions);
  if (!stats) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: 'Could not analyze sessions' }, null, 2));
    } else {
      console.log('  Could not analyze sessions.');
    }
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(buildJsonOutput(stats), null, 2));
  } else {
    display(stats);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

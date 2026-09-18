#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";

const EVENT_NAMES = {
  funnelStepClicked: "funnel_section_clicked",
};

const FUNNEL_STEPS = [0, 1, 2, 3, 4];
const DEFAULT_USER_COUNT = 100;
const DEFAULT_DAYS = 7;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TRAFFIC_SOURCE = "organic";
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";
const DEFAULT_FUNNEL_URL = "http://localhost:3000/funnel";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const organicReferrers = [
  { source: "google", referrer: "https://www.google.com/" },
  { source: "bing", referrer: "https://www.bing.com/" },
  { source: "duckduckgo", referrer: "https://duckduckgo.com/" },
];

const browsers = ["Chrome", "Safari", "Firefox", "Edge"];
const operatingSystems = ["Mac OS X", "Windows", "iOS", "Android", "Linux"];
const deviceTypes = ["Desktop", "Mobile", "Tablet"];

try {
  loadEnvFile(".env.local");
  loadEnvFile(".env");
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const runId = createRunId();
  const generated = generateFunnelEvents({
    runId,
    userCount: options.userCount,
    days: options.days,
    trafficSource: options.trafficSource,
    funnelUrl: options.funnelUrl,
  });

  printSummary(generated, options, runId);

  if (options.dryRun) {
    const sample = generated.events.slice(0, 3).map((event) => ({
      event: event.event,
      distinct_id: event.distinct_id,
      timestamp: event.timestamp,
      step: event.properties.step,
      traffic_source: event.properties.traffic_source,
    }));

    console.log("\nDry run only. Sample events:");
    console.log(JSON.stringify(sample, null, 2));
    return;
  }

  const { projectToken, endpoint } = getPostHogConfig();

  await sendEvents({
    endpoint,
    projectToken,
    events: generated.events,
    batchSize: options.batchSize,
    historicalMigration: options.historicalMigration,
  });

  console.log(`\nSent ${generated.events.length} events to ${endpoint}`);
}

function loadEnvFile(filename) {
  const path = resolve(process.cwd(), filename);

  if (!existsSync(path)) {
    return;
  }

  const contents = readFileSync(path, "utf8");

  for (const line of contents.split("\n")) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function parseOptions(args) {
  const parsed = {
    batchSize: readPositiveIntegerEnv("FUNNEL_BATCH_SIZE", DEFAULT_BATCH_SIZE),
    days: readPositiveIntegerEnv("FUNNEL_DAYS", DEFAULT_DAYS),
    dryRun: readBooleanEnv("FUNNEL_DRY_RUN", false),
    funnelUrl: process.env.FUNNEL_URL || DEFAULT_FUNNEL_URL,
    help: false,
    historicalMigration: readBooleanEnv("FUNNEL_HISTORICAL_MIGRATION", true),
    trafficSource:
      process.env.FUNNEL_TRAFFIC_SOURCE || DEFAULT_TRAFFIC_SOURCE,
    userCount: readPositiveIntegerEnv("FUNNEL_USERS", DEFAULT_USER_COUNT),
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    const [name, value] = arg.replace(/^--/, "").split("=");

    switch (name) {
      case "batch-size":
        parsed.batchSize = parsePositiveInteger(value, "--batch-size");
        break;
      case "days":
        parsed.days = parsePositiveInteger(value, "--days");
        break;
      case "funnel-url":
        parsed.funnelUrl = requireValue(value, "--funnel-url");
        break;
      case "historical-migration":
        parsed.historicalMigration = parseBoolean(
          requireValue(value, "--historical-migration")
        );
        break;
      case "traffic":
        parsed.trafficSource = requireValue(value, "--traffic");
        break;
      case "users":
        parsed.userCount = parsePositiveInteger(value, "--users");
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function readPositiveIntegerEnv(name, fallback) {
  if (!process.env[name]) {
    return fallback;
  }

  return parsePositiveInteger(process.env[name], name);
}

function readBooleanEnv(name, fallback) {
  if (!process.env[name]) {
    return fallback;
  }

  return parseBoolean(process.env[name]);
}

function parsePositiveInteger(value, label) {
  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return numberValue;
}

function parseBoolean(value) {
  if (["1", "true", "yes", "y"].includes(String(value).toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "n"].includes(String(value).toLowerCase())) {
    return false;
  }

  throw new Error(`Expected a boolean value, got "${value}".`);
}

function requireValue(value, label) {
  if (!value) {
    throw new Error(`${label} requires a value. Use ${label}=value.`);
  }

  return value;
}

function createRunId() {
  return crypto.randomUUID().slice(0, 8);
}

function generateFunnelEvents({
  runId,
  userCount,
  days,
  trafficSource,
  funnelUrl,
}) {
  const now = Date.now();
  const latestStart = now - 30 * 60 * 1000;
  const earliestStart = now - days * MS_PER_DAY;
  const events = [];
  const users = [];

  for (let index = 0; index < userCount; index += 1) {
    const distinctId = `workshop-funnel-${runId}-${String(index + 1).padStart(
      3,
      "0"
    )}`;
    const sessionId = crypto.randomUUID();
    const journeyId = crypto.randomUUID();
    const lastStep = pickLastReachedStep();
    const startTime = randomInteger(earliestStart, latestStart);
    const referrer = pickTrafficReferrer(trafficSource);
    const browser = pick(browsers);
    const os = pick(operatingSystems);
    const deviceType = pick(deviceTypes);
    let timestamp = startTime;

    users.push({ distinctId, lastStep });

    for (const step of FUNNEL_STEPS.slice(0, lastStep + 1)) {
      if (step > 0) {
        timestamp += randomInteger(8_000, 90_000);
      }

      events.push({
        event: EVENT_NAMES.funnelStepClicked,
        distinct_id: distinctId,
        timestamp: new Date(timestamp).toISOString(),
        properties: {
          step,
          traffic_source: trafficSource,
          seed_data: true,
          seed_run_id: runId,
          journey_id: journeyId,
          distinct_id: distinctId,
          $browser: browser,
          $current_url: funnelUrl,
          $device_type: deviceType,
          $host: getUrlHost(funnelUrl),
          $lib: "posthog-workshop-generator",
          $lib_version: "1.0.0",
          $os: os,
          $pathname: getUrlPathname(funnelUrl),
          $referrer: referrer.referrer,
          $referring_domain: getUrlHost(referrer.referrer),
          $session_id: sessionId,
          $set_once: {
            first_seen_from_seed_script: true,
            seed_traffic_source: trafficSource,
          },
          $utm_campaign: "posthog-workshop-funnel",
          $utm_medium: trafficSource,
          $utm_source: referrer.source,
        },
      });
    }
  }

  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return { events, users };
}

function pickLastReachedStep() {
  const roll = Math.random();

  if (roll < 0.2) {
    return 4;
  }

  if (roll < 0.33) {
    return 3;
  }

  if (roll < 0.5) {
    return 2;
  }

  if (roll < 0.92) {
    return 1;
  }

  return 0;
}

function pickTrafficReferrer(trafficSource) {
  if (trafficSource === "organic") {
    return pick(organicReferrers);
  }

  return {
    source: trafficSource,
    referrer: "",
  };
}

function pick(values) {
  return values[randomInteger(0, values.length - 1)];
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getUrlHost(url) {
  if (!url) {
    return "";
  }

  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function getUrlPathname(url) {
  if (!url) {
    return "";
  }

  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function printSummary({ events, users }, { days, trafficSource, dryRun }, runId) {
  const eventsByStep = new Map(FUNNEL_STEPS.map((step) => [step, 0]));
  const usersByLastStep = new Map(FUNNEL_STEPS.map((step) => [step, 0]));

  for (const event of events) {
    const step = event.properties.step;
    eventsByStep.set(step, eventsByStep.get(step) + 1);
  }

  for (const user of users) {
    usersByLastStep.set(user.lastStep, usersByLastStep.get(user.lastStep) + 1);
  }

  console.log(
    `${dryRun ? "Generated" : "Generating"} ${events.length} ${EVENT_NAMES.funnelStepClicked} events for ${users.length} fake users.`
  );
  console.log(
    `Traffic: ${trafficSource}. Time range: last ${days} days. Seed run: ${runId}.`
  );
  console.log("\nEvents by funnel step:");

  for (const step of FUNNEL_STEPS) {
    console.log(`  step ${step}: ${eventsByStep.get(step)}`);
  }

  console.log("\nUsers by furthest reached step:");

  for (const step of FUNNEL_STEPS) {
    console.log(`  step ${step}: ${usersByLastStep.get(step)}`);
  }
}

function getPostHogConfig() {
  const projectToken =
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ||
    process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_POSTHOG_HOST;

  if (!projectToken) {
    throw new Error(
      "Missing PostHog project token. Add NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN to .env.local."
    );
  }

  return {
    projectToken,
    endpoint: new URL("batch/", ensureTrailingSlash(host)).toString(),
  };
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

async function sendEvents({
  endpoint,
  projectToken,
  events,
  batchSize,
  historicalMigration,
}) {
  for (let start = 0; start < events.length; start += batchSize) {
    const batch = events.slice(start, start + batchSize);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: projectToken,
        historical_migration: historicalMigration,
        batch,
      }),
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `PostHog request failed with ${response.status}: ${responseText}`
      );
    }

    console.log(
      `Sent batch ${Math.floor(start / batchSize) + 1}/${Math.ceil(
        events.length / batchSize
      )}: ${batch.length} events`
    );
  }
}

function printHelp() {
  console.log(`
Generate fake PostHog funnel events for Oppgave 2b.

Usage:
  npm run generate-funnel-data
  npm run generate-funnel-data -- --users=200 --days=14 --traffic=organic
  npm run generate-funnel-data -- --dry-run

Options:
  --users=<number>                  Fake users to generate. Default: ${DEFAULT_USER_COUNT}
  --days=<number>                   Spread events across the last N days. Default: ${DEFAULT_DAYS}
  --traffic=<source>                Traffic source property. Default: ${DEFAULT_TRAFFIC_SOURCE}
  --funnel-url=<url>                URL written to $current_url. Default: ${DEFAULT_FUNNEL_URL}
  --batch-size=<number>             Events per PostHog batch request. Default: ${DEFAULT_BATCH_SIZE}
  --historical-migration=<boolean>  Send as historical migration. Default: true
  --dry-run                         Generate and print a sample without sending

Environment:
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN or NEXT_PUBLIC_POSTHOG_KEY
  NEXT_PUBLIC_POSTHOG_HOST
`);
}

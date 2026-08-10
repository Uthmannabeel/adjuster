// One command from a fresh GCP project to a running Confidential Space enclave
// whose in-TEE key is attested on Flare.
//
// Every stage is idempotent — re-running skips what already exists, so a failure
// halfway through is fixed by fixing the cause and running the same command again.
//
//   node scripts/deploy-enclave.mjs \
//     --registry-url https://adjuster.vercel.app \
//     --tls-domain enclave.example.com --tls-email you@example.com
//   node scripts/deploy-enclave.mjs --from vm          # resume at a stage
//   node scripts/deploy-enclave.mjs --only build       # run one stage
//   node scripts/deploy-enclave.mjs --list             # show the stage names
//
// The `ip` stage reserves the address first, so the A record for --tls-domain
// can be created before the enclave boots and asks Let's Encrypt for a cert.
// Without --tls-domain the enclave serves plain HTTP, which a browser on an
// HTTPS page will refuse to talk to.
//
// Stages: preflight → apis → repo → sa → build → ip → firewall → vm → wait → pin → fund
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env.local");
const statePath = join(root, "contracts", "deployment.enclave.json");

const GCLOUD = process.platform === "win32" ? "gcloud.cmd" : "gcloud";

// c3-standard-4 is the smallest Intel TDX shape; Confidential Space itself is
// free, the VM is ~$0.20/hr. us-central1-a has TDX capacity most reliably.
const CFG = {
  region: arg("--region") ?? "us-central1",
  zone: arg("--zone") ?? "us-central1-a",
  repo: arg("--repo") ?? "adjuster",
  image: arg("--image") ?? "enclave",
  tag: arg("--tag") ?? "v1",
  vm: arg("--vm") ?? "adjuster-enclave",
  machine: arg("--machine") ?? "c3-standard-4",
  sa: arg("--sa") ?? "adjuster-enclave",
};

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

function envLocal(name) {
  try {
    const m = readFileSync(envPath, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function setEnvLocal(name, value) {
  let content = "";
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    /* first write */
  }
  const line = `${name}=${value}`;
  if (new RegExp(`^${name}=`, "m").test(content)) {
    writeFileSync(envPath, content.replace(new RegExp(`^${name}=.*$`, "m"), line));
  } else {
    appendFileSync(envPath, `${content.endsWith("\n") || !content ? "" : "\n"}${line}\n`);
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// gcloud on Windows is a .cmd shim, which Node refuses to spawn without a shell.
// With a shell, cmd.exe would eat the metadata delimiter (`^` is its escape
// character) and choke on the parens in --format=value(...) — so quote every arg
// and let cmd treat the contents as literal.
const NEEDS_SHELL = process.platform === "win32";
const shellArgs = (args) => (NEEDS_SHELL ? args.map((a) => `"${a.replaceAll('"', '\\"')}"`) : args);

// Every arg is quoted above, so the generic "args are only concatenated" warning
// is noise that reads like a failure in the middle of a deploy. Node's default
// printer is itself a 'warning' listener, so it has to be removed, not shadowed.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "DeprecationWarning" || !w.message.includes("shell option")) console.warn(w);
});

/**
 * DNS on this network intermittently SERVFAILs; a deploy shouldn't die on one
 * lookup. The timer is cleared explicitly — an AbortSignal.timeout left pending
 * across a process.exit trips a libuv assertion on Windows.
 */
async function fetchRetry(url, init, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** Run gcloud and capture stdout. Never throws — the caller decides what a failure means. */
function gcloud(args, { cwd = root } = {}) {
  const r = spawnSync(GCLOUD, shellArgs(args), { cwd, encoding: "utf8", shell: NEEDS_SHELL });
  return {
    ok: r.status === 0,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
}

/** Run gcloud with output streamed through — for the slow, interesting ones. */
function gcloudLive(args, { cwd = root } = {}) {
  const r = spawnSync(GCLOUD, shellArgs(args), { cwd, stdio: "inherit", shell: NEEDS_SHELL });
  return { ok: r.status === 0 };
}

const log = {
  step: (m) => console.log(`\n\x1b[1m▸ ${m}\x1b[0m`),
  ok: (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  skip: (m) => console.log(`  \x1b[90m·\x1b[0m ${m}`),
  warn: (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`),
};

/**
 * Aborts the run. Throws rather than calling process.exit: exiting while an
 * HTTP keep-alive socket is still open trips a libuv assertion on Windows, and
 * a thrown error also lets a stage clean up on the way out.
 */
class DeployError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function fail(message, hint) {
  throw new DeployError(message, hint);
}

// ── stages ────────────────────────────────────────────────────────────────────

const ctx = {
  project: null,
  imagePath: null,
  digest: null,
  saEmail: null,
  ip: null,
};

async function preflight() {
  const version = gcloud(["version"]);
  if (!version.ok) {
    fail(
      "Could not run gcloud.",
      version.err || "Install the Google Cloud SDK and make sure gcloud is on PATH, then re-run.",
    );
  }
  log.ok(version.out.split("\n").find((l) => l.startsWith("Google Cloud SDK")) ?? "gcloud present");

  const account = gcloud(["config", "get-value", "account"]);
  if (!account.ok || !account.out || account.out === "(unset)") {
    fail("gcloud is not authenticated.", "Run:  ! gcloud auth login");
  }
  log.ok(`authenticated as ${account.out}`);

  const project = arg("--project") ?? gcloud(["config", "get-value", "project"]).out;
  if (!project || project === "(unset)") {
    fail("No GCP project selected.", "Run:  gcloud config set project adjuster-flare");
  }
  ctx.project = project;
  log.ok(`project ${project}`);

  // Billing is the failure that costs the most time to diagnose later: APIs
  // enable fine, then instance creation fails deep in the run.
  const token = gcloud(["auth", "print-access-token"]);
  if (!token.ok) fail("Could not mint an access token.", token.err);
  let billing;
  try {
    const res = await fetchRetry(
      `https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`,
      { headers: { Authorization: `Bearer ${token.out}` } },
    );
    billing = await res.json();
  } catch (error) {
    fail(`Could not reach the Cloud Billing API: ${error.message}`, "Transient DNS — re-run.");
  }
  if (!billing.billingEnabled) {
    fail(
      `Billing is not enabled on ${project}.`,
      "Open https://console.cloud.google.com/billing and link an active account\n"
      + "  (the $300 free trial covers this deployment several times over).",
    );
  }
  log.ok(`billing enabled (${billing.billingAccountName})`);

  const registryUrl = arg("--registry-url") ?? readState().registryUrl;
  if (!registryUrl) {
    fail(
      "Pass --registry-url https://YOUR-APP — the enclave queries it by hash.",
      "This is the public app URL. It is stored, so later runs can omit the flag.",
    );
  }
  if (!/^https?:\/\//.test(registryUrl)) fail(`--registry-url must be absolute: ${registryUrl}`);
  writeState({ project, registryUrl, zone: CFG.zone, region: CFG.region });
  log.ok(`registry ${registryUrl}`);
}

function apis() {
  const needed = [
    "compute.googleapis.com",
    "artifactregistry.googleapis.com",
    "confidentialcomputing.googleapis.com",
    "cloudbuild.googleapis.com",
    "logging.googleapis.com",
  ];
  const enabled = gcloud([
    "services", "list", "--enabled", "--format=value(config.name)", `--project=${ctx.project}`,
  ]);
  const have = new Set(enabled.out.split("\n").map((s) => s.trim()));
  const missing = needed.filter((s) => !have.has(s));
  if (!missing.length) {
    log.skip("all required APIs already enabled");
    return;
  }
  log.warn(`enabling ${missing.length} API(s) — this takes a minute`);
  if (!gcloudLive(["services", "enable", ...missing, `--project=${ctx.project}`]).ok) {
    fail("Enabling APIs failed.");
  }
  log.ok(`enabled ${missing.join(", ")}`);
}

function repo() {
  const path = `${CFG.region}-docker.pkg.dev/${ctx.project}/${CFG.repo}`;
  ctx.imagePath = `${path}/${CFG.image}`;
  const exists = gcloud([
    "artifacts", "repositories", "describe", CFG.repo,
    `--location=${CFG.region}`, `--project=${ctx.project}`, "--format=value(name)",
  ]);
  if (exists.ok) {
    log.skip(`Artifact Registry repo ${CFG.repo} exists`);
    return;
  }
  const created = gcloud([
    "artifacts", "repositories", "create", CFG.repo,
    "--repository-format=docker", `--location=${CFG.region}`, `--project=${ctx.project}`,
    "--description=Adjuster confidential enclave images",
  ]);
  if (!created.ok) fail(`Could not create Artifact Registry repo ${CFG.repo}.`, created.err);
  log.ok(`created repo ${path}`);
}

function sa() {
  ctx.saEmail = `${CFG.sa}@${ctx.project}.iam.gserviceaccount.com`;
  const exists = gcloud([
    "iam", "service-accounts", "describe", ctx.saEmail,
    `--project=${ctx.project}`, "--format=value(email)",
  ]);
  if (!exists.ok) {
    const created = gcloud([
      "iam", "service-accounts", "create", CFG.sa,
      "--display-name=Adjuster enclave workload", `--project=${ctx.project}`,
    ]);
    if (!created.ok) fail("Could not create the enclave service account.", created.err);
    log.ok(`created service account ${ctx.saEmail}`);
  } else {
    log.skip(`service account ${ctx.saEmail} exists`);
  }

  // workloadUser is what lets the container ask the launcher for an attestation
  // token; logWriter is what makes tee-container-log-redirect useful.
  const roles = ["roles/confidentialcomputing.workloadUser", "roles/logging.logWriter"];
  for (const role of roles) {
    const bound = gcloud([
      "projects", "add-iam-policy-binding", ctx.project,
      `--member=serviceAccount:${ctx.saEmail}`, `--role=${role}`, "--condition=None",
      "--format=none",
    ]);
    if (!bound.ok) fail(`Could not grant ${role}.`, bound.err);
  }
  log.ok(`granted ${roles.join(", ")}`);

  const reader = gcloud([
    "artifacts", "repositories", "add-iam-policy-binding", CFG.repo,
    `--location=${CFG.region}`, `--project=${ctx.project}`,
    `--member=serviceAccount:${ctx.saEmail}`, "--role=roles/artifactregistry.reader",
    "--format=none",
  ]);
  if (!reader.ok) fail("Could not grant the enclave read access to the image repo.", reader.err);
  log.ok("granted artifactregistry.reader on the repo");
  writeState({ serviceAccount: ctx.saEmail });
}

function build() {
  if (!ctx.imagePath) ctx.imagePath = `${CFG.region}-docker.pkg.dev/${ctx.project}/${CFG.repo}/${CFG.image}`;
  const tagged = `${ctx.imagePath}:${CFG.tag}`;
  log.warn(`building ${tagged} from enclave/ — a few minutes`);
  const built = gcloudLive(
    ["builds", "submit", `--tag=${tagged}`, `--project=${ctx.project}`],
    { cwd: join(root, "enclave") },
  );
  if (!built.ok) fail("Cloud Build failed — see the log URL above.");

  // The chain pins the DIGEST, not the tag: a tag can be moved, a digest cannot.
  const described = gcloud([
    "artifacts", "docker", "images", "describe", tagged,
    `--project=${ctx.project}`, "--format=value(image_summary.digest)",
  ]);
  if (!described.ok || !/^sha256:[0-9a-f]{64}$/.test(described.out)) {
    fail("Could not resolve the pushed image digest.", described.err || described.out);
  }
  ctx.digest = described.out;
  writeState({ imagePath: ctx.imagePath, tag: CFG.tag, imageDigest: ctx.digest });
  log.ok(`pushed ${ctx.digest}`);
}

/**
 * A reserved address lets the DNS record be created before the VM exists — and
 * survives recreating the VM, so the A record is set once.
 */
function ip() {
  const name = "adjuster-enclave-ip";
  let address = gcloud([
    "compute", "addresses", "describe", name,
    `--region=${CFG.region}`, `--project=${ctx.project}`, "--format=value(address)",
  ]);
  if (!address.ok) {
    const created = gcloud([
      "compute", "addresses", "create", name,
      `--region=${CFG.region}`, `--project=${ctx.project}`,
      "--description=Stable address for the Adjuster enclave",
    ]);
    if (!created.ok) fail(`Could not reserve a static address.`, created.err);
    address = gcloud([
      "compute", "addresses", "describe", name,
      `--region=${CFG.region}`, `--project=${ctx.project}`, "--format=value(address)",
    ]);
    if (!address.ok || !address.out) fail("Reserved the address but could not read it back.");
  }
  ctx.ip = address.out;
  writeState({ staticIp: ctx.ip, staticIpName: name });
  log.ok(`static address ${ctx.ip}`);

  const domain = arg("--tls-domain") ?? readState().tlsDomain;
  if (domain) {
    writeState({ tlsDomain: domain });
    log.warn(`point an A record for ${domain} at ${ctx.ip} before the enclave boots`);
  } else {
    log.warn("no --tls-domain given — the enclave will serve plain HTTP, which browsers");
    log.warn("on an HTTPS page will refuse to reach. Pass --tls-domain to enable in-enclave TLS.");
  }
}

function firewall() {
  // 80 is the ACME HTTP-01 challenge, 443 the browser upload path, 8080 the
  // plaintext health port the ops scripts use.
  const rules = [
    ["adjuster-enclave-web", "tcp:80,tcp:443", "ACME challenge and browser uploads"],
    ["adjuster-enclave-8080", "tcp:8080", "Plaintext health port for ops scripts"],
  ];
  for (const [name, allow, description] of rules) {
    const exists = gcloud([
      "compute", "firewall-rules", "describe", name,
      `--project=${ctx.project}`, "--format=value(name)",
    ]);
    if (exists.ok) {
      log.skip(`firewall rule ${name} exists`);
      continue;
    }
    const created = gcloud([
      "compute", "firewall-rules", "create", name,
      `--allow=${allow}`, "--target-tags=adjuster-enclave",
      "--source-ranges=0.0.0.0/0", `--project=${ctx.project}`,
      `--description=${description}`,
    ]);
    if (!created.ok) fail(`Could not create firewall rule ${name}.`, created.err);
    log.ok(`opened ${allow} to tag adjuster-enclave`);
  }
}

function vm() {
  const state = readState();
  const digest = ctx.digest ?? state.imageDigest;
  const imagePath = ctx.imagePath ?? state.imagePath;
  if (!digest || !imagePath) fail("No image digest on record — run the build stage first.");

  const existing = gcloud([
    "compute", "instances", "describe", CFG.vm, `--zone=${CFG.zone}`,
    `--project=${ctx.project}`, "--format=value(name)",
  ]);
  if (existing.ok) {
    log.skip(`instance ${CFG.vm} exists — delete it to redeploy a new image`);
    log.skip(`  gcloud compute instances delete ${CFG.vm} --zone=${CFG.zone}`);
    return;
  }

  // ^~^ switches the metadata delimiter to ~ so URLs keep their commas intact.
  const state = readState();
  const tlsDomain = arg("--tls-domain") ?? state.tlsDomain ?? "";
  const metadata = [
    `tee-image-reference=${imagePath}@${digest}`,
    `tee-container-log-redirect=true`,
    `tee-env-REGISTRY_URL=${state.registryUrl}`,
    `tee-env-FLARE_RPC_URL=${envLocal("FLARE_RPC_URL") ?? "https://coston2-api.flare.network/ext/C/rpc"}`,
    `tee-env-FLARE_VTPM_ADDRESS=${envLocal("FLARE_VTPM_ADDRESS") ?? ""}`,
    `tee-env-ALLOWED_ORIGIN=${arg("--allowed-origin") ?? "*"}`,
    `tee-env-TLS_DOMAIN=${tlsDomain}`,
    `tee-env-TLS_EMAIL=${arg("--tls-email") ?? ""}`,
    `tee-env-TLS_STAGING=${process.argv.includes("--tls-staging") ? "true" : "false"}`,
  ].join("~");
  if (tlsDomain) writeState({ tlsDomain });

  log.warn(`creating ${CFG.machine} TDX instance ${CFG.vm}`);
  const created = gcloud([
    "compute", "instances", "create", CFG.vm,
    `--zone=${CFG.zone}`, `--machine-type=${CFG.machine}`,
    "--confidential-compute-type=TDX", "--shielded-secure-boot",
    "--maintenance-policy=TERMINATE",
    "--image-project=confidential-space-images", "--image-family=confidential-space",
    `--service-account=${ctx.saEmail ?? state.serviceAccount}`,
    "--scopes=cloud-platform", "--tags=adjuster-enclave",
    ...(state.staticIp ? [`--address=${state.staticIp}`] : []),
    `--metadata=^~^${metadata}`, `--project=${ctx.project}`,
    "--format=value(networkInterfaces[0].accessConfigs[0].natIP)",
  ]);
  if (!created.ok) fail(`Could not create ${CFG.vm}.`, created.err);
  log.ok(`instance created`);
}

async function wait() {
  const ipQuery = gcloud([
    "compute", "instances", "describe", CFG.vm, `--zone=${CFG.zone}`, `--project=${ctx.project}`,
    "--format=value(networkInterfaces[0].accessConfigs[0].natIP)",
  ]);
  if (!ipQuery.ok || !ipQuery.out) fail("Could not read the instance external IP.", ipQuery.err);
  ctx.ip = ipQuery.out;
  const url = `http://${ctx.ip}:8080`;
  writeState({ enclaveIp: ctx.ip, enclaveUrl: url });
  log.ok(`external IP ${ctx.ip}`);

  // Confidential Space pulls the image and starts the workload after boot;
  // first boot is the slow one.
  log.warn(`waiting for ${url}/health — Confidential Space first boot takes ~2-4 min`);
  const deadline = Date.now() + 8 * 60 * 1000;
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${url}/health`, { signal: controller.signal });
      if (res.ok) {
        const health = await res.json();
        const att = health?.data?.attestation ?? {};
        log.ok(`enclave responding — inConfidentialSpace=${att.inConfidentialSpace ?? "?"}`);
        if (att.tokenImageDigest) log.ok(`token image digest ${att.tokenImageDigest}`);
        if (health?.data?.teeAddress) {
          log.ok(`in-enclave TEE address ${health.data.teeAddress}`);
          writeState({ teeAddress: health.data.teeAddress });
        }

        // The browser-facing URL is the TLS one when the enclave got a cert;
        // ops scripts keep using the plaintext health port either way.
        const tls = health?.data?.tls ?? {};
        if (tls.active) {
          log.ok(`TLS active — ${tls.url}${tls.staging ? " (STAGING cert, untrusted)" : ""}`);
          writeState({ publicUrl: tls.url });
        } else {
          log.warn(`TLS not active — ${tls.reason ?? "unknown"}`);
          log.warn("an HTTPS app will not be able to reach this enclave from a browser");
          writeState({ publicUrl: url });
        }
        return;
      }
    } catch {
      /* not up yet */
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() > deadline) {
      fail(
        `${url}/health never came up.`,
        `Check the workload log:\n`
        + `  gcloud compute instances get-serial-port-output ${CFG.vm} --zone=${CFG.zone} | Select-String tee`,
      );
    }
    process.stdout.write(`  · attempt ${attempt}\r`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

function pin() {
  const url = readState().enclaveUrl;
  if (!url) fail("No enclave URL on record — run the wait stage first.");
  log.warn("pinning the on-chain required image digest to the running enclave");
  const r = spawnSync(process.execPath, [join(root, "scripts", "set-image-digest.mjs"), "--from", url], {
    cwd: root, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--use-system-ca" },
  });
  if (r.status !== 0) fail("set-image-digest.mjs failed.");
}

function fund() {
  const url = readState().enclaveUrl;
  log.warn("funding the in-enclave key so it can pay for its own attestation tx");
  const r = spawnSync(process.execPath, [join(root, "scripts", "fund-tee.mjs"), "--from", url], {
    cwd: root, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--use-system-ca" },
  });
  if (r.status !== 0) fail("fund-tee.mjs failed.");
  const state = readState();
  const publicUrl = state.publicUrl ?? state.enclaveUrl;
  console.log(`\n\x1b[1mEnclave live:\x1b[0m ${publicUrl}`);
  console.log(`  image  ${state.imagePath}@${state.imageDigest}`);
  console.log(`  TEE    ${state.teeAddress ?? "(read /health)"}`);
  console.log(`  ops    ${state.enclaveUrl}/health`);
  console.log(`\nSet on the app deployment:  NEXT_PUBLIC_ENCLAVE_URL=${publicUrl}`);
  console.log(`Then watch attestation land: node scripts/health-check.mjs --enclave ${state.enclaveUrl}\n`);
  setEnvLocal("NEXT_PUBLIC_ENCLAVE_URL", publicUrl);
}

// ── runner ────────────────────────────────────────────────────────────────────

const STAGES = [
  ["preflight", preflight],
  ["apis", apis],
  ["repo", repo],
  ["sa", sa],
  ["build", build],
  ["ip", ip],
  ["firewall", firewall],
  ["vm", vm],
  ["wait", wait],
  ["pin", pin],
  ["fund", fund],
];

if (process.argv.includes("--list")) {
  console.log(STAGES.map(([name]) => name).join(" → "));
  process.exit(0);
}

try {
  const only = arg("--only");
  const from = arg("--from");
  if (only && !STAGES.some(([n]) => n === only)) fail(`Unknown stage "${only}".`);
  if (from && !STAGES.some(([n]) => n === from)) fail(`Unknown stage "${from}".`);

  const startAt = from ? STAGES.findIndex(([n]) => n === from) : 0;
  const selected = only ? STAGES.filter(([n]) => n === only) : STAGES.slice(startAt);

  // Stages after preflight assume ctx.project; running one in isolation still needs it.
  if (selected[0]?.[0] !== "preflight") {
    ctx.project = arg("--project") ?? readState().project ?? gcloud(["config", "get-value", "project"]).out;
    ctx.saEmail = readState().serviceAccount ?? null;
    if (!ctx.project) fail("No project on record.", "Run the full script once, or pass --project.");
  }

  for (const [name, fn] of selected) {
    log.step(name);
    await fn();
  }
} catch (error) {
  if (!(error instanceof DeployError)) throw error;
  console.error(`\n\x1b[31m✗ ${error.message}\x1b[0m`);
  if (error.hint) console.error(`\n  ${error.hint}\n`);
  process.exitCode = 1;
}

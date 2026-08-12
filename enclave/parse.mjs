// Parent-side wrapper around parse-worker.mjs: spawn, feed bytes, enforce a
// deadline, and never let the worker inherit secrets (only PATH survives —
// the signing key, registry URL, and RPC endpoints stay in this process).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "parse-worker.mjs");
const PARSE_TIMEOUT_MS = 10_000;

/**
 * @param {Buffer} buf raw image bytes
 * @returns {Promise<{ok: true, phash: string, exif: object} | {ok: false, error: string}>}
 */
export function parseImageIsolated(buf) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(process.execPath, [WORKER], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "ignore"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, error: "Image parsing timed out." });
    }, PARSE_TIMEOUT_MS);

    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("error", (error) => done({ ok: false, error: error.message }));
    child.on("close", () => {
      try {
        done(JSON.parse(out));
      } catch {
        done({ ok: false, error: "Image parser returned no verdict." });
      }
    });

    child.stdin.on("error", () => {
      /* worker died mid-write — close handler reports it */
    });
    child.stdin.end(buf);
  });
}

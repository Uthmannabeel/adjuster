// Disposable image parser — runs as a child process with a clean environment.
//
// Image decoders are the classic remote-code-execution surface, and in this
// enclave the process that examines attacker-controlled bytes would otherwise
// be the same process holding the verdict-signing key. So decoding happens
// HERE: no key, no registry URL, no network use, one image per process, killed
// on overrun by the parent. A parser exploit lands in a throwaway process that
// knows nothing.
//
// stdin: raw image bytes → stdout: {ok, phash, exif} or {ok:false, error}.
import { perceptualHash } from "./hash.mjs";
import { extractExif } from "./exif.mjs";

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  try {
    const buf = Buffer.concat(chunks);
    const phash = await perceptualHash(buf);
    const exif = await extractExif(buf);
    process.stdout.write(JSON.stringify({ ok: true, phash, exif }));
    process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? "parse failed" }));
    process.exit(0);
  }
});

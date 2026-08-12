"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResponse } from "@/lib/api";
import type {
  AdjusterPolicy,
  BuyResult,
  EnclaveClaimData,
  EvidenceResult,
  PoliciesResponse,
  SettlementPoll,
  SettlementTicket,
} from "@/lib/adjuster-types";
import { EvidenceChain, type Station, type StationLine } from "./EvidenceChain";

/** Images go DIRECTLY to the confidential enclave — never to our server. */
const ENCLAVE_URL = (process.env.NEXT_PUBLIC_ENCLAVE_URL ?? "").replace(/\/$/, "");

const POLL_INTERVAL_MS = 8_000;
const POLL_LIMIT = 60; // ≈ 8 minutes — FDC rounds are ~90 s, this is generous

type Phase =
  | "idle"
  | "verifying" // photo in the enclave
  | "relaying" // evidence tx
  | "requesting-weather" // FDC attestation request
  | "polling" // waiting for round finalization + proof
  | "settled"
  | "rejected" // enclave verdict: not eligible
  | "spoofed" // contract refused the signer (NotAttestedTee)
  | "error";

interface FlowState {
  phase: Phase;
  claim: EnclaveClaimData | null;
  evidence: EvidenceResult | null;
  ticket: SettlementTicket | null;
  poll: SettlementPoll | null;
  error: string | null;
  elapsedS: number;
}

const INITIAL_FLOW: FlowState = {
  phase: "idle",
  claim: null,
  evidence: null,
  ticket: null,
  poll: null,
  error: null,
  elapsedS: 0,
};

async function postJson<T>(
  url: string,
  payload: unknown,
): Promise<{ status: number; body: ApiResponse<T> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as ApiResponse<T> };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The first chain read from a cold serverless function is the one most likely to
// time out — and it is exactly the request a judge's first visit triggers.
const POLICY_LOAD_ATTEMPTS = 3;
const POLICY_RETRY_BACKOFF_MS = 900;

/** Strips ethers' internal suffix — "(code=TIMEOUT, version=6.17.0)" helps nobody reading a claim form. */
function readableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "";
  const cleaned = raw.replace(/\s*\((?:code|version|argument|value)=.*\)\s*$/i, "").trim();
  return cleaned.length > 0 && cleaned.length < 160
    ? cleaned
    : "The Coston2 node did not answer in time.";
}

export function ClaimFlow() {
  const [policies, setPolicies] = useState<AdjusterPolicy[]>([]);
  const [contract, setContract] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [policyId, setPolicyId] = useState<number | null>(null);
  const [buying, setBuying] = useState(false);
  const [buyResult, setBuyResult] = useState<BuyResult | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  // setupError is a recoverable problem with one action (buy, sample photo);
  // loadError means the policy list itself never arrived and nothing can proceed.
  const [setupError, setSetupError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [flow, setFlow] = useState<FlowState>(INITIAL_FLOW);
  // Pre-upload attestation check: verified ON-CHAIN by our server, not by
  // asking the enclave to vouch for itself. null = still checking;
  // checked:false = the check itself was unavailable (warn, do not block —
  // the chain still rejects unattested verdicts); attested:false = block.
  const [attStatus, setAttStatus] = useState<{
    checked: boolean;
    attested: boolean;
    reason: string;
    expiresAt: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/adjuster/enclave-status")
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j?.success) setAttStatus(j.data);
      })
      .catch(() => {
        if (!cancelled)
          setAttStatus({
            checked: false,
            attested: false,
            reason: "Status check unavailable.",
            expiresAt: null,
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cancels in-flight settle loops when the component unmounts or a new
  // claim starts (each run gets its own id).
  const runIdRef = useRef(0);
  useEffect(() => () => void (runIdRef.current += 1), []);

  const loadPolicies = useCallback(async () => {
    setLoadError(null);
    for (let attempt = 0; attempt < POLICY_LOAD_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch("/api/adjuster/policies");
        const body = (await res.json()) as ApiResponse<PoliciesResponse>;
        if (!body.success || !body.data) throw new Error(body.error ?? "Policy listing failed.");
        setConfigured(body.data.configured);
        setContract(body.data.contract);
        setPolicies(body.data.policies);
        return body.data.policies;
      } catch (err: unknown) {
        // A slow node is not a shut claims office: only give up after retrying,
        // and then offer a way back rather than a dead end.
        if (attempt === POLICY_LOAD_ATTEMPTS - 1) {
          setLoadError(readableError(err));
          return [];
        }
        await sleep(POLICY_RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
    return [];
  }, []);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  const openPolicies = policies.filter((p) => !p.settled);
  const selected = policies.find((p) => p.policyId === policyId) ?? null;

  function selectFile(next: File | null) {
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return next ? URL.createObjectURL(next) : null;
    });
    setFile(next);
    runIdRef.current += 1;
    setFlow(INITIAL_FLOW);
  }

  function selectPolicy(id: number) {
    setPolicyId(id);
    runIdRef.current += 1;
    setFlow(INITIAL_FLOW);
  }

  async function buyDemoPolicy() {
    setBuying(true);
    setSetupError(null);
    try {
      const { body } = await postJson<BuyResult>("/api/adjuster/buy", {});
      if (!body.success || !body.data) throw new Error(body.error ?? "Policy purchase failed.");
      setBuyResult(body.data);
      await loadPolicies();
      setPolicyId(body.data.policyId);
    } catch (err: unknown) {
      setSetupError(err instanceof Error ? err.message : "Policy purchase failed.");
    } finally {
      setBuying(false);
    }
  }

  async function loadSamplePhoto() {
    if (policyId === null) return;
    setLoadingSample(true);
    setSetupError(null);
    try {
      const res = await fetch(`/api/adjuster/sample-photo?policyId=${policyId}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiResponse<never> | null;
        throw new Error(body?.error ?? "Sample photo unavailable.");
      }
      const blob = await res.blob();
      selectFile(new File([blob], `claim-policy-${policyId}.jpg`, { type: "image/jpeg" }));
    } catch (err: unknown) {
      setSetupError(err instanceof Error ? err.message : "Sample photo unavailable.");
    } finally {
      setLoadingSample(false);
    }
  }

  /** The whole lifecycle, auto-advancing: enclave → evidence tx → FDC → payout. */
  async function fileClaim() {
    if (!file || policyId === null || !contract || !ENCLAVE_URL) return;
    const runId = ++runIdRef.current;
    const live = () => runIdRef.current === runId;
    setFlow({ ...INITIAL_FLOW, phase: "verifying" });

    try {
      // 1 — confidential verification; the photo goes only to the enclave.
      const enclaveRes = await fetch(
        `${ENCLAVE_URL}/claim?policyId=${policyId}&contract=${contract}`,
        { method: "POST", headers: { "Content-Type": file.type }, body: file },
      );
      const enclaveBody = (await enclaveRes.json()) as ApiResponse<EnclaveClaimData>;
      if (!live()) return;
      if (!enclaveBody.success || !enclaveBody.data) {
        throw new Error(enclaveBody.error ?? "The enclave could not verify the photo.");
      }
      const claim = enclaveBody.data;
      if (!claim.eligible) {
        setFlow((f) => ({ ...f, phase: "rejected", claim }));
        return;
      }
      setFlow((f) => ({ ...f, claim, phase: "relaying" }));

      // 2 — relay the enclave-signed settlement on-chain.
      const ev = await postJson<EvidenceResult>("/api/adjuster/evidence", claim.fcc);
      if (!live()) return;
      if (!ev.body.success || !ev.body.data) {
        if (ev.status === 403) {
          setFlow((f) => ({
            ...f,
            phase: "spoofed",
            error: ev.body.error ?? "Rejected on-chain: signer is not an attested TEE.",
          }));
          return;
        }
        throw new Error(ev.body.error ?? "Evidence submission failed.");
      }
      setFlow((f) => ({ ...f, evidence: ev.body.data ?? null, phase: "requesting-weather" }));

      await runSettlement(runId, policyId);
    } catch (err: unknown) {
      if (!live()) return;
      setFlow((f) => ({
        ...f,
        phase: "error",
        error: err instanceof Error ? err.message : "The claim could not be processed.",
      }));
    }
  }

  /** FDC weather attestation + settle, polled until the payout lands. */
  async function runSettlement(runId: number, id: number) {
    const live = () => runIdRef.current === runId;

    const start = await postJson<SettlementTicket>("/api/adjuster/settle", { policyId: id });
    if (!live()) return;
    if (!start.body.success || !start.body.data) {
      throw new Error(start.body.error ?? "Weather attestation request failed.");
    }
    const ticket = start.body.data;
    setFlow((f) => ({ ...f, ticket, phase: "polling", elapsedS: 0 }));

    for (let i = 0; i < POLL_LIMIT; i++) {
      await sleep(POLL_INTERVAL_MS);
      if (!live()) return;
      setFlow((f) => ({ ...f, elapsedS: Math.round(((i + 1) * POLL_INTERVAL_MS) / 1000) }));

      const poll = await postJson<SettlementPoll>("/api/adjuster/settle/poll", {
        policyId: ticket.policyId,
        roundId: ticket.roundId,
        abiEncodedRequest: ticket.abiEncodedRequest,
      });
      if (!live()) return;
      if (!poll.body.success || !poll.body.data) {
        // Transient RPC/DA hiccups are normal mid-round — keep polling.
        continue;
      }
      setFlow((f) => ({ ...f, poll: poll.body.data ?? null }));
      if (poll.body.data.state === "settled") {
        setFlow((f) => ({ ...f, phase: "settled" }));
        void loadPolicies();
        return;
      }
    }
    throw new Error(
      "The attestation round is taking longer than expected. The request is on-chain — retry settlement to resume.",
    );
  }

  /** Resume settlement for a policy whose evidence is already approved. */
  async function settleOnly() {
    if (policyId === null) return;
    const runId = ++runIdRef.current;
    setFlow({ ...INITIAL_FLOW, phase: "requesting-weather" });
    try {
      await runSettlement(runId, policyId);
    } catch (err: unknown) {
      if (runIdRef.current !== runId) return;
      setFlow((f) => ({
        ...f,
        phase: "error",
        error: err instanceof Error ? err.message : "Settlement failed.",
      }));
    }
  }

  const busy = ["verifying", "relaying", "requesting-weather", "polling"].includes(flow.phase);
  const stations = buildStations(flow, file, selected);
  const showChain = flow.phase !== "idle" || file !== null;

  if (loadError) {
    return (
      <div className="doc-card p-6">
        <p className="eyebrow mb-2">Could not reach Coston2</p>
        <p className="text-sm text-[var(--color-ink-soft)]">
          {loadError} The policies live on-chain, so this is a network problem rather than a
          missing claims office — try again.
        </p>
        <button
          type="button"
          className="btn-primary mt-4"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void loadPolicies().finally(() => setRetrying(false));
          }}
        >
          {retrying ? "Retrying…" : "Try again"}
        </button>
      </div>
    );
  }

  if (configured === false) {
    return (
      <div className="doc-card p-6">
        <p className="eyebrow mb-2">Claims office closed</p>
        <p className="text-sm text-[var(--color-ink-soft)]">
          Adjuster is not configured on this deployment — the ClaimPayout contract address and
          relay key are missing.
        </p>
      </div>
    );
  }

  return (
    <div className="grid lg:grid-cols-2 gap-8 items-start">
      {/* ── Left: intake form ── */}
      <section className="space-y-6">
        <div>
          <div className="doc-rule pb-2 mb-4 flex items-baseline justify-between">
            <h2 className="eyebrow">Section 1 — Policy</h2>
            {contract && (
              <a
                className="mono text-[0.68rem] text-[var(--color-ink-faint)] underline underline-offset-2"
                href={`https://coston2-explorer.flare.network/address/${contract}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                ClaimPayout on Coston2 ↗
              </a>
            )}
          </div>

          {configured === null ? (
            <p className="mono text-[0.8rem] text-[var(--color-ink-faint)]">Reading policies from chain…</p>
          ) : (
            <>
              <div className="space-y-2">
                {openPolicies.length === 0 && (
                  <p className="text-sm text-[var(--color-ink-soft)]">
                    No open policies on the contract. Open a demo policy to begin.
                  </p>
                )}
                {openPolicies.slice(0, 6).map((p) => (
                  <button
                    key={p.policyId}
                    type="button"
                    disabled={busy}
                    onClick={() => selectPolicy(p.policyId)}
                    className={`w-full text-left border px-3 py-2.5 transition-colors ${
                      p.policyId === policyId
                        ? "border-[var(--color-ink)] bg-[var(--color-paper-2)]"
                        : "border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
                    }`}
                  >
                    <span className="mono text-[0.78rem]">
                      <span className="font-bold">№ {p.policyId}</span>
                      <span className="text-[var(--color-ink-faint)]"> · </span>
                      {p.date}
                      <span className="text-[var(--color-ink-faint)]"> · </span>
                      {p.lat}, {p.lon}
                    </span>
                    <span className="block mono text-[0.7rem] text-[var(--color-ink-soft)] mt-0.5">
                      pays ${(p.payoutUsdE2 / 100).toFixed(2)} if rainfall ≥{" "}
                      {(p.rainThresholdMmE2 / 100).toFixed(1)} mm
                      {p.evidenceApproved && (
                        <span className="text-[var(--color-stamp-green)]"> · evidence on file</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>

              <button className="btn btn-ghost w-full mt-3" disabled={buying || busy} onClick={buyDemoPolicy}>
                {buying ? "Opening policy…" : "Open a demo policy — 0.1 C2FLR premium"}
              </button>
              <p className="mono text-[0.68rem] text-[var(--color-ink-faint)] mt-1.5">
                Insures a Port Harcourt address against rainfall, coverage two weeks back (the
                weather archive lags a few days). Premium paid by the demo relay wallet.
              </p>
              {buyResult && (
                <p className="mono text-[0.72rem] text-[var(--color-stamp-green)] mt-1">
                  Policy № {buyResult.policyId} opened —{" "}
                  <a className="underline" href={buyResult.txUrl} target="_blank" rel="noopener noreferrer">
                    premium tx ↗
                  </a>
                </p>
              )}
            </>
          )}
        </div>

        <div>
          <div className="doc-rule pb-2 mb-4">
            <h2 className="eyebrow">Section 2 — Evidence photograph</h2>
          </div>

          <label
            className={`block border border-dashed px-4 py-6 text-center cursor-pointer transition-colors ${
              file ? "border-[var(--color-ink)]" : "border-[var(--color-rule)] hover:bg-[var(--color-paper-2)]"
            }`}
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              disabled={busy}
              onChange={(e) => selectFile(e.target.files?.[0] ?? null)}
            />
            {previewUrl ? (
              <span className="flex items-center gap-3 justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt="Claim evidence preview" className="h-16 w-auto border border-[var(--color-rule)]" />
                <span className="mono text-[0.75rem] text-left">
                  {file?.name}
                  <br />
                  <span className="text-[var(--color-ink-faint)]">
                    {file ? `${(file.size / 1024).toFixed(0)} KB — tap to replace` : ""}
                  </span>
                </span>
              </span>
            ) : (
              <span className="mono text-[0.78rem] text-[var(--color-ink-soft)]">
                Photograph of the damage
                <br />
                <span className="text-[var(--color-ink-faint)]">
                  needs GPS + timestamp metadata — it will only ever be read inside the enclave
                </span>
              </span>
            )}
          </label>

          <button
            className="btn btn-ghost w-full mt-3"
            disabled={policyId === null || loadingSample || busy}
            onClick={loadSamplePhoto}
          >
            {loadingSample ? "Generating…" : "Use a sample photo matching this policy"}
          </button>

          {!ENCLAVE_URL && (
            <p className="mono text-[0.72rem] text-[var(--color-stamp-red)] mt-3">
              The confidential enclave is not configured (NEXT_PUBLIC_ENCLAVE_URL). Claims cannot
              be verified on this deployment.
            </p>
          )}

          {ENCLAVE_URL && attStatus === null && (
            <p className="mono text-[0.72rem] text-[var(--color-ink-faint)] mt-3">
              Verifying the chamber&rsquo;s on-chain attestation…
            </p>
          )}
          {ENCLAVE_URL && attStatus?.attested && (
            <p className="mono text-[0.72rem] text-[var(--color-stamp-green)] mt-3">
              Chamber verified before upload: live on-chain vTPM quote, container image matches
              {attStatus.expiresAt
                ? ` (quote renews before ${new Date(attStatus.expiresAt).toUTCString().slice(17, 22)} UTC)`
                : ""}
              .
            </p>
          )}
          {ENCLAVE_URL && attStatus !== null && attStatus.checked && !attStatus.attested && (
            <p className="mono text-[0.72rem] text-[var(--color-stamp-red)] mt-3">
              The chamber could not be verified on-chain — {attStatus.reason} Photo submission is
              held; the contract would reject its verdict anyway.
            </p>
          )}
          {ENCLAVE_URL && attStatus !== null && !attStatus.checked && (
            <p className="mono text-[0.72rem] text-[var(--color-stamp-amber)] mt-3">
              Could not run the pre-upload attestation check — {attStatus.reason} The chain still
              rejects unattested verdicts on submission.
            </p>
          )}
        </div>

        <button
          className="btn w-full"
          disabled={
            !file ||
            policyId === null ||
            !ENCLAVE_URL ||
            busy ||
            configured !== true ||
            (attStatus !== null && attStatus.checked && !attStatus.attested)
          }
          onClick={fileClaim}
        >
          {busy ? "Claim in progress…" : "File claim"}
        </button>

        {selected?.evidenceApproved && !selected.settled && flow.phase === "idle" && (
          <button className="btn btn-ghost w-full" disabled={busy} onClick={settleOnly}>
            Evidence already on file — run weather settlement now
          </button>
        )}

        {setupError && (
          <p className="mono text-[0.8rem] text-[var(--color-stamp-red)]">{setupError}</p>
        )}
      </section>

      {/* ── Right: the claim file, filling in live ── */}
      <section>
        <div className="doc-card p-6">
          <div className="flex items-start justify-between gap-4 doc-rule pb-3 mb-5">
            <div>
              <p className="eyebrow">Claim file</p>
              <h3 className="font-serif text-2xl mt-0.5">
                {policyId !== null ? `Policy № ${policyId}` : "No policy selected"}
              </h3>
            </div>
            <ResultStamp flow={flow} />
          </div>

          {showChain ? (
            <EvidenceChain stations={stations} />
          ) : (
            <p className="text-sm text-[var(--color-ink-soft)]">
              Select a policy and attach a photograph. The claim file fills in here as each step
              completes — confidential verification, on-chain evidence, the weather attestation,
              and the payout.
            </p>
          )}

          {flow.phase === "error" && flow.error && (
            <div className="mt-5 doc-rule border-b-0 border-t pt-3">
              <p className="mono text-[0.8rem] text-[var(--color-stamp-red)]">{flow.error}</p>
              <button className="btn btn-ghost mt-3" onClick={settleOnly}>
                Retry settlement
              </button>
            </div>
          )}

          {flow.phase === "spoofed" && flow.error && (
            <div className="mt-5 doc-rule border-b-0 border-t pt-3">
              <p className="mono text-[0.8rem] text-[var(--color-stamp-red)]">{flow.error}</p>
              <p className="text-sm text-[var(--color-ink-soft)] mt-2">
                This is the vTPM gate doing its job: ClaimPayout only accepts settlements signed by
                a key whose TEE attestation is verified on-chain.
              </p>
            </div>
          )}
        </div>

        {flow.phase === "settled" && flow.poll?.state === "settled" && (
          <p className="mono text-[0.72rem] text-[var(--color-ink-faint)] mt-3">
            Full cycle: photo → confidential verification → on-chain evidence → attested weather →{" "}
            {flow.poll.triggered ? "payout" : "settlement"}, in about{" "}
            {Math.max(1, Math.round(flow.elapsedS / 60))} minute
            {Math.round(flow.elapsedS / 60) === 1 ? "" : "s"} of oracle time, for well under a cent
            of gas. A manual claim runs $300–900 and 10–30 days.
          </p>
        )}
      </section>
    </div>
  );
}

function ResultStamp({ flow }: { flow: FlowState }) {
  if (flow.phase === "settled" && flow.poll?.state === "settled") {
    return flow.poll.triggered ? (
      <span className="stamp stamp-green shrink-0">Paid</span>
    ) : (
      <span className="stamp stamp-amber shrink-0">Not triggered</span>
    );
  }
  if (flow.phase === "rejected") return <span className="stamp stamp-red shrink-0">Rejected</span>;
  if (flow.phase === "spoofed") return <span className="stamp stamp-red shrink-0">Spoof blocked</span>;
  return null;
}

function buildStations(
  flow: FlowState,
  file: File | null,
  policy: AdjusterPolicy | null,
): Station[] {
  const { phase, claim, evidence, ticket, poll } = flow;
  const rejected = phase === "rejected";
  const spoofed = phase === "spoofed";

  // 1 — photograph
  const photo: Station = {
    id: "photo",
    title: "Damage photograph",
    status: file ? "done" : "pending",
    lines: file
      ? [{ text: `${file.name} · ${(file.size / 1024).toFixed(0)} KB — sent only to the enclave` }]
      : [{ text: "Attach the claimant's photo of the damage.", tone: "faint" }],
  };

  // 2 — confidential verification
  const enclaveLines: StationLine[] =
    claim?.checks.map((check) => ({
      text: check.finding,
      tone: check.pass ? ("green" as const) : ("red" as const),
    })) ?? [];
  if (claim) {
    enclaveLines.push(
      claim.enclave.attested
        ? {
            text: `TEE attestation issued${claim.enclave.hwModel ? ` (${claim.enclave.hwModel})` : ""}, nonce-bound to this photo's SHA-256`,
            tone: "green",
          }
        : {
            text: "Enclave ran outside Confidential Space (dev mode) — hardware attestation pending deployment",
            tone: "amber",
          },
    );
  }
  const enclave: Station = {
    id: "enclave",
    title: "Confidential verification",
    status:
      phase === "verifying" ? "active" : claim ? (claim.eligible ? "done" : "failed") : "pending",
    note: phase === "verifying" ? "photo never leaves the enclave" : undefined,
    lines: claim
      ? enclaveLines
      : [
          {
            text: "The enclave checks GPS against the insured location, capture time against coverage, and the photo against all prior claims.",
            tone: "faint",
          },
        ],
  };

  // 3 — evidence on-chain
  const chainStation: Station = {
    id: "evidence",
    title: "Evidence recorded on-chain",
    status:
      phase === "relaying"
        ? "active"
        : spoofed
          ? "failed"
          : evidence
            ? "done"
            : rejected
              ? "pending"
              : "pending",
    lines: evidence
      ? [
          { text: "Evidence accepted by ClaimPayout", href: evidence.txUrl, tone: "green" },
          evidence.attested
            ? { text: `Signer verified as attested TEE (${shortAddr(evidence.signer)})`, tone: "green" }
            : {
                text: `Signed by registered dev signer ${shortAddr(evidence.signer)} — recorded on-chain as unattested`,
                tone: "amber",
              },
        ]
      : rejected
        ? [{ text: "Not submitted — the enclave found the evidence ineligible.", tone: "red" }]
        : spoofed
          ? [{ text: "Reverted: NotAttestedTee — the signer has no live vTPM attestation.", tone: "red" }]
          : [
              {
                text: "The enclave's signed verdict is relayed to ClaimPayout, which ecrecovers the signer and checks its vTPM attestation.",
                tone: "faint",
              },
            ],
  };

  // 4 — weather attestation
  const weatherLines: StationLine[] = [];
  if (ticket) {
    weatherLines.push({
      text: `Web2Json attestation requested — voting round ${ticket.roundId}`,
      href: ticket.submitTxUrl || undefined,
    });
  }
  if (phase === "polling" && poll?.state === "waiting-finalization") {
    weatherLines.push({ text: `Round finalizing… ${flow.elapsedS}s elapsed (rounds run ≈ 90 s)` });
  }
  if (phase === "polling" && poll?.state === "waiting-proof") {
    weatherLines.push({ text: "Round finalized — fetching the Merkle proof from the DA layer…" });
  }
  if (poll?.state === "settled") {
    weatherLines.push({
      text: `${(poll.precipitationMmE2 / 100).toFixed(1)} mm rainfall attested (round ${poll.proofRound})${
        policy ? ` — threshold ${(policy.rainThresholdMmE2 / 100).toFixed(1)} mm` : ""
      }`,
      tone: poll.triggered ? "green" : "amber",
    });
  }
  const weather: Station = {
    id: "weather",
    title: "Weather attested by Flare",
    status:
      phase === "requesting-weather" || phase === "polling"
        ? "active"
        : poll?.state === "settled"
          ? "done"
          : "pending",
    note: phase === "polling" ? "FDC · Open-Meteo archive" : undefined,
    lines: weatherLines.length
      ? weatherLines
      : [
          {
            text: "Flare's Data Connector attests rainfall at the insured location and date; the contract verifies the Merkle proof itself.",
            tone: "faint",
          },
        ],
  };

  // 5 — payout
  const payout: Station = {
    id: "payout",
    title: "Payout",
    status:
      poll?.state === "settled" ? (poll.triggered ? "done" : "done") : "pending",
    lines:
      poll?.state === "settled"
        ? poll.triggered
          ? [
              {
                text: `${formatC2FLR(poll.paidWei)} C2FLR paid to the policyholder (FTSOv2 FLR/USD at settlement)`,
                href: poll.txUrl,
                tone: "green",
              },
            ]
          : [
              {
                text: "Rainfall below the policy trigger — settled with no payout.",
                href: poll.txUrl,
                tone: "amber",
              },
            ]
        : [
            {
              text: "If the attested rainfall crosses the trigger, the contract converts the USD payout via FTSOv2 and pays immediately.",
              tone: "faint",
            },
          ],
  };

  return [photo, enclave, chainStation, weather, payout];
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function formatC2FLR(wei: string): string {
  const asNumber = Number(BigInt(wei) / BigInt(1_000_000_000_000)) / 1e6;
  return asNumber.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

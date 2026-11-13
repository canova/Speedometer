// Throwaway CI diagnostic: find the smallest canvas sequence that makes Safari on the macOS CI
// VMs wait 15s in RemoteImageBufferProxy::ensureBackend and then kill the GPU process.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { Builder } from "selenium-webdriver";
import serve, { DEFAULT_CACHE_DURATION } from "../server.mjs";

const PDF_TIMEOUT_MS = 90000;
const POLL_MS = 2000;

const { server, port } = await serve(0, DEFAULT_CACHE_DURATION);
const driver = await new Builder().forBrowser("safari").build();
await driver.manage().setTimeouts({ script: 75000 });

const t0 = Date.now();
fs.mkdirSync("diag-logs", { recursive: true });
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s ${new Date().toISOString()}]`, ...args);

const pendingDumps = [];
let dumps = 0;
function spindumpWebKit(reason) {
    if (dumps >= 3)
        return;
    const n = ++dumps;
    const pids = [...gpuPids().map((p) => ["gpu", p]), ...webContentPids().slice(0, 3).map((p) => ["webcontent", p])];
    log(`STALL ${n} (${reason}): spindump ${JSON.stringify(pids)}`);
    for (const [kind, pid] of pids) {
        const child = spawn("sudo", ["-n", "spindump", pid, "3", "10", "-file", `diag-logs/spindump-${n}-${kind}-${pid}.txt`], { stdio: "ignore" });
        pendingDumps.push(new Promise((resolve) => child.on("exit", resolve).on("error", resolve)));
    }
}

function webContentPids() {
    try {
        return execFileSync("pgrep", ["-f", "com.apple.WebKit.WebContent"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

function gpuPids() {
    try {
        return execFileSync("pgrep", ["-f", "com.apple.WebKit.GPU"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

async function safeAsyncScript(label, fn, ...args) {
    try {
        return await driver.executeAsyncScript(fn, ...args);
    } catch (e) {
        log(`${label}: executeAsyncScript failed (${e.name}: ${e.message})`);
        return null;
    }
}

async function safeScript(label, fn, ...args) {
    try {
        return await driver.executeScript(fn, ...args);
    } catch (e) {
        log(`${label}: executeScript failed (${e.name}: ${e.message})`);
        return null;
    }
}

// Runs in the page. Every step is timed separately so a 15s ensureBackend wait shows up
// on the exact call that blocked.
function reproTest(name, done) {
    const steps = [];
    const start = performance.now();
    const step = (label, fn) => {
        const s = performance.now();
        try {
            const value = fn();
            steps.push({ label, ms: +(performance.now() - s).toFixed(1) });
            return value;
        } catch (e) {
            steps.push({ label, ms: +(performance.now() - s).toFixed(1), error: `${e.name}: ${e.message}` });
            return undefined;
        }
    };
    const finish = (extra = {}) => done({ name, totalMs: +(performance.now() - start).toFixed(1), steps, ...extra });
    const make = (w, h, alpha = true) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        return { c, ctx: c.getContext("2d", { alpha, willReadFrequently: false }) };
    };
    const gradientFill = ({ c, ctx }) => {
        const g = ctx.createLinearGradient(0, 0, 0, c.height);
        g.addColorStop(0, "#0e6e8c");
        g.addColorStop(1, "#9fd8e8");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, c.width, c.height);
    };
    const scratchPattern = (target) => {
        const tmp = step("create scratch canvas 512x512", () => make(512, 512));
        step("gradient fill scratch", () => gradientFill(tmp));
        const pattern = step("createPattern(scratch)", () => target.ctx.createPattern(tmp.c, "no-repeat"));
        step("fill with pattern", () => {
            if (pattern) {
                target.ctx.fillStyle = pattern;
                target.ctx.fillRect(0, 0, 100, 100);
            }
        });
    };
    const pageCanvas = () => {
        const page = step("create page canvas 820x1061 alpha:false", () => make(820, 1061, false));
        step("attach page canvas", () => document.body.append(page.c));
        return page;
    };
    const text = (page, count) =>
        step(`fillText x${count}`, () => {
            page.ctx.font = "16px serif";
            page.ctx.fillStyle = "#222";
            for (let i = 0; i < count; i++)
                page.ctx.fillText(`glyphs ${i}`, (i * 13) % 760, 20 + ((i * 7) % 1030));
        });

    if (name.startsWith("pattern-fresh")) {
        const target = step("create target 200x200", () => make(200, 200));
        scratchPattern(target);
        finish();
    } else if (name === "pattern-after-10k-text") {
        const page = pageCanvas();
        text(page, 10000);
        scratchPattern(page);
        finish();
    } else if (name === "pattern-after-10k-text-timeout") {
        const page = pageCanvas();
        let chunk = 0;
        const next = () => {
            text(page, 1000);
            if (++chunk < 10) {
                setTimeout(next, 0);
                return;
            }
            setTimeout(() => {
                scratchPattern(page);
                finish();
            }, 0);
        };
        setTimeout(next, 0);
    } else if (name === "pattern-worker-bitmap") {
        const source = `onmessage = () => {
            const canvas = new OffscreenCanvas(512, 512);
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#c2410c";
            ctx.fillRect(0, 0, 512, 512);
            ctx.fillStyle = "#fff";
            ctx.fillRect(100, 100, 200, 200);
            const bitmap = canvas.transferToImageBitmap();
            postMessage(bitmap, [bitmap]);
        };`;
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        const timeout = setTimeout(() => finish({ workerTimeout: true }), 30000);
        worker.onmessage = (e) => {
            clearTimeout(timeout);
            worker.terminate();
            const bitmap = e.data;
            const page = pageCanvas();
            step("drawImage(bitmap) into page", () => page.ctx.drawImage(bitmap, 0, 0));
            const tmp = step("create scratch canvas 512x512", () => make(512, 512));
            step("drawImage(bitmap) into scratch", () => tmp.ctx.drawImage(bitmap, 0, 0));
            step("createPattern(scratch with bitmap)", () => page.ctx.createPattern(tmp.c, "repeat"));
            finish({ bitmap: [bitmap.width, bitmap.height] });
        };
        worker.postMessage(null);
    } else if (name.startsWith("worker-")) {
        const workerCanvas = !name.startsWith("worker-plain");
        const mainAccelerated = !name.includes("main-unaccel");
        const source = workerCanvas
            ? `onmessage = () => {
                const canvas = new OffscreenCanvas(512, 512);
                const ctx = canvas.getContext("2d");
                ctx.fillStyle = "#c2410c";
                ctx.fillRect(0, 0, 512, 512);
                postMessage("worker drew to OffscreenCanvas");
            };`
            : `onmessage = () => postMessage("worker without canvas");`;
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        const timeout = setTimeout(() => finish({ workerTimeout: true }), 20000);
        worker.onmessage = (e) => {
            clearTimeout(timeout);
            steps.push({ label: `worker: ${e.data}`, ms: +(performance.now() - start).toFixed(1) });
            const make2 = (w, h, alpha = true) => {
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                return { c, ctx: c.getContext("2d", { alpha, willReadFrequently: !mainAccelerated }) };
            };
            const page = step(`create page canvas 820x1061 (${mainAccelerated ? "accelerated" : "unaccelerated"})`, () => make2(820, 1061, false));
            step("attach page canvas", () => document.body.append(page.c));
            const tmp = step("create scratch canvas 512x512", () => make2(512, 512));
            step("gradient fill scratch", () => gradientFill(tmp));
            step("createPattern(scratch)", () => page.ctx.createPattern(tmp.c, "no-repeat"));
            requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                    steps.push({ label: "two frames rendered", ms: +(performance.now() - start).toFixed(1) });
                    worker.terminate();
                    finish({ workerCanvas, mainAccelerated });
                })
            );
        };
        worker.postMessage(null);
    } else {
        finish({ error: "unknown test" });
    }
}

async function runReproTests() {
    for (const name of ["pattern-fresh", "worker-plain", "worker-offscreen-main-unaccel", "worker-offscreen", "worker-offscreen-again", "pattern-fresh-after"]) {
        await driver.get(`http://localhost:${port}/index.html`);
        const before = gpuPids();
        log(`REPRO ${name} start, GPU pids ${JSON.stringify(before)}`);
        const watchdog = setTimeout(() => spindumpWebKit(`${name} still running after 5s`), 5000);
        const result = await safeAsyncScript(`repro ${name}`, reproTest, name);
        clearTimeout(watchdog);
        const after = gpuPids();
        const slow = result?.steps?.filter((s) => s.ms > 1000) ?? [];
        log(`REPRO ${name} ${slow.length ? "SLOW" : "ok"}, GPU pids ${JSON.stringify(after)}${before.join() === after.join() ? "" : " (GPU process replaced)"}`, JSON.stringify(result));
    }
}

// Runs in the harness page: instruments the workload iframe's canvases before the step.
function instrumentPdfViewer() {
    const state = (globalThis.__repro = { patched: false, done: false, canvases: [], slow: [], frameErrors: [], counts: {} });
    const ids = new WeakMap();
    const histories = new Map();
    const HISTORY_CAP = 60;
    let nextId = 1;
    const record = (id, entry) => {
        const h = histories.get(id);
        if (!h)
            return;
        h.total++;
        h.byMethod[entry.m] = (h.byMethod[entry.m] ?? 0) + 1;
        if (h.recent.length >= HISTORY_CAP)
            h.recent.shift();
        h.recent.push(entry);
    };
    const describe = (win, value) => {
        if (value instanceof win.HTMLCanvasElement)
            return { kind: "canvas", id: ids.get(value) ?? null, size: [value.width, value.height] };
        if (typeof win.ImageBitmap !== "undefined" && value instanceof win.ImageBitmap)
            return { kind: "ImageBitmap", size: [value.width, value.height] };
        if (typeof win.HTMLImageElement !== "undefined" && value instanceof win.HTMLImageElement)
            return { kind: "img", size: [value.naturalWidth, value.naturalHeight] };
        return { kind: Object.prototype.toString.call(value) };
    };
    const snapshot = (id) => {
        const h = histories.get(id);
        return h ? { id, info: h.info, total: h.total, byMethod: h.byMethod, recent: h.recent.slice() } : null;
    };
    const patch = (win) => {
        const t = () => +win.performance.now().toFixed(1);
        const canvasProto = win.HTMLCanvasElement.prototype;
        const origGetContext = canvasProto.getContext;
        canvasProto.getContext = function (type, options) {
            const ctx = origGetContext.call(this, type, options);
            if (type === "2d" && ctx && !ids.has(this)) {
                const id = nextId++;
                ids.set(this, id);
                const info = { id, created: t(), size: [this.width, this.height], options: options ?? null, attached: this.isConnected };
                histories.set(id, { info, total: 0, byMethod: {}, recent: [] });
                if (state.canvases.length < 400)
                    state.canvases.push(info);
            }
            return ctx;
        };
        for (const prop of ["width", "height"]) {
            const desc = Object.getOwnPropertyDescriptor(canvasProto, prop);
            Object.defineProperty(canvasProto, prop, {
                ...desc,
                set(value) {
                    const id = ids.get(this);
                    if (id)
                        record(id, { m: `set ${prop}`, v: value, t: t() });
                    desc.set.call(this, value);
                },
            });
        }
        const ctxProto = win.CanvasRenderingContext2D.prototype;
        const watched = new Set(["createPattern", "drawImage", "getImageData", "putImageData"]);
        for (const name of Object.getOwnPropertyNames(ctxProto)) {
            const desc = Object.getOwnPropertyDescriptor(ctxProto, name);
            if (typeof desc.value !== "function" || name === "constructor")
                continue;
            const orig = desc.value;
            ctxProto[name] = function (...args) {
                state.counts[name] = (state.counts[name] ?? 0) + 1;
                const id = ids.get(this.canvas);
                const entry = { m: name, t: t() };
                if (watched.has(name)) {
                    entry.src = describe(win, args[0]);
                    entry.args = args.slice(1, 5).map((a) => (typeof a === "number" ? +a.toFixed(1) : typeof a));
                }
                if (id)
                    record(id, entry);
                if (!watched.has(name))
                    return orig.apply(this, args);
                const sourceId = entry.src?.kind === "canvas" ? entry.src.id : null;
                const before = { target: id ? snapshot(id) : null, source: sourceId ? snapshot(sourceId) : null };
                const start = win.performance.now();
                let error = null;
                try {
                    return orig.apply(this, args);
                } catch (e) {
                    error = `${e.name}: ${e.message}`;
                    throw e;
                } finally {
                    const ms = win.performance.now() - start;
                    if (error && id)
                        record(id, { m: `${name} threw`, error, t: t() });
                    if (ms > 1000 && state.slow.length < 10)
                        state.slow.push({ method: name, ms: +ms.toFixed(0), at: +start.toFixed(1), error, target: before.target, source: before.source, sourceDesc: entry.src });
                }
            };
        }
        win.addEventListener("unhandledrejection", (e) => state.frameErrors.push(`${e.reason?.name}: ${e.reason?.message}`));
        state.patched = true;
    };
    const timer = setInterval(() => {
        const win = document.querySelector("iframe")?.contentWindow;
        if (!win || state.patched)
            return;
        try {
            if (win.location.href.includes("pdf-viewer") && win.document.readyState !== "loading")
                patch(win);
        } catch {}
    }, 5);
    addEventListener("SpeedometerDone", () => {
        state.done = true;
        clearInterval(timer);
    });
    globalThis.benchmarkClient.start();
}

async function runPdfViewer() {
    await driver.get(`http://localhost:${port}/index.html?suites=PDFViewer-PDFjs&iterationCount=1`);
    await safeAsyncScript("ready", (cb) => (globalThis.benchmarkClient ? cb() : addEventListener("SpeedometerReady", () => cb(), { once: true })));
    log(`PDF start, GPU pids ${JSON.stringify(gpuPids())}`);
    await safeScript("instrument", instrumentPdfViewer);
    const start = Date.now();
    let reported = 0;
    while (Date.now() - start < PDF_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const s = await safeScript("poll", () => {
            const r = globalThis.__repro;
            return { patched: r.patched, done: r.done, counts: r.counts, slow: r.slow, frameErrors: r.frameErrors, canvasCount: r.canvases.length };
        });
        if (!s)
            continue;
        for (const slow of s.slow.slice(reported)) {
            log(`PDF SLOW CALL ${slow.method} took ${slow.ms}ms at ${slow.at}ms${slow.error ? ` and threw ${slow.error}` : ""}, GPU pids ${JSON.stringify(gpuPids())}`);
            log("  source", JSON.stringify(slow.sourceDesc));
            log("  source canvas history", JSON.stringify(slow.source));
            log("  target canvas history", JSON.stringify(slow.target));
        }
        reported = s.slow.length;
        if (s.done || (s.slow.length >= 2 && Date.now() - start > 45000))
            break;
    }
    const canvases = await safeScript("canvases", () => globalThis.__repro.canvases);
    log(`PDF end after ${(Date.now() - start) / 1000}s, GPU pids ${JSON.stringify(gpuPids())}`);
    log("PDF canvases (creation order)", JSON.stringify(canvases));
    log("PDF counts", JSON.stringify((await safeScript("counts", () => globalThis.__repro.counts)) ?? {}));
    log("PDF frame errors", JSON.stringify((await safeScript("errors", () => globalThis.__repro.frameErrors)) ?? []));
}

try {
    await runReproTests();
    log(`waiting for ${pendingDumps.length} spindump(s)`);
    await Promise.race([Promise.all(pendingDumps), new Promise((resolve) => setTimeout(resolve, 180000))]);
} finally {
    await driver.quit().catch(() => {});
    server.close();
}

// Throwaway CI diagnostic: why does PDFViewer-PDFjs with enableHWA never finish in CI Safari?
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { Builder } from "selenium-webdriver";
import serve, { DEFAULT_CACHE_DURATION } from "../server.mjs";

const RUN_TIMEOUT_MS = 90000;
const POLL_MS = 2000;

const { server, port } = await serve(0, DEFAULT_CACHE_DURATION);
const driver = await new Builder().forBrowser("safari").build();
await driver.manage().setTimeouts({ script: 30000 });

const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s ${new Date().toISOString()}]`, ...args);

// When a WebDriver call stalls, the page is usually blocked on the GPU process, so take
// kernel stack snapshots of the WebKit processes while the stall is still happening.
const LOG_DIR = "diag-logs";
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS ?? 4000);
const MAX_STALLS = 3;
fs.mkdirSync(LOG_DIR, { recursive: true });
const pendingDumps = [];
let stallCount = 0;

function pidsMatching(pattern) {
    try {
        return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

function captureStacks(reason) {
    if (stallCount >= MAX_STALLS)
        return;
    const stall = ++stallCount;
    const targets = [...pidsMatching("com.apple.WebKit.GPU").map((pid) => ["gpu", pid]), ...pidsMatching("com.apple.WebKit.WebContent").slice(0, 4).map((pid) => ["webcontent", pid])];
    log(`STALL ${stall} (${reason}): spindump ${JSON.stringify(targets)}`);
    for (const [kind, pid] of targets) {
        const file = `${LOG_DIR}/spindump-stall${stall}-${kind}-${pid}.txt`;
        const child = spawn("sudo", ["-n", "spindump", pid, "3", "10", "-file", file], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        pendingDumps.push(
            new Promise((resolve) => {
                child.on("exit", (code) => {
                    log(`spindump ${file} exit=${code}${stderr ? ` stderr=${stderr.trim().slice(0, 200)}` : ""}`);
                    resolve();
                });
                child.on("error", (e) => {
                    log(`spindump ${file} error=${e.message}`);
                    resolve();
                });
            })
        );
    }
}

async function watched(label, promise) {
    const timer = setTimeout(() => captureStacks(`${label} still running after ${WATCHDOG_MS}ms`), WATCHDOG_MS);
    try {
        return await promise;
    } finally {
        clearTimeout(timer);
    }
}

async function safeScript(label, fn, ...args) {
    try {
        return await watched(label, driver.executeScript(fn, ...args));
    } catch (e) {
        log(`${label}: executeScript failed (${e.name}: ${e.message})`);
        return null;
    }
}

async function safeAsyncScript(label, fn, ...args) {
    try {
        return await watched(label, driver.executeAsyncScript(fn, ...args));
    } catch (e) {
        log(`${label}: executeAsyncScript failed (${e.name}: ${e.message})`);
        return null;
    }
}

async function envInfo() {
    const info = await safeScript("env", () => {
        const gl = document.createElement("canvas").getContext("webgl");
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        return {
            ua: navigator.userAgent,
            dpr: devicePixelRatio,
            webglRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : "no webgl",
            webglVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        };
    });
    log("ENV", JSON.stringify(info));
}

// Mimics pdf.js _scaleImage: halve a large canvas repeatedly through two scratch canvases.
async function microbench(willReadFrequently, op) {
    const result = await safeAsyncScript(
        `microbench wrf=${willReadFrequently} op=${op}`,
        (wrf, op, done) => {
            const make = (w, h) => {
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                return { c, ctx: c.getContext("2d", { willReadFrequently: wrf }) };
            };
            const start = performance.now();
            const src = make(1600, 2000);
            for (let i = 0; i < 200; i++) {
                src.ctx.fillStyle = `rgb(${i},${(i * 7) % 255},${(i * 13) % 255})`;
                src.ctx.fillRect((i * 37) % 1500, (i * 53) % 1900, 100, 100);
            }
            const dest = make(400, 500);
            let ops = 0;
            if (op === "scale") {
                for (let rep = 0; rep < 20; rep++) {
                    let read = make(1, 1);
                    let write = make(1, 1);
                    let source = src.c;
                    let w = 1600;
                    let h = 2000;
                    for (let step = 0; step < 4; step++) {
                        const nw = Math.ceil(w / 2);
                        const nh = Math.ceil(h / 2);
                        write.c.width = nw;
                        write.c.height = nh;
                        write.ctx.drawImage(source, 0, 0, w, h, 0, 0, nw, nh);
                        ops++;
                        source = write.c;
                        w = nw;
                        h = nh;
                        [read, write] = [write, read];
                    }
                    dest.ctx.drawImage(source, 0, 0, w, h, 0, 0, 400, 500);
                    ops++;
                }
            } else {
                dest.ctx.font = "16px sans-serif";
                for (let i = 0; i < 4000; i++) {
                    dest.ctx.fillText(`glyphs ${i}`, (i * 17) % 380, (i * 11) % 500);
                    ops++;
                }
            }
            const issued = performance.now();
            dest.ctx.getImageData(0, 0, 1, 1);
            done({ ops, issueMs: issued - start, totalMs: performance.now() - start });
        },
        willReadFrequently,
        op
    );
    log(`MICROBENCH willReadFrequently=${willReadFrequently} op=${op}`, JSON.stringify(result));
}

async function runPdfViewer() {
    await driver.get(`http://localhost:${port}/index.html?suites=PDFViewer-PDFjs&iterationCount=1`);
    await safeAsyncScript("ready", (cb) => (globalThis.benchmarkClient ? cb() : addEventListener("SpeedometerReady", () => cb(), { once: true })));
    await envInfo();
    await safeScript("instrument", () => {
        const state = (globalThis.__diag = { done: false, error: null, patched: false, counts: {}, last: 0, contexts: [], exceptions: [], frameErrors: [] });
        const methods = ["drawImage", "fillText", "fill", "stroke", "putImageData", "getImageData", "fillRect", "clip", "save", "restore"];
        const patch = (win) => {
            const proto = win.CanvasRenderingContext2D.prototype;
            for (const name of methods) {
                const orig = proto[name];
                proto[name] = function (...args) {
                    state.counts[name] = (state.counts[name] ?? 0) + 1;
                    state.last = performance.now();
                    try {
                        return orig.apply(this, args);
                    } catch (e) {
                        if (state.exceptions.length < 10) {
                            const source = args[0] instanceof win.HTMLCanvasElement ? { canvas: [args[0].width, args[0].height] } : { arg0: Object.prototype.toString.call(args[0]) };
                            state.exceptions.push({ method: name, name: e.name, message: e.message, dest: [this.canvas.width, this.canvas.height], destAttrs: this.getContextAttributes?.(), ...source, stack: String(e.stack).split("\n").slice(0, 6).join(" | ") });
                        }
                        throw e;
                    }
                };
            }
            const origGetContext = win.HTMLCanvasElement.prototype.getContext;
            win.HTMLCanvasElement.prototype.getContext = function (type, options) {
                if (state.contexts.length < 5)
                    state.contexts.push({ type, options, w: this.width, h: this.height });
                state.counts.getContext = (state.counts.getContext ?? 0) + 1;
                return origGetContext.call(this, type, options);
            };
            win.addEventListener("error", (e) => state.frameErrors.push(`error: ${e.message}`));
            win.addEventListener("unhandledrejection", (e) => state.frameErrors.push(`unhandledrejection: ${e.reason?.name}: ${e.reason?.message} | ${String(e.reason?.stack).split("\n").slice(0, 6).join(" | ")}`));
            state.patched = true;
        };
        const timer = setInterval(() => {
            const frame = document.querySelector("iframe");
            const win = frame?.contentWindow;
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
        addEventListener("error", (e) => (state.error = String(e.message)));
        addEventListener("unhandledrejection", (e) => (state.error = `${e.reason} ${e.reason?.stack}`));
        globalThis.benchmarkClient.start();
    });

    const start = Date.now();
    let lastLine = "";
    while (Date.now() - start < RUN_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const s = await safeScript("poll", () => {
            const d = globalThis.__diag;
            const frame = document.querySelector("iframe");
            let frameText = "";
            try {
                frameText = frame?.contentDocument?.getElementById("viewer")?.textContent?.slice(0, 120) ?? "";
            } catch {}
            return { ...d, sinceLastCallMs: d.last ? Math.round(performance.now() - d.last) : null, progress: document.getElementById("info-progress")?.textContent, frameText };
        });
        if (!s) {
            log("PDF: harness page did not answer executeScript; main thread likely blocked");
            continue;
        }
        const line = JSON.stringify({ patched: s.patched, counts: s.counts, progress: s.progress, frameText: s.frameText, exceptions: s.exceptions, frameErrors: s.frameErrors });
        if (line !== lastLine || s.done || s.error)
            log("PDF", line, `sinceLastCallMs=${s.sinceLastCallMs}`);
        lastLine = line;
        if (s.contexts?.length && !globalThis.__printedContexts) {
            globalThis.__printedContexts = true;
            log("PDF contexts", JSON.stringify(s.contexts));
        }
        if (s.error) {
            log("PDF ERROR", s.error);
            return;
        }
        if (s.done) {
            const values = await safeScript("metrics", () => globalThis.benchmarkClient.metrics["PDFViewer-PDFjs"]?.values);
            log(`PDF DONE after ${(Date.now() - start) / 1000}s, per-iteration ms:`, JSON.stringify(values));
            return;
        }
    }
    log(`PDF TIMEOUT after ${RUN_TIMEOUT_MS / 1000}s`);
}

async function primitives() {
    const result = await safeScript("primitives", () => {
        const make = (accelerated, w = 200, h = 200) => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const ctx = c.getContext("2d", { willReadFrequently: !accelerated });
            ctx.fillStyle = "rgb(200,100,50)";
            ctx.fillRect(0, 0, w, h);
            return { c, ctx };
        };
        const attempt = (label, fn) => {
            const start = performance.now();
            try {
                fn();
                return { label, ok: true, ms: +(performance.now() - start).toFixed(2) };
            } catch (e) {
                return { label, ok: false, ms: +(performance.now() - start).toFixed(2), name: e.name, message: e.message };
            }
        };
        const img = new Image(4, 4);
        return [
            attempt("fillText accel", () => make(true).ctx.fillText("x", 10, 10)),
            attempt("drawImage accel->accel", () => make(true).ctx.drawImage(make(true).c, 0, 0)),
            attempt("drawImage accel->accel scaled", () => make(true, 100, 100).ctx.drawImage(make(true).c, 0, 0, 200, 200, 0, 0, 100, 100)),
            attempt("drawImage accel->unaccel", () => make(false).ctx.drawImage(make(true).c, 0, 0)),
            attempt("drawImage unaccel->accel", () => make(true).ctx.drawImage(make(false).c, 0, 0)),
            attempt("drawImage unaccel->unaccel", () => make(false).ctx.drawImage(make(false).c, 0, 0)),
            attempt("getImageData accel", () => make(true).ctx.getImageData(0, 0, 1, 1)),
            attempt("getImageData unaccel", () => make(false).ctx.getImageData(0, 0, 1, 1)),
            attempt("putImageData accel", () => {
                const { ctx } = make(true);
                ctx.putImageData(ctx.createImageData(10, 10), 0, 0);
            }),
            attempt("createPattern accel", () => make(true).ctx.createPattern(make(true).c, "repeat")),
            attempt("toDataURL accel", () => make(true).c.toDataURL()),
            attempt("drawImage accel->accel after getImageData-free draws x20", () => {
                const dest = make(true);
                for (let i = 0; i < 20; i++)
                    dest.ctx.drawImage(make(true, 300, 300).c, 0, 0);
            }),
        ];
    });
    for (const row of result ?? [])
        log("PRIMITIVE", JSON.stringify(row));
}

// The candidates for what wedges the GPU process: page-sized accelerated canvases that get
// composited (pdf.js page canvases are alpha: false), and a 2D OffscreenCanvas in a worker.
async function displayPrimitives() {
    for (const test of ["opaque-820x1061", "alpha-820x1061", "worker-offscreen-820x1061"]) {
        const result = await safeAsyncScript(
            `display ${test}`,
            (test, done) => {
                const start = performance.now();
                const elapsed = () => +(performance.now() - start).toFixed(1);
                const afterFrames = (canvas, ctx) =>
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => {
                            let pattern;
                            try {
                                ctx.createPattern(canvas, "repeat");
                                pattern = "ok";
                            } catch (e) {
                                pattern = `${e.name}: ${e.message}`;
                            }
                            canvas.remove();
                            done({ ms: elapsed(), pattern });
                        })
                    );
                if (test.startsWith("worker")) {
                    const source = `onmessage = () => {
                        const t = performance.now();
                        const canvas = new OffscreenCanvas(820, 1061);
                        const ctx = canvas.getContext("2d");
                        ctx.fillStyle = "#336699";
                        ctx.fillRect(0, 0, 820, 1061);
                        ctx.font = "16px sans-serif";
                        for (let i = 0; i < 500; i++)
                            ctx.fillText("glyphs " + i, (i * 13) % 760, (i * 7) % 1040);
                        const bitmap = canvas.transferToImageBitmap();
                        postMessage({ workerMs: performance.now() - t, width: bitmap.width }, [bitmap]);
                    };`;
                    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
                    const timeout = setTimeout(() => done({ ms: elapsed(), timeout: true }), 25000);
                    worker.onerror = (e) => {
                        clearTimeout(timeout);
                        done({ ms: elapsed(), error: String(e.message) });
                    };
                    worker.onmessage = (e) => {
                        clearTimeout(timeout);
                        worker.terminate();
                        done({ ms: elapsed(), ...e.data });
                    };
                    worker.postMessage(null);
                    return;
                }
                const canvas = document.createElement("canvas");
                canvas.width = 820;
                canvas.height = 1061;
                const ctx = canvas.getContext("2d", { alpha: !test.startsWith("opaque"), willReadFrequently: false });
                const gradient = ctx.createLinearGradient(0, 0, 0, 1061);
                gradient.addColorStop(0, "#d9d9d9");
                gradient.addColorStop(1, "#141414");
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, 820, 1061);
                ctx.fillStyle = "#fff";
                ctx.font = "16px sans-serif";
                for (let i = 0; i < 500; i++)
                    ctx.fillText(`glyphs ${i}`, (i * 13) % 760, (i * 7) % 1040);
                document.body.append(canvas);
                afterFrames(canvas, ctx);
            },
            test
        );
        log("DISPLAY", test, JSON.stringify(result));
    }
}

try {
    log("WebKit processes at start", JSON.stringify({ gpu: pidsMatching("com.apple.WebKit.GPU"), webcontent: pidsMatching("com.apple.WebKit.WebContent") }));
    await driver.get(`http://localhost:${port}/index.html`);
    await envInfo();
    await primitives();
    await displayPrimitives();
    await runPdfViewer();
    log("WebKit processes at end", JSON.stringify({ gpu: pidsMatching("com.apple.WebKit.GPU"), webcontent: pidsMatching("com.apple.WebKit.WebContent") }));
    log(`waiting for ${pendingDumps.length} spindump(s)`);
    await Promise.race([Promise.all(pendingDumps), new Promise((resolve) => setTimeout(resolve, 180000))]);
} finally {
    await driver.quit().catch(() => {});
    server.close();
}

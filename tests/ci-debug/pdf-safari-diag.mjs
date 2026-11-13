// Throwaway CI diagnostic: why does PDFViewer-PDFjs with enableHWA never finish in CI Safari?
import { Builder } from "selenium-webdriver";
import serve, { DEFAULT_CACHE_DURATION } from "../server.mjs";

const RUN_TIMEOUT_MS = 240000;
const POLL_MS = 2000;

const { server, port } = await serve(0, DEFAULT_CACHE_DURATION);
const driver = await new Builder().forBrowser("safari").build();
await driver.manage().setTimeouts({ script: 30000 });

const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);

async function safeScript(label, fn, ...args) {
    try {
        return await driver.executeScript(fn, ...args);
    } catch (e) {
        log(`${label}: executeScript failed (${e.name}: ${e.message})`);
        return null;
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
        const state = (globalThis.__diag = { done: false, error: null, patched: false, counts: {}, last: 0, contexts: [] });
        const methods = ["drawImage", "fillText", "fill", "stroke", "putImageData", "getImageData", "fillRect", "clip", "save", "restore"];
        const patch = (win) => {
            const proto = win.CanvasRenderingContext2D.prototype;
            for (const name of methods) {
                const orig = proto[name];
                proto[name] = function (...args) {
                    state.counts[name] = (state.counts[name] ?? 0) + 1;
                    state.last = performance.now();
                    return orig.apply(this, args);
                };
            }
            const origGetContext = win.HTMLCanvasElement.prototype.getContext;
            win.HTMLCanvasElement.prototype.getContext = function (type, options) {
                if (state.contexts.length < 5)
                    state.contexts.push({ type, options, w: this.width, h: this.height });
                state.counts.getContext = (state.counts.getContext ?? 0) + 1;
                return origGetContext.call(this, type, options);
            };
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
        const line = JSON.stringify({ patched: s.patched, counts: s.counts, progress: s.progress, frameText: s.frameText });
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

try {
    await driver.get(`http://localhost:${port}/index.html`);
    await envInfo();
    for (const op of ["scale", "text"]) {
        for (const wrf of [true, false])
            await microbench(wrf, op);
    }
    await runPdfViewer();
} finally {
    await driver.quit().catch(() => {});
    server.close();
}

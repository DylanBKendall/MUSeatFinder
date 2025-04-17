/**
 * @file seat-finder.js
 * @author Dylan Kendall
 * @date 2024‑11‑23 (rev. 2025‑04‑17)
 * @version 2.0
 *
 * @brief Automated course‑seat availability checker for Miami University.
 *
 * Major improvements (v2.0)
 * ------------------------
 * • Environment‑driven configuration (interval, SMTP creds, Puppeteer flags).
 * • Loop‑based polling (eliminates deep recursion & stack growth).
 * • Automatic retry / back‑off on transient page failures.
 * • Graceful shutdown on SIGINT / SIGTERM.
 * • Stronger validation & error messages.
 * • Dead‑code removal and tighter dependency list.
 *
 * ENV VARIABLES (optional)
 * -----------------------
 * SEAT_CHECK_INTERVAL   – milliseconds between checks   (default 120000)
 * HEADLESS              – "true" | "false"            (default "true")
 * PUPPETEER_SLOWMO      – slow‑mo delay ms             (default 0)
 * SMTP_HOST / PORT / USER / PASS – override MU mail settings if needed
 *
 * Requires: nodemailer, puppeteer, prompt-sync, dns (builtin)
 */

import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import promptSync from 'prompt-sync';
import dns from 'dns';
import { promisify } from 'util';

/* ------------------------------------------------------------------
 * Configuration
 * ----------------------------------------------------------------*/
const DNS_LOOKUP = promisify(dns.lookup);
const PROMPT = promptSync({ sigint: true });
const CHECK_INTERVAL = Number(process.env.SEAT_CHECK_INTERVAL) || 120000;
const MIAMI_DNS = 'mualmaip11.mcs.miamioh.edu';
const MIAMI_COURSE_URL = 'https://www.apps.miamioh.edu/courselist/';
const MIAMI_EMAIL_DOMAIN = '@miamioh.edu';

/* ------------------------------------------------------------------
 * Course monitor helpers
 * ----------------------------------------------------------------*/
class CourseMonitor {
    constructor() {
        this.courses = new Map();
        this.confirmationSent = false;
    }
    add(crn) {
        this.courses.set(crn, { notified: false });
    }
    delete(crn) {
        this.courses.delete(crn);
    }
    get all() {
        return [...this.courses.keys()];
    }
    get size() {
        return this.courses.size;
    }
}

const monitor = new CourseMonitor();
let termCode = '';
let browser; // will hold the Puppeteer instance for cleanup

/* ------------------------------------------------------------------
 * Network helpers
 * ----------------------------------------------------------------*/
async function checkMiamiConnection() {
    try {
        await DNS_LOOKUP(MIAMI_DNS);
        return true;
    } catch {
        return false;
    }
}

/* ------------------------------------------------------------------
 * Email helpers
 * ----------------------------------------------------------------*/
function createTransport(userEmail) {
    const host = process.env.SMTP_HOST || MIAMI_DNS;
    const port = Number(process.env.SMTP_PORT) || 587;
    const authUser = process.env.SMTP_USER || userEmail;
    const authPass = process.env.SMTP_PASS;

    const cfg = {
        host,
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
    };
    if (authPass) cfg.auth = { user: authUser, pass: authPass };
    else cfg.auth = { user: authUser }; // MU mail uses single‑factor user auth

    return nodemailer.createTransport(cfg);
}

async function sendMail(transporter, subject, text, to) {
    const opts = { from: to, to, subject, text };
    await transporter.sendMail(opts);
}

/* ------------------------------------------------------------------
 * Puppeteer helpers
 * ----------------------------------------------------------------*/
function buildLaunchOpts() {
    return {
        headless: process.env.HEADLESS !== 'false',
        slowMo: Number(process.env.PUPPETEER_SLOWMO) || 0,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };
}

async function withRetry(fn, attempts = 3, delay = 2000) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            if (i < attempts - 1) await new Promise(res => setTimeout(res, delay));
        }
    }
    throw lastErr;
}

/* ------------------------------------------------------------------
 * Seat‑checking logic (single polling iteration)
 * ----------------------------------------------------------------*/
async function pollOnce(email, transporter, page) {
    // Ensure term filter is set (selector may change – use robust logic)
    await page.waitForSelector('#termFilter', { timeout: 60000 });
    await page.select('#termFilter', termCode);

    // Select Oxford campus (if present)
    await page.waitForSelector('.ms-choice');
    await page.click('.ms-choice');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const label = [...document.querySelectorAll('label')].find(l => /Oxford/i.test(l.textContent));
        label?.querySelector('input[type="checkbox"]')?.click();
    });
    await page.click('body');
    await page.click('#advancedLink');

    // Iterate monitored CRNs
    for (const crn of monitor.all) {
        await page.$eval('#crnNumber', el => (el.value = ''));
        await page.type('#crnNumber', crn);
        await page.click('#courseSearch');

        try {
            await page.waitForSelector(`#statusMessage${crn}`, { timeout: 7000 });
            const status = await page.$eval(`#statusMessage${crn}`, el => el.innerText.trim());
            const [current, max] = status.split('/').map(Number);
            if (max - current > 0) {
                const body = `Good news! CRN ${crn} now shows ${current}/${max} enrolled ( ${max - current} open seat(s) ).`;
                await sendMail(transporter, `Seat available for CRN ${crn}`, body, email);
                console.log(`Notification sent for CRN ${crn}.`);
                monitor.delete(crn);
            } else {
                console.log(`CRN ${crn}: ${current}/${max}`);
            }
        } catch (err) {
            console.error(`CRN ${crn}: failed to read status –`, err.message);
        }
    }
}

/* ------------------------------------------------------------------
 * Main loop
 * ----------------------------------------------------------------*/
async function seatFinder(email) {
    const transporter = createTransport(email);

    // Send confirmation once
    if (!monitor.confirmationSent) {
        const body = `Monitoring CRNs: ${monitor.all.join(', ')}\nPolling every ${CHECK_INTERVAL / 1000}s.`;
        await sendMail(transporter, 'MU Seat Finder monitoring started', body, email);
        monitor.confirmationSent = true;
    }

    browser = await puppeteer.launch(buildLaunchOpts());
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(45000);

    let running = true;
    const cleanup = async () => {
        running = false;
        if (browser) await browser.close();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    while (running && monitor.size) {
        // Ensure connectivity
        if (!(await checkMiamiConnection())) {
            console.error('✖ Not on MU network – waiting 60s and retrying');
            await new Promise(r => setTimeout(r, 60000));
            continue;
        }

        // Load page with retry/back‑off
        await withRetry(() => page.goto(MIAMI_COURSE_URL, { waitUntil: 'networkidle0' }));

        await pollOnce(email, transporter, page);

        if (monitor.size) {
            await new Promise(r => setTimeout(r, CHECK_INTERVAL));
        }
    }

    console.log('No more CRNs to monitor – exiting.');
    await cleanup();
    process.exit(0);
}

/* ------------------------------------------------------------------
 * CLI setup & bootstrap
 * ----------------------------------------------------------------*/
(async function main() {
    try {
        console.clear();
        console.log('\n=== MU Course Seat Finder ===');

        // Email
        const email = PROMPT('Miami email (uniqueid@miamioh.edu): ').trim();
        if (!email.endsWith(MIAMI_EMAIL_DOMAIN)) throw new Error('Invalid Miami email.');

        // Year + term code
        const year = PROMPT('School year (e.g., 2026 for 2025‑26): ').trim();
        const termChoice = PROMPT('Term (1:Fall 2:Winter 3:Spring 4:Summer): ').trim();
        const termMap = Object.freeze({ 1: '10', 2: '15', 3: '20', 4: '30' });
        if (!termMap[termChoice]) throw new Error('Invalid term.');
        termCode = `${year}${termMap[termChoice]}`;
        if (!/^\d{6}$/.test(termCode)) throw new Error('Generated term code must be 6 digits.');

        // CRN input loop
        while (true) {
            const crn = PROMPT('Enter CRN (or return to finish): ').trim();
            if (!crn) {
                if (monitor.size) break;
                console.log('Add at least one CRN.');
                continue;
            }
            monitor.add(crn);
            console.log(`Added CRN ${crn}.`);
        }

        // Final MU network check
        if (!(await checkMiamiConnection())) {
            throw new Error('Not connected to MU network/VPN.');
        }

        await seatFinder(email);
    } catch (err) {
        console.error('Fatal:', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();

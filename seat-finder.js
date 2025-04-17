/**
 * @file seat-finder.js
 * @author Dylan Kendall
 * @date 2024‑11‑23 (rev. 2025‑04‑17)
 * @version 2.1
 *
 * @brief Automated course‑seat availability checker for Miami University.
 *
 * v2.1 tweaks
 * -----------
 * • Removed duplicate page navigation and replaced deprecated `page.waitForTimeout()`.
 * • Added tiny `sleep()` helper for readability.
 * • Hardened CRN input handling and selector waits.
 * • Minor logging & comment polish.
 *
 * ENV VARIABLES (optional)
 * -----------------------
 * SEAT_CHECK_INTERVAL   – milliseconds between checks   (default 120000)
 * HEADLESS              – "true" | "false"            (default "true")
 * PUPPETEER_SLOWMO      – slow‑mo delay ms             (default 0)
 * SMTP_*                – override MU SMTP settings (HOST, PORT, USER, PASS)
 */

import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import promptSync from 'prompt-sync';
import dns from 'dns';
import { promisify } from 'util';

/* ------------------------------------------------------------------
 * Util & config
 * ----------------------------------------------------------------*/
const DNS_LOOKUP = promisify(dns.lookup);
const PROMPT = promptSync({ sigint: true });
const CHECK_INTERVAL = Number(process.env.SEAT_CHECK_INTERVAL) || 120_000;
const MIAMI_DNS = 'mualmaip11.mcs.miamioh.edu';
const MIAMI_COURSE_URL = 'https://www.apps.miamioh.edu/courselist/';
const MIAMI_EMAIL_DOMAIN = '@miamioh.edu';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------
 * Course monitor helpers
 * ----------------------------------------------------------------*/
class CourseMonitor {
    #courses = new Map();
    confirmationSent = false;

    add(crn) { this.#courses.set(crn, {}); }
    delete(crn) { this.#courses.delete(crn); }
    get all() { return [...this.#courses.keys()]; }
    get size() { return this.#courses.size; }
}

const monitor = new CourseMonitor();
let termCode = '';
let browser; // Puppeteer instance for cleanup on exit

/* ------------------------------------------------------------------
 * Network helpers
 * ----------------------------------------------------------------*/
async function checkMiamiConnection() {
    try { await DNS_LOOKUP(MIAMI_DNS); return true; }
    catch { return false; }
}

/* ------------------------------------------------------------------
 * Email helpers
 * ----------------------------------------------------------------*/
function createTransport(userEmail) {
    const host = process.env.SMTP_HOST || MIAMI_DNS;
    const port = Number(process.env.SMTP_PORT) || 587;
    const authUser = process.env.SMTP_USER || userEmail;
    const authPass = process.env.SMTP_PASS;
    return nodemailer.createTransport({
        host,
        port,
        secure: false,
        tls: { rejectUnauthorized: false },
        auth: authPass ? { user: authUser, pass: authPass } : { user: authUser }
    });
}

async function sendMail(transporter, subject, text, to) {
    await transporter.sendMail({ from: to, to, subject, text });
}

/* ------------------------------------------------------------------
 * Puppeteer helpers
 * ----------------------------------------------------------------*/
function buildLaunchOpts() {
    return {
        headless: process.env.HEADLESS !== 'false',
        slowMo: Number(process.env.PUPPETEER_SLOWMO) || 0,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
}

async function withRetry(fn, attempts = 3, delay = 2000) {
    let err;
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) { err = e; if (i < attempts - 1) await sleep(delay); }
    }
    throw err;
}

/* ------------------------------------------------------------------
 * Seat‑checking logic (single polling iteration)
 * ----------------------------------------------------------------*/
async function pollOnce(email, transporter, page) {
    // Wait for #termFilter after initial navigation (done in main loop)
    await page.waitForSelector('#termFilter', { timeout: 60_000 });
    await page.select('#termFilter', termCode);

    /* Select Oxford campus */
    await page.waitForSelector('.ms-choice');
    await page.click('.ms-choice');
    await sleep(500);
    await page.evaluate(() => {
        const lbl = [...document.querySelectorAll('label')].find(l => /Oxford/i.test(l.textContent));
        lbl?.querySelector('input[type="checkbox"]')?.click();
    });
    await page.click('body');
    await page.click('#advancedLink');

    /* Iterate CRNs */
    for (const crn of monitor.all) {
        await page.waitForSelector('#crnNumber');
        await page.$eval('#crnNumber', el => (el.value = ''));
        await page.type('#crnNumber', crn);
        await page.click('#courseSearch');

        try {
            await page.waitForSelector(`#statusMessage${crn}`, { timeout: 7_000 });
            const status = await page.$eval(`#statusMessage${crn}`, el => el.innerText.trim());
            const [current, max] = status.split('/').map(Number);
            if (max - current > 0) {
                const body = `Good news! CRN ${crn} now shows ${current}/${max} enrolled (${max - current} seat(s) open).`;
                await sendMail(transporter, `Seat available for CRN ${crn}`, body, email);
                console.log(`✔ Notification sent for CRN ${crn}.`);
                monitor.delete(crn);
            } else {
                console.log(`CRN ${crn}: ${current}/${max}`);
            }
        } catch (e) {
            console.error(`CRN ${crn}: could not fetch status –`, e.message);
        }
    }
}

/* ------------------------------------------------------------------
 * Main seat‑finder loop
 * ----------------------------------------------------------------*/
async function seatFinder(email) {
    const transporter = createTransport(email);

    if (!monitor.confirmationSent) {
        await sendMail(transporter,
            'MU Seat Finder monitoring started',
            `Monitoring CRNs: ${monitor.all.join(', ')}\nPolling every ${CHECK_INTERVAL / 1000}s.`,
            email);
        monitor.confirmationSent = true;
    }

    browser = await puppeteer.launch(buildLaunchOpts());
    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36'
    );
    await page.setDefaultNavigationTimeout(45_000);

    const cleanup = async () => { if (browser) await browser.close(); process.exit(0); };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    while (monitor.size) {
        if (!(await checkMiamiConnection())) {
            console.error('✖ Not on MU network – retrying in 60 s');
            await sleep(60_000);
            continue;
        }

        await withRetry(() => page.goto(MIAMI_COURSE_URL, { waitUntil: 'networkidle0' }));
        await pollOnce(email, transporter, page);

        if (monitor.size) await sleep(CHECK_INTERVAL);
    }

    console.log('✔ All monitored CRNs have seats – done.');
    await cleanup();
}

/* ------------------------------------------------------------------
 * CLI
 * ----------------------------------------------------------------*/
(async () => {
    try {
        console.clear();
        console.log('\n=== MU Course Seat Finder ===');

        const email = PROMPT('Miami email (uniqueid@miamioh.edu): ').trim();
        if (!email.endsWith(MIAMI_EMAIL_DOMAIN)) throw new Error('Invalid Miami email.');

        const year = PROMPT('Course school year (e.g., 2026 for fall 2025‑2026): ').trim();
        const termChoice = PROMPT('Course term (1:Fall 2:Winter 3:Spring 4:Summer): ').trim();
        const termMap = { 1: '10', 2: '15', 3: '20', 4: '30' };
        if (!termMap[termChoice]) throw new Error('Invalid term choice.');
        termCode = `${year}${termMap[termChoice]}`;
        if (!/^\d{6}$/.test(termCode)) throw new Error('Term code must be 6 digits.');

        while (true) {
            const crn = PROMPT('Enter CRN (or press Enter to start): ').trim();
            if (!crn) {
                if (monitor.size) break;
                console.log('Add at least one CRN.');
                continue;
            }
            if (!/^[0-9]{5}$/.test(crn)) {
                console.log('CRN must be exactly 5 digits.');
                continue;
            }
            monitor.add(crn);
            console.log(`Added CRN ${crn}.`);
        }

        if (!(await checkMiamiConnection())) throw new Error('Not connected to Miami network/VPN.');

        await seatFinder(email);
    } catch (e) {
        console.error('Fatal:', e.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
